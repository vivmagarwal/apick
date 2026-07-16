import type { Hono } from 'hono';
import { sql, type HonoEnv } from '@apick/core';
import { CMS_USERS_KEY } from '../content.js';
import type { CmsContext } from '../context.js';
import { requireCtx } from '../context.js';
import { hashPassword, validatePasswordStrength } from './passwords.js';
import { findUserById } from './routes.js';

/**
 * User management under /admin/api/users — admin-only. Passwords are hashed
 * HERE (server-side scrypt); the raw password never touches the content API.
 * Writes go through core's REST API with the internal service key so
 * validation/uniqueness/audit all apply.
 */

interface UserRow {
  doc_id: string;
  created_at: Date;
  draft_data: { email: string; name: string; role: string };
}

async function listUsers(ctx: CmsContext): Promise<UserRow[]> {
  const { rows } = await ctx.db.query<UserRow>(sql`
    select doc_id, created_at, draft_data from apick_docs
    where tenant_id = ${ctx.tenantId} and collection = ${CMS_USERS_KEY}
    order by created_at
  `);
  return rows;
}

async function currentCmsUser(ctx: CmsContext, principalId: string | null): Promise<{ docId: string; role: string } | null> {
  if (!principalId) return null;
  const { rows } = await ctx.db.query<{ external_id: string | null }>(sql`
    select external_id from apick_principals where id = ${principalId}
  `);
  const externalId = rows[0]?.external_id;
  if (!externalId?.startsWith('cms:')) return null;
  const user = await findUserById(ctx, externalId.slice(4));
  return user ? { docId: user.doc_id, role: user.draft_data.role } : null;
}

const err = (code: string, message: string, status: number) =>
  Response.json({ error: { code, message, details: null } }, { status });

export function usersRoutes(app: Hono<HonoEnv>, box: { ctx: CmsContext | null }): void {
  const requireAdmin = async (c: { get: (k: 'access') => { principalId: string | null } }): Promise<CmsContext | Response> => {
    const ctx = requireCtx(box);
    const me = await currentCmsUser(ctx, c.get('access').principalId);
    if (!me) return err('unauthorized', 'Sign in required', 401);
    if (me.role !== 'admin') return err('forbidden', 'Admin role required', 403);
    return ctx;
  };

  app.get('/admin/api/users', async (c) => {
    const ctx = await requireAdmin(c);
    if (ctx instanceof Response) return ctx;
    const users = await listUsers(ctx);
    return c.json({
      data: users.map((u) => ({
        docId: u.doc_id,
        email: u.draft_data.email,
        name: u.draft_data.name,
        role: u.draft_data.role,
        createdAt: u.created_at.toISOString(),
      })),
    });
  });

  app.post('/admin/api/users', async (c) => {
    const ctx = await requireAdmin(c);
    if (ctx instanceof Response) return ctx;
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const password = typeof body['password'] === 'string' ? body['password'] : '';
    const weak = validatePasswordStrength(password);
    if (weak) return err('validation', weak, 422);
    const res = await ctx.fetchApi(`/v1/collections/${CMS_USERS_KEY}/docs`, {
      method: 'POST',
      token: ctx.internalToken,
      body: JSON.stringify({
        data: {
          email: typeof body['email'] === 'string' ? body['email'].toLowerCase().trim() : '',
          name: body['name'],
          role: body['role'],
          passwordHash: hashPassword(password),
        },
      }),
    });
    return new Response(res.body, res);
  });

  app.patch('/admin/api/users/:docId', async (c) => {
    const ctx = await requireAdmin(c);
    if (ctx instanceof Response) return ctx;
    const docId = c.req.param('docId');
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const target = await findUserById(ctx, docId);
    if (!target) return err('not_found', 'User not found', 404);

    const patchBody: Record<string, unknown> = {};
    if (typeof body['name'] === 'string') patchBody['name'] = body['name'];
    if (typeof body['email'] === 'string') patchBody['email'] = body['email'].toLowerCase().trim();
    if (typeof body['role'] === 'string') {
      // never demote the last admin
      if (target.draft_data.role === 'admin' && body['role'] !== 'admin') {
        const admins = (await listUsers(ctx)).filter((u) => u.draft_data.role === 'admin');
        if (admins.length <= 1) return err('conflict', 'Cannot demote the last admin', 409);
      }
      patchBody['role'] = body['role'];
    }
    if (typeof body['password'] === 'string' && body['password'] !== '') {
      const weak = validatePasswordStrength(body['password']);
      if (weak) return err('validation', weak, 422);
      patchBody['passwordHash'] = hashPassword(body['password']); // invalidates their sessions
    }
    const res = await ctx.fetchApi(`/v1/collections/${CMS_USERS_KEY}/docs/${docId}`, {
      method: 'PATCH',
      token: ctx.internalToken,
      body: JSON.stringify({ patch: patchBody }),
    });
    return new Response(res.body, res);
  });

  app.delete('/admin/api/users/:docId', async (c) => {
    const ctx = await requireAdmin(c);
    if (ctx instanceof Response) return ctx;
    const docId = c.req.param('docId');
    const me = await currentCmsUser(ctx, c.get('access').principalId);
    if (me?.docId === docId) return err('conflict', 'You cannot delete your own account', 409);
    const target = await findUserById(ctx, docId);
    if (!target) return err('not_found', 'User not found', 404);
    if (target.draft_data.role === 'admin') {
      const admins = (await listUsers(ctx)).filter((u) => u.draft_data.role === 'admin');
      if (admins.length <= 1) return err('conflict', 'Cannot delete the last admin', 409);
    }
    const res = await ctx.fetchApi(`/v1/collections/${CMS_USERS_KEY}/docs/${docId}`, {
      method: 'DELETE',
      token: ctx.internalToken,
    });
    return new Response(res.body, res);
  });
}
