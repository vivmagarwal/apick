import { Hono } from 'hono';
import { errors } from '../kernel/errors.js';
import { can } from '../auth/rbac.js';
import { executeSavedQuery } from '../query/saved.js';
import { listDocs } from '../query/plan.js';
import type { HonoEnv } from './app.js';
import { buildLlmsFullTxt, buildLlmsTxt } from './llms.js';
import { buildOpenApi } from './openapi.js';

export function metaRoutes(options: { rootIndex: boolean }): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  // When the consumer claims "/" (e.g. @apick/cms renders the site there),
  // the index route must not exist at all — a registered handler would win
  // over later extend() routes even when it 404s.
  if (options.rootIndex)
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
      .map((col) => ({
        key: col.key,
        description: col.description ?? null,
        publicRead: col.access.publicRead,
        admin: col.admin ?? {},
      }));
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
    // Inverse relations: who points AT this collection — what a document-centric
    // UI needs to show "everything attached to this page" (only collections the
    // caller may read; private fields never appear in compiled.relations).
    const referencedBy = core.registry
      .list()
      .filter((other) => can(ctx, 'read', `doc:${other.key}`) || can(ctx, 'readDraft', `doc:${other.key}`))
      .flatMap((other) =>
        other.compiled.relations
          .filter((rel) => rel.to === col.key)
          .map((rel) => ({ collection: other.key, field: rel.path, many: rel.many ?? false, admin: other.admin ?? {} })),
      );
    return c.json({
      data: {
        key: col.key,
        description: col.description ?? null,
        admin: col.admin ?? {},
        referencedBy,
        readSchema: col.compiled.readSchema,
        // Writers also get the raw field definitions (types, relations, blocks
        // variants, constraints) — this is what schema-driven UIs consume.
        ...(writable ? { writeSchema: col.compiled.writeSchema, fields: col.compiled.fields } : {}),
      },
    });
  });

  // Cross-collection full-text search: ranked websearch over every collection
  // the caller may read (or the requested subset). Authorization, tenancy and
  // field rules are the planner's — this endpoint only fans out.
  app.get('/v1/search', async (c) => {
    const core = c.get('core');
    const ctx = c.get('access');
    const q = (c.req.query('q') ?? '').trim();
    if (q.length < 2) throw errors.badRequest('q needs at least 2 characters');
    const status = c.req.query('status') === 'draft' ? ('draft' as const) : ('published' as const);
    const pageSize = Math.min(Math.max(Number.parseInt(c.req.query('pageSize') ?? '10', 10) || 10, 1), 25);
    const requested = (c.req.query('collections') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const candidates = core.registry
      .list()
      .filter((col) => (requested.length === 0 ? true : requested.includes(col.key)))
      .filter((col) => can(ctx, status === 'draft' ? 'readDraft' : 'read', `doc:${col.key}`));
    const groups = await Promise.all(
      candidates.map(async (col) => {
        try {
          const result = await listDocs(core.db, core.registry, ctx, col.key, { search: q, status, pageSize });
          return { collection: col.key, admin: col.admin ?? {}, hits: result.data };
        } catch {
          return null; // no searchable fields, or per-collection authz said no
        }
      }),
    );
    const data = groups.filter((g) => g !== null && g.hits.length > 0);
    return c.json({ data, meta: { q, status } });
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
