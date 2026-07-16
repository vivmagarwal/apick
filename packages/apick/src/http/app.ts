import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { SpanStatusCode } from '@opentelemetry/api';
import { ApickError, errors } from '../kernel/errors.js';
import { appendEvent } from '../kernel/events.js';
import { uuidv7 } from '../kernel/ids.js';
import { sql } from '../kernel/sql.js';
import { metricsBundle, tracer } from '../kernel/telemetry.js';
import { resolveAccess, resolveTenantBySlugOrId, type AccessContext, type TenantRow } from '../auth/rbac.js';
import type { AppCore } from '../app/core.js';
import { docRoutes } from './docs.js';
import { systemRoutes } from './system.js';
import { metaRoutes } from './meta.js';
import { mcpRoutes } from '../mcp/index.js';

export type HonoEnv = {
  Variables: {
    access: AccessContext;
    core: AppCore;
    requestId: string;
  };
};

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

async function resolveTenantCached(core: AppCore, ref: string): Promise<TenantRow | null> {
  const cached = core.caches.tenants.get(ref) as TenantRow | undefined;
  if (cached) return cached;
  const tenant = await resolveTenantBySlugOrId(core.db, ref);
  if (tenant) core.caches.tenants.set(ref, tenant);
  return tenant;
}

export function buildHttpApp(core: AppCore): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  app.onError((err, c) => {
    const apickErr = ApickError.wrap(err);
    if (apickErr.code === 'internal') {
      core.log.error('request failed', {
        path: c.req.path,
        requestId: c.get('requestId'),
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
    }
    return c.json(apickErr.toBody(), apickErr.status as 400);
  });
  app.notFound((c) => c.json(errors.notFound(`No route: ${c.req.method} ${c.req.path}`).toBody(), 404));

  // CORS: safe to default-open because auth is bearer-token based (no cookies,
  // so no CSRF surface); restrict origins or disable via config.
  if (core.config.cors !== false) {
    const { origins, maxAge } = core.config.cors;
    app.use(
      '*',
      cors({
        origin: origins === '*' ? '*' : origins,
        allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
        allowHeaders: ['authorization', 'content-type', 'x-apick-tenant', 'x-request-id', 'mcp-protocol-version'],
        exposeHeaders: ['x-request-id'],
        maxAge,
      }),
    );
  }

  // Request id: propagate the caller's (sanitized) or mint a uuid7.
  app.use('*', async (c, next) => {
    const incoming = c.req.header('x-request-id');
    const requestId = incoming && REQUEST_ID_RE.test(incoming) ? incoming : uuidv7();
    c.set('requestId', requestId);
    c.header('x-request-id', requestId);
    await next();
  });

  // Liveness (no dependencies) and readiness (database reachable + migrated).
  app.get('/health', (c) => c.json({ ok: true, name: 'apick', version: core.version }));
  app.get('/health/ready', async (c) => {
    try {
      await core.db.query(sql`select 1`);
      return c.json({ ready: true });
    } catch (err) {
      return c.json({ ready: false, error: String(err) }, 503);
    }
  });

  // Everything else resolves an access context (anonymous allowed; guards downstream).
  app.use('*', async (c, next) => {
    c.set('core', core);
    if (Number(c.req.header('content-length') ?? 0) > core.config.maxBodyBytes) {
      throw errors.badRequest(`Request body too large (max ${core.config.maxBodyBytes} bytes)`);
    }

    // Tenant resolution: explicit header > resolveTenant hook > default tenant.
    let tenantRef = c.req.header('x-apick-tenant') ?? null;
    if (!tenantRef && core.config.resolveTenant) {
      tenantRef = await core.config.resolveTenant(c.req.raw);
    }
    let tenant = core.defaultTenant;
    if (tenantRef && tenantRef !== core.defaultTenant.slug && tenantRef !== core.defaultTenant.id) {
      const resolved = await resolveTenantCached(core, tenantRef);
      if (!resolved) throw errors.notFound(`Unknown tenant "${tenantRef}"`);
      tenant = resolved;
    }
    if (tenant.status !== 'active') throw errors.forbidden(`Tenant "${tenant.slug}" is ${tenant.status}`);

    const auth = c.req.header('authorization');
    const token = auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null;
    const via = c.req.path === '/mcp' || c.req.path.startsWith('/mcp/') ? 'mcp' : 'api';
    const ctx = await resolveAccess(core.db, {
      token,
      tenantId: tenant.id,
      via,
      caches: core.caches,
      verifyToken: core.config.verifyToken,
      request: c.req.raw,
    });
    c.set('access', ctx);

    const started = Date.now();
    const span = tracer.startSpan('apick.http.request', {
      attributes: { 'http.request.method': c.req.method, 'url.path': c.req.path, 'apick.tenant': tenant.slug },
    });
    try {
      await next();
    } finally {
      const latencyMs = Date.now() - started;
      span.setAttribute('http.response.status_code', c.res.status);
      span.setStatus({ code: c.res.status < 500 ? SpanStatusCode.OK : SpanStatusCode.ERROR });
      span.end();
      metricsBundle.httpDuration.record(latencyMs, {
        'http.request.method': c.req.method,
        'http.response.status_code': c.res.status,
      });

      // Interaction logging (AI-first: the interaction record IS the observability
      // surface). Fire-and-forget, off the hot path; bodies are never logged here —
      // doc events already carry redacted payloads.
      const mode = core.config.interactionLog;
      const isRead = c.req.method === 'GET' || c.req.method === 'HEAD';
      // /mcp logs its own tool-level interaction events with better granularity.
      if (!(mode === 'off' || (mode === 'mutations' && isRead) || c.req.path === '/health' || via === 'mcp')) {
        appendEvent(core.db, {
          tenantId: ctx.tenantId,
          type: 'http.request',
          actor: { principalId: ctx.principalId, via: 'api', ...(ctx.keyId ? { keyId: ctx.keyId } : {}) },
          subject: { method: c.req.method, path: c.req.path },
          payload: { status: c.res.status, latencyMs, requestId: c.get('requestId') },
        }).catch((err) => core.log.warn('interaction log failed', { error: String(err) }));
      }
    }
  });

  app.route('/v1/collections', docRoutes());
  app.route('/v1', systemRoutes());
  app.route('/', metaRoutes());
  app.route('/mcp', mcpRoutes());

  return app;
}
