import { Hono } from 'hono';
import { errors } from '../kernel/errors.js';
import { can } from '../auth/rbac.js';
import { executeSavedQuery } from '../query/saved.js';
import type { HonoEnv } from './app.js';
import { buildLlmsFullTxt, buildLlmsTxt } from './llms.js';
import { buildOpenApi } from './openapi.js';

export function metaRoutes(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  app.get('/', (c) => {
    const core = c.get('core');
    return c.json({
      name: 'apick',
      version: core.version,
      docs: { openapi: '/openapi.json', llms: '/llms.txt', llmsFull: '/llms-full.txt' },
      mcp: '/mcp',
      health: '/health',
    });
  });

  app.get('/openapi.json', (c) => c.json(buildOpenApi(c.get('core'))));
  app.get('/llms.txt', (c) => c.text(buildLlmsTxt(c.get('core'))));
  app.get('/llms-full.txt', (c) => c.text(buildLlmsFullTxt(c.get('core'))));

  // Collection introspection: visible if the caller can read (or readDraft) it.
  app.get('/v1/collections', (c) => {
    const core = c.get('core');
    const ctx = c.get('access');
    const data = core.registry
      .list()
      .filter((col) => can(ctx, 'read', `doc:${col.key}`) || can(ctx, 'readDraft', `doc:${col.key}`))
      .map((col) => ({ key: col.key, description: col.description ?? null, publicRead: col.access.publicRead }));
    return c.json({ data });
  });

  app.get('/v1/collections/:key/schema', (c) => {
    const core = c.get('core');
    const ctx = c.get('access');
    const col = core.registry.get(c.req.param('key'));
    if (!can(ctx, 'read', `doc:${col.key}`) && !can(ctx, 'readDraft', `doc:${col.key}`)) {
      throw errors.notFound(`Unknown collection "${col.key}"`);
    }
    const writable = can(ctx, 'create', `doc:${col.key}`) || can(ctx, 'update', `doc:${col.key}`);
    return c.json({
      data: {
        key: col.key,
        description: col.description ?? null,
        readSchema: col.compiled.readSchema,
        ...(writable ? { writeSchema: col.compiled.writeSchema } : {}),
      },
    });
  });

  // Saved queries
  app.get('/v1/queries', (c) => {
    const core = c.get('core');
    const ctx = c.get('access');
    const data = [...core.queries.values()]
      .filter((q) => can(ctx, q.status === 'draft' ? 'readDraft' : 'read', `doc:${q.collection}`))
      .map((q) => ({ key: q.key, collection: q.collection, description: q.description ?? null, params: q.params ?? {} }));
    return c.json({ data });
  });

  app.get('/v1/queries/:key', async (c) => {
    const core = c.get('core');
    const ctx = c.get('access');
    const query = core.queries.get(c.req.param('key'));
    if (!query) throw errors.notFound(`Unknown query "${c.req.param('key')}"`);
    const q = c.req.query();
    const paging: { page?: number; pageSize?: number; count?: boolean; locale?: string } = {};
    if (q['page']) paging.page = Number.parseInt(q['page'], 10);
    if (q['pageSize']) paging.pageSize = Number.parseInt(q['pageSize'], 10);
    if (q['count'] === 'true') paging.count = true;
    if (q['locale']) paging.locale = q['locale'];
    const result = await executeSavedQuery(core.db, core.registry, ctx, query, q, paging);
    return c.json(result);
  });

  return app;
}
