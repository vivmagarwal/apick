import { Hono } from 'hono';
import { errors } from '../kernel/errors.js';
import { readEvents } from '../kernel/events.js';
import { replayJob } from '../kernel/jobs.js';
import { sql } from '../kernel/sql.js';
import {
  assertCan,
  createApiKey,
  createPrincipal,
  createRole,
  createTenant,
  grantRole,
  resolveTenantBySlugOrId,
  revokeApiKey,
  type AccessContext,
  type PermissionRule,
} from '../auth/rbac.js';
import { storeContextFor } from '../app/core.js';
import { createDoc, patchDoc, publishDoc, type DocRow } from '../content/store.js';
import { createWebhook, replayDelivery, type DeliveryRow, type WebhookRow } from '../webhooks/index.js';
import type { HonoEnv } from './app.js';

function requireOperator(ctx: AccessContext): void {
  if (ctx.principalId === null) throw errors.unauthorized();
  if (!ctx.isOperator) throw errors.forbidden('Operator scope required');
}

async function jsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw errors.badRequest('Request body must be valid JSON');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw errors.badRequest('Request body must be a JSON object');
  return body as Record<string, unknown>;
}

function str(body: Record<string, unknown>, key: string, required = true): string {
  const v = body[key];
  if (typeof v === 'string' && v.length > 0) return v;
  if (!required) return '';
  throw errors.badRequest(`Body field "${key}" (string) is required`);
}

export function systemRoutes(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  // ---- tenants (operator only) ------------------------------------------------
  app.get('/tenants', async (c) => {
    const { db } = c.get('core');
    const ctx = c.get('access');
    requireOperator(ctx);
    assertCan(ctx, 'manage', 'system:tenants');
    const { rows } = await db.query(sql`select id, slug, name, status, settings, created_at from apick_tenants order by created_at`);
    return c.json({ data: rows });
  });

  app.post('/tenants', async (c) => {
    const { db } = c.get('core');
    const ctx = c.get('access');
    requireOperator(ctx);
    assertCan(ctx, 'manage', 'system:tenants');
    const body = await jsonBody(c);
    const tenant = await createTenant(db, {
      slug: str(body, 'slug'),
      name: str(body, 'name'),
      ...(body['settings'] && typeof body['settings'] === 'object' ? { settings: body['settings'] as Record<string, unknown> } : {}),
    });
    return c.json({ data: tenant }, 201);
  });

  app.patch('/tenants/:ref', async (c) => {
    const { db } = c.get('core');
    const ctx = c.get('access');
    requireOperator(ctx);
    assertCan(ctx, 'manage', 'system:tenants');
    const tenant = await resolveTenantBySlugOrId(db, c.req.param('ref'));
    if (!tenant) throw errors.notFound('Tenant not found');
    const body = await jsonBody(c);
    const name = typeof body['name'] === 'string' ? body['name'] : tenant.name;
    const status = typeof body['status'] === 'string' ? body['status'] : tenant.status;
    if (!['active', 'suspended'].includes(status)) throw errors.badRequest('status must be active|suspended');
    const settings = body['settings'] && typeof body['settings'] === 'object' ? (body['settings'] as Record<string, unknown>) : tenant.settings;
    const { rows } = await db.query(sql`
      update apick_tenants set name = ${name}, status = ${status}, settings = ${JSON.stringify(settings)}, updated_at = now()
      where id = ${tenant.id}
      returning id, slug, name, status, settings
    `);
    return c.json({ data: rows[0] });
  });

  // ---- principals & keys --------------------------------------------------------
  app.post('/principals', async (c) => {
    const { db } = c.get('core');
    const ctx = c.get('access');
    assertCan(ctx, 'manage', 'system:principals');
    const body = await jsonBody(c);
    const kind = str(body, 'kind');
    if (!['user', 'service', 'agent'].includes(kind)) throw errors.badRequest('kind must be user|service|agent');
    const principal = await createPrincipal(db, {
      kind: kind as 'user' | 'service' | 'agent',
      name: str(body, 'name'),
      ...(typeof body['email'] === 'string' ? { email: body['email'] } : {}),
    });
    return c.json({ data: principal }, 201);
  });

  /**
   * Create an API key. Two modes:
   * - { role, name }: creates a service principal, grants `role` in the CURRENT
   *   tenant, mints a key — the safe path for tenant admins.
   * - { principalId }: mints a key for an existing principal — operator only
   *   (a tenant admin must not be able to mint keys for e.g. the root principal).
   */
  app.post('/keys', async (c) => {
    const { db } = c.get('core');
    const ctx = c.get('access');
    assertCan(ctx, 'manage', 'system:keys');
    const body = await jsonBody(c);

    let principalId: string;
    if (typeof body['principalId'] === 'string') {
      requireOperator(ctx);
      principalId = body['principalId'];
    } else {
      const roleKey = str(body, 'role');
      const name = str(body, 'name');
      const scope = body['scope'];
      const tenantId = scope === 'operator' ? null : ctx.tenantId;
      if (scope === 'operator') requireOperator(ctx);
      const principal = await createPrincipal(db, { kind: 'service', name });
      await grantRole(db, { principalId: principal.id, roleKey, tenantId });
      principalId = principal.id;
    }

    const key = await createApiKey(db, {
      principalId,
      ...(typeof body['label'] === 'string' ? { label: body['label'] } : {}),
      ...(typeof body['expiresAt'] === 'string' ? { expiresAt: new Date(body['expiresAt']) } : {}),
    });
    return c.json({ data: { id: key.id, token: key.token, prefix: key.prefix, principalId } }, 201);
  });

  app.get('/keys', async (c) => {
    const { db } = c.get('core');
    const ctx = c.get('access');
    assertCan(ctx, 'manage', 'system:keys');
    const scoped = ctx.isOperator
      ? sql.raw('true')
      : sql`k.principal_id in (select principal_id from apick_role_grants where tenant_id = ${ctx.tenantId})`;
    const { rows } = await db.query(sql`
      select k.id, k.prefix, k.label, k.principal_id, k.created_at, k.expires_at, k.revoked_at, k.last_used_at, p.name as principal_name
      from apick_api_keys k join apick_principals p on p.id = k.principal_id
      where ${scoped}
      order by k.created_at desc
    `);
    return c.json({ data: rows });
  });

  app.delete('/keys/:id', async (c) => {
    const { db } = c.get('core');
    const ctx = c.get('access');
    assertCan(ctx, 'manage', 'system:keys');
    if (!ctx.isOperator) {
      // Tenant admins may revoke only keys of principals scoped ENTIRELY to their tenant.
      const { rows } = await db.query(sql`
        select 1 from apick_api_keys k
        where k.id = ${c.req.param('id')}
          and exists (select 1 from apick_role_grants g where g.principal_id = k.principal_id and g.tenant_id = ${ctx.tenantId})
          and not exists (select 1 from apick_role_grants g where g.principal_id = k.principal_id and g.tenant_id is distinct from ${ctx.tenantId})
      `);
      if (rows.length === 0) throw errors.forbidden('Key is outside your tenant scope');
    }
    const ok = await revokeApiKey(db, c.req.param('id'));
    if (!ok) throw errors.notFound('Key not found or already revoked');
    return c.json({ data: { revoked: true } });
  });

  // ---- roles & grants ---------------------------------------------------------------
  app.get('/roles', async (c) => {
    const { db } = c.get('core');
    const ctx = c.get('access');
    assertCan(ctx, 'manage', 'system:roles');
    const { rows } = await db.query(sql`
      select r.id, r.key, r.name, r.builtin, r.tenant_id,
             coalesce(json_agg(json_build_object('action', p.action, 'resource', p.resource, 'fields', p.fields, 'condition', p.condition))
                      filter (where p.id is not null), '[]') as permissions
      from apick_roles r left join apick_permissions p on p.role_id = r.id
      where r.tenant_id is null or r.tenant_id = ${ctx.tenantId}
      group by r.id order by r.builtin desc, r.key
    `);
    return c.json({ data: rows });
  });

  app.post('/roles', async (c) => {
    const { db } = c.get('core');
    const ctx = c.get('access');
    assertCan(ctx, 'manage', 'system:roles');
    const body = await jsonBody(c);
    const scope = body['scope'];
    if (scope === 'operator') requireOperator(ctx);
    if (!Array.isArray(body['permissions'])) throw errors.badRequest('Body field "permissions" (array) is required');
    const permissions: PermissionRule[] = (body['permissions'] as unknown[]).map((raw) => {
      if (raw === null || typeof raw !== 'object') throw errors.badRequest('Each permission must be an object');
      const p = raw as Record<string, unknown>;
      if (typeof p['action'] !== 'string' || typeof p['resource'] !== 'string') {
        throw errors.badRequest('Each permission needs "action" and "resource" strings');
      }
      return {
        action: p['action'],
        resource: p['resource'],
        fields: Array.isArray(p['fields']) ? (p['fields'] as string[]) : null,
        condition: p['condition'] && typeof p['condition'] === 'object' ? (p['condition'] as Record<string, unknown>) : null,
      };
    });
    const role = await createRole(db, {
      key: str(body, 'key'),
      name: str(body, 'name'),
      tenantId: scope === 'operator' ? null : ctx.tenantId,
      permissions,
    });
    return c.json({ data: role }, 201);
  });

  app.post('/grants', async (c) => {
    const { db } = c.get('core');
    const ctx = c.get('access');
    assertCan(ctx, 'manage', 'system:keys');
    const body = await jsonBody(c);
    const scope = body['scope'];
    if (scope === 'operator') requireOperator(ctx);
    await grantRole(db, {
      principalId: str(body, 'principalId'),
      roleKey: str(body, 'roleKey'),
      tenantId: scope === 'operator' ? null : ctx.tenantId,
    });
    return c.json({ data: { granted: true } }, 201);
  });

  // ---- webhooks -------------------------------------------------------------------------
  app.get('/webhooks', async (c) => {
    const { db } = c.get('core');
    const ctx = c.get('access');
    assertCan(ctx, 'manage', 'system:webhooks');
    const { rows } = await db.query<WebhookRow>(sql`
      select id, tenant_id, name, url, events, headers, enabled, created_at from apick_webhooks
      where tenant_id = ${ctx.tenantId} order by created_at
    `);
    return c.json({ data: rows });
  });

  app.post('/webhooks', async (c) => {
    const { db } = c.get('core');
    const ctx = c.get('access');
    assertCan(ctx, 'manage', 'system:webhooks');
    const body = await jsonBody(c);
    const hook = await createWebhook(db, {
      tenantId: ctx.tenantId,
      name: str(body, 'name'),
      url: str(body, 'url'),
      ...(Array.isArray(body['events']) ? { events: body['events'] as string[] } : {}),
      ...(body['headers'] && typeof body['headers'] === 'object' ? { headers: body['headers'] as Record<string, string> } : {}),
    });
    // secret is returned once at creation
    return c.json({ data: hook }, 201);
  });

  app.patch('/webhooks/:id', async (c) => {
    const { db } = c.get('core');
    const ctx = c.get('access');
    assertCan(ctx, 'manage', 'system:webhooks');
    const body = await jsonBody(c);
    const { rows: existing } = await db.query<WebhookRow>(sql`
      select * from apick_webhooks where id = ${c.req.param('id')} and tenant_id = ${ctx.tenantId}
    `);
    const hook = existing[0];
    if (!hook) throw errors.notFound('Webhook not found');
    const url = typeof body['url'] === 'string' ? body['url'] : hook.url;
    const name = typeof body['name'] === 'string' ? body['name'] : hook.name;
    const enabled = typeof body['enabled'] === 'boolean' ? body['enabled'] : hook.enabled;
    const events = Array.isArray(body['events']) ? (body['events'] as string[]) : hook.events;
    const { rows } = await db.query(sql`
      update apick_webhooks set url = ${url}, name = ${name}, enabled = ${enabled}, events = ${JSON.stringify(events)}
      where id = ${hook.id}
      returning id, tenant_id, name, url, events, headers, enabled, created_at
    `);
    return c.json({ data: rows[0] });
  });

  app.delete('/webhooks/:id', async (c) => {
    const { db } = c.get('core');
    const ctx = c.get('access');
    assertCan(ctx, 'manage', 'system:webhooks');
    const { rows } = await db.query(sql`
      delete from apick_webhooks where id = ${c.req.param('id')} and tenant_id = ${ctx.tenantId} returning id
    `);
    if (rows.length === 0) throw errors.notFound('Webhook not found');
    return c.json({ data: { deleted: true } });
  });

  app.get('/webhooks/:id/deliveries', async (c) => {
    const { db } = c.get('core');
    const ctx = c.get('access');
    assertCan(ctx, 'manage', 'system:webhooks');
    const state = c.req.query('state');
    const conds = [sql`webhook_id = ${c.req.param('id')}`, sql`tenant_id = ${ctx.tenantId}`];
    if (state) conds.push(sql`state = ${state}`);
    const { rows } = await db.query<DeliveryRow>(sql`
      select * from apick_deliveries where ${sql.join(conds, ' and ')} order by created_at desc limit 200
    `);
    return c.json({ data: rows });
  });

  app.post('/deliveries/:id/replay', async (c) => {
    const { db } = c.get('core');
    const ctx = c.get('access');
    assertCan(ctx, 'manage', 'system:webhooks');
    const ok = await replayDelivery(db, ctx.tenantId, c.req.param('id'));
    if (!ok) throw errors.notFound('Delivery not found or not dead');
    return c.json({ data: { replayed: true } });
  });

  // ---- events (audit / change feed cursor) ---------------------------------------------------
  app.get('/events', async (c) => {
    const { db } = c.get('core');
    const ctx = c.get('access');
    assertCan(ctx, 'manage', 'system:events');
    const q = c.req.query();
    const events = await readEvents(db, {
      tenantId: q['scope'] === 'operator' && ctx.isOperator ? null : ctx.tenantId,
      ...(q['types'] ? { types: q['types'].split(',') } : {}),
      ...(q['afterSeq'] ? { afterSeq: q['afterSeq'] } : {}),
      ...(q['limit'] ? { limit: Number.parseInt(q['limit'], 10) } : {}),
    });
    return c.json({ data: events, meta: { cursor: events.length > 0 ? events[events.length - 1]!.seq : (q['afterSeq'] ?? '0') } });
  });

  // ---- jobs (dead-letter visibility + replay) -------------------------------------------------
  app.get('/jobs', async (c) => {
    const { db } = c.get('core');
    const ctx = c.get('access');
    assertCan(ctx, 'manage', 'system:jobs');
    const conds = [ctx.isOperator ? sql.raw('true') : sql`tenant_id = ${ctx.tenantId}`];
    const state = c.req.query('state');
    if (state) conds.push(sql`state = ${state}`);
    const { rows } = await db.query(sql`
      select id, tenant_id, queue, payload, state, run_at, attempts, max_attempts, last_error, created_at, finished_at
      from apick_jobs where ${sql.join(conds, ' and ')} order by created_at desc limit 200
    `);
    return c.json({ data: rows });
  });

  app.post('/jobs/:id/replay', async (c) => {
    const { db } = c.get('core');
    const ctx = c.get('access');
    assertCan(ctx, 'manage', 'system:jobs');
    if (!ctx.isOperator) {
      const { rows } = await db.query(sql`select 1 from apick_jobs where id = ${c.req.param('id')} and tenant_id = ${ctx.tenantId}`);
      if (rows.length === 0) throw errors.notFound('Job not found');
    }
    const ok = await replayJob(db, c.req.param('id'));
    if (!ok) throw errors.notFound('Job not found or not dead');
    return c.json({ data: { replayed: true } });
  });

  // ---- portability: export / import ------------------------------------------------------------
  app.get('/export', async (c) => {
    const core = c.get('core');
    const ctx = c.get('access');
    assertCan(ctx, 'manage', 'system:export');
    const only = c.req.query('collections')?.split(',').map((s) => s.trim()).filter(Boolean);
    const collections = core.registry.list().map((col) => col.key).filter((k) => !only || only.includes(k));
    const docs: unknown[] = [];
    for (const collection of collections) {
      const { rows } = await core.db.query<DocRow>(sql`
        select * from apick_docs where tenant_id = ${ctx.tenantId} and collection = ${collection} order by created_at
      `);
      for (const row of rows) {
        docs.push({
          collection,
          docId: row.doc_id,
          locale: row.locale,
          draft: { version: row.draft_version, data: row.draft_data },
          published: row.published_version ? { version: row.published_version, data: row.published_data } : null,
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
        });
      }
    }
    return c.json({ apickExport: 1, exportedAt: new Date().toISOString(), collections, docs });
  });

  app.post('/import', async (c) => {
    const core = c.get('core');
    const ctx = c.get('access');
    assertCan(ctx, 'manage', 'system:export');
    const body = await jsonBody(c);
    if (!Array.isArray(body['docs'])) throw errors.badRequest('Body must include "docs" array (an apick export)');
    const overwrite = body['mode'] === 'overwrite';
    const store = storeContextFor(ctx);
    let imported = 0;
    let skipped = 0;
    for (const raw of body['docs'] as Record<string, unknown>[]) {
      const collection = raw['collection'] as string;
      const col = core.registry.get(collection).compiled;
      const docId = raw['docId'] as string;
      const locale = (raw['locale'] as string) ?? core.config.defaultLocale;
      const draft = raw['draft'] as { data: Record<string, unknown> };
      const published = raw['published'] as { data: Record<string, unknown> } | null;

      const { rows: existing } = await core.db.query(sql`
        select 1 from apick_docs where tenant_id = ${ctx.tenantId} and collection = ${collection} and doc_id = ${docId} and locale = ${locale}
      `);
      if (existing.length > 0 && !overwrite) {
        skipped++;
        continue;
      }
      if (existing.length === 0) {
        // create with the published body first (if any), publish, then move draft forward
        await createDoc(core.db, col, store, {
          data: published ? published.data : draft.data,
          locale,
          docId,
          publish: !!published,
          validateRefs: false,
        });
        if (published && JSON.stringify(published.data) !== JSON.stringify(draft.data)) {
          await patchDoc(core.db, col, store, { docId, locale, patch: draft.data, validateRefs: false });
        }
      } else {
        if (published) {
          await patchDoc(core.db, col, store, { docId, locale, patch: published.data, validateRefs: false });
          await publishDoc(core.db, col, store, docId, locale);
        }
        if (!published || JSON.stringify(published.data) !== JSON.stringify(draft.data)) {
          await patchDoc(core.db, col, store, { docId, locale, patch: draft.data, validateRefs: false });
        }
      }
      imported++;
    }
    return c.json({ data: { imported, skipped } });
  });

  return app;
}
