import type { Hono } from 'hono';
import { sql, type HonoEnv } from '@apick/core';
import { CMS_USERS_KEY } from '../content.js';
import type { CmsContext } from '../context.js';
import { requireCtx } from '../context.js';
import { hashPassword, validatePasswordStrength, verifyPassword } from './passwords.js';
import { createRateLimiter, passwordVersion, signSession } from './session.js';

/**
 * CMS auth endpoints under /admin/api. Everything except password
 * verification goes through core's REST API (in-process, internal service
 * key) — passwordHash is a `private` field, so by the planner's guarantee it
 * can NEVER be read over the API; verification is a single trusted db read.
 */

interface CmsUserRow {
  doc_id: string;
  draft_data: { email: string; name: string; role: 'admin' | 'editor' | 'viewer'; passwordHash: string };
}

export async function findUserByEmail(ctx: CmsContext, email: string): Promise<CmsUserRow | null> {
  const { rows } = await ctx.db.query<CmsUserRow>(sql`
    select doc_id, draft_data from apick_docs
    where tenant_id = ${ctx.tenantId} and collection = ${CMS_USERS_KEY}
      and draft_data->>'email' = ${email.toLowerCase()}
    limit 1
  `);
  return rows[0] ?? null;
}

export async function findUserById(ctx: CmsContext, docId: string): Promise<CmsUserRow | null> {
  const { rows } = await ctx.db.query<CmsUserRow>(sql`
    select doc_id, draft_data from apick_docs
    where tenant_id = ${ctx.tenantId} and collection = ${CMS_USERS_KEY} and doc_id = ${docId}
    limit 1
  `);
  return rows[0] ?? null;
}

export async function countUsers(ctx: CmsContext): Promise<number> {
  const { rows } = await ctx.db.query<{ n: string }>(sql`
    select count(*)::text as n from apick_docs where tenant_id = ${ctx.tenantId} and collection = ${CMS_USERS_KEY}
  `);
  return Number(rows[0]?.n ?? 0);
}

function publicUser(row: CmsUserRow): { docId: string; email: string; name: string; role: string } {
  return { docId: row.doc_id, email: row.draft_data.email, name: row.draft_data.name, role: row.draft_data.role };
}

export function authRoutes(app: Hono<HonoEnv>, box: { ctx: CmsContext | null }): void {
  // Per-instance (not module-global): one CMS's login attempts must never
  // rate-limit another's — important when several createCms run in one process.
  const loginLimiter = createRateLimiter(5, 60_000);

  // Does this install need first-run setup? (public — the SPA routes on it)
  app.get('/admin/api/status', async (c) => {
    const ctx = requireCtx(box);
    return c.json({
      needsSetup: (await countUsers(ctx)) === 0,
      site: { title: ctx.site.title },
      adminNav: ctx.adminNav,
      version: ctx.core.version,
    });
  });

  // First-run: create the initial admin account. Only ever works once.
  app.post('/admin/api/setup', async (c) => {
    const ctx = requireCtx(box);
    if ((await countUsers(ctx)) > 0) {
      return c.json({ error: { code: 'forbidden', message: 'Setup already completed', details: null } }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const email = typeof body['email'] === 'string' ? body['email'].toLowerCase().trim() : '';
    const name = typeof body['name'] === 'string' ? body['name'].trim() : '';
    const password = typeof body['password'] === 'string' ? body['password'] : '';
    const weak = validatePasswordStrength(password);
    if (weak) return c.json({ error: { code: 'validation', message: weak, details: null } }, 422);

    // create through the API (validates email format, unique, etc.)
    const res = await ctx.fetchApi(`/v1/collections/${CMS_USERS_KEY}/docs`, {
      method: 'POST',
      token: ctx.internalToken,
      body: JSON.stringify({ data: { email, name, role: 'admin', passwordHash: hashPassword(password) } }),
    });
    if (!res.ok) return new Response(res.body, res);
    // race guard: if a concurrent setup slipped in, keep only the first
    if ((await countUsers(ctx)) > 1) {
      const created = (await res.json()) as { data: { docId: string } };
      await ctx.fetchApi(`/v1/collections/${CMS_USERS_KEY}/docs/${created.data.docId}`, {
        method: 'DELETE',
        token: ctx.internalToken,
      });
      return c.json({ error: { code: 'forbidden', message: 'Setup already completed', details: null } }, 403);
    }
    const user = await findUserByEmail(ctx, email);
    return c.json({ data: { token: issueToken(ctx, user!), user: publicUser(user!) } }, 201);
  });

  app.post('/admin/api/login', async (c) => {
    const ctx = requireCtx(box);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const email = typeof body['email'] === 'string' ? body['email'].toLowerCase().trim() : '';
    const password = typeof body['password'] === 'string' ? body['password'] : '';
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
    if (!loginLimiter(`${email}|${ip}`)) {
      return c.json({ error: { code: 'forbidden', message: 'Too many attempts — try again in a minute', details: null } }, 429);
    }
    const user = email ? await findUserByEmail(ctx, email) : null;
    // constant-shape failure: same message whether the email or password is wrong
    if (!user || !verifyPassword(password, user.draft_data.passwordHash)) {
      return c.json({ error: { code: 'unauthorized', message: 'Invalid email or password', details: null } }, 401);
    }
    return c.json({ data: { token: issueToken(ctx, user), user: publicUser(user) } });
  });

  // Who am I? (SPA session check — accepts the session bearer token.)
  app.get('/admin/api/me', async (c) => {
    const ctx = requireCtx(box);
    const access = c.get('access');
    // access resolved by core middleware via the CMS verifyToken hook; the
    // externalId convention is cms:<docId>
    if (!access.principalId) return c.json({ error: { code: 'unauthorized', message: 'Not signed in', details: null } }, 401);
    const { rows } = await ctx.db.query<{ external_id: string | null }>(sql`
      select external_id from apick_principals where id = ${access.principalId}
    `);
    const externalId = rows[0]?.external_id;
    if (!externalId?.startsWith('cms:')) {
      return c.json({ error: { code: 'unauthorized', message: 'Not a CMS session', details: null } }, 401);
    }
    const user = await findUserById(ctx, externalId.slice(4));
    if (!user) return c.json({ error: { code: 'unauthorized', message: 'User no longer exists', details: null } }, 401);
    return c.json({ data: publicUser(user) });
  });
}

export function issueToken(ctx: CmsContext, user: CmsUserRow): string {
  return signSession(ctx.secret, {
    sub: user.doc_id,
    exp: Date.now() + ctx.sessionTtlMs,
    pv: passwordVersion(user.draft_data.passwordHash),
  });
}
