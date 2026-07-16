import { Hono } from 'hono';
import { ApickError, errors } from '../kernel/errors.js';
import { appendEvent } from '../kernel/events.js';
import { resolveAccess, resolveTenantBySlugOrId, type AccessContext } from '../auth/rbac.js';
import type { AppCore } from '../app/core.js';
import { docRoutes } from './docs.js';
import { systemRoutes } from './system.js';
import { metaRoutes } from './meta.js';
import { mcpRoutes } from '../mcp/index.js';

export type HonoEnv = {
  Variables: {
    access: AccessContext;
    core: AppCore;
  };
};

const MAX_BODY_BYTES = 5 * 1024 * 1024;

export function buildHttpApp(core: AppCore): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  app.onError((err, c) => {
    const apickErr = ApickError.wrap(err);
    if (apickErr.code === 'internal') {
      core.log.error('request failed', { path: c.req.path, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    }
    return c.json(apickErr.toBody(), apickErr.status as 400);
  });
  app.notFound((c) => c.json(errors.notFound(`No route: ${c.req.method} ${c.req.path}`).toBody(), 404));

  // Public, unauthenticated surface.
  app.get('/health', (c) => c.json({ ok: true, name: 'apick', version: core.version }));

  // Everything else resolves an access context (anonymous allowed; guards downstream).
  app.use('*', async (c, next) => {
    c.set('core', core);
    if (Number(c.req.header('content-length') ?? 0) > MAX_BODY_BYTES) {
      throw errors.badRequest('Request body too large (max 5MB)');
    }

    // Tenant resolution: explicit header > resolveTenant hook > default tenant.
    let tenantRef = c.req.header('x-apick-tenant') ?? null;
    if (!tenantRef && core.config.resolveTenant) {
      tenantRef = await core.config.resolveTenant(c.req.raw);
    }
    let tenant = core.defaultTenant;
    if (tenantRef && tenantRef !== core.defaultTenant.slug && tenantRef !== core.defaultTenant.id) {
      const resolved = await resolveTenantBySlugOrId(core.db, tenantRef);
      if (!resolved) throw errors.notFound(`Unknown tenant "${tenantRef}"`);
      tenant = resolved;
    }
    if (tenant.status !== 'active') throw errors.forbidden(`Tenant "${tenant.slug}" is ${tenant.status}`);

    const auth = c.req.header('authorization');
    const token = auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null;
    const via = c.req.path === '/mcp' || c.req.path.startsWith('/mcp/') ? 'mcp' : 'api';
    const ctx = await resolveAccess(core.db, { token, tenantId: tenant.id, via });
    c.set('access', ctx);

    const started = Date.now();
    await next();

    // Interaction logging (AI-first: the interaction record IS the observability
    // surface). Fire-and-forget, off the hot path; bodies are never logged here —
    // doc events already carry redacted payloads.
    const mode = core.config.interactionLog;
    const isRead = c.req.method === 'GET' || c.req.method === 'HEAD';
    // /mcp logs its own tool-level interaction events with better granularity.
    if (mode === 'off' || (mode === 'mutations' && isRead) || c.req.path === '/health' || via === 'mcp') return;
    appendEvent(core.db, {
      tenantId: ctx.tenantId,
      type: 'http.request',
      actor: { principalId: ctx.principalId, via: 'api', ...(ctx.keyId ? { keyId: ctx.keyId } : {}) },
      subject: { method: c.req.method, path: c.req.path },
      payload: { status: c.res.status, latencyMs: Date.now() - started },
    }).catch((err) => core.log.warn('interaction log failed', { error: String(err) }));
  });

  app.route('/v1/collections', docRoutes());
  app.route('/v1', systemRoutes());
  app.route('/', metaRoutes());
  app.route('/mcp', mcpRoutes());

  return app;
}
