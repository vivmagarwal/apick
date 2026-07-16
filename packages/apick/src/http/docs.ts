import { Hono } from 'hono';
import { errors } from '../kernel/errors.js';
import { assertCan } from '../auth/rbac.js';
import { storeContextFor } from '../app/core.js';
import {
  createDoc,
  deleteDoc,
  getVersion,
  listVersions,
  patchDoc,
  publishDoc,
  restoreVersion,
  unpublishDoc,
} from '../content/store.js';
import { getDoc, listDocs, type ListParams } from '../query/plan.js';
import type { HonoEnv } from './app.js';

const LOCALE_RE = /^[a-zA-Z0-9_-]{1,35}$/;

export function parseListParams(query: Record<string, string | undefined>, defaultLocale: string): ListParams {
  const params: ListParams = {};
  if (query['filter'] !== undefined) {
    try {
      params.filter = JSON.parse(query['filter']);
    } catch {
      throw errors.badRequest('filter must be valid JSON');
    }
  }
  if (query['sort']) params.sort = query['sort'];
  if (query['page']) {
    const n = Number.parseInt(query['page'], 10);
    if (!Number.isInteger(n) || n < 1) throw errors.badRequest('page must be a positive integer');
    params.page = n;
  }
  if (query['pageSize']) {
    const n = Number.parseInt(query['pageSize'], 10);
    if (!Number.isInteger(n) || n < 1) throw errors.badRequest('pageSize must be a positive integer');
    params.pageSize = n;
  }
  if (query['status'] !== undefined) {
    if (query['status'] !== 'draft' && query['status'] !== 'published') {
      throw errors.badRequest('status must be "draft" or "published"');
    }
    params.status = query['status'];
  }
  params.locale = parseLocale(query['locale'], defaultLocale);
  if (query['populate']) params.populate = query['populate'].split(',').map((s) => s.trim()).filter(Boolean);
  if (query['fields']) params.fields = query['fields'].split(',').map((s) => s.trim()).filter(Boolean);
  if (query['count'] === 'true') params.count = true;
  return params;
}

export function parseLocale(raw: string | undefined, defaultLocale: string): string {
  if (raw === undefined || raw === '') return defaultLocale;
  if (!LOCALE_RE.test(raw)) throw errors.badRequest('Invalid locale');
  return raw;
}

async function jsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw errors.badRequest('Request body must be valid JSON');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw errors.badRequest('Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

export function docRoutes(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  // list documents
  app.get('/:collection/docs', async (c) => {
    const core = c.get('core');
    const ctx = c.get('access');
    const params = parseListParams(c.req.query(), core.config.defaultLocale);
    const result = await listDocs(core.db, core.registry, ctx, c.req.param('collection'), params);
    return c.json(result);
  });

  // create document
  app.post('/:collection/docs', async (c) => {
    const core = c.get('core');
    const ctx = c.get('access');
    const collection = c.req.param('collection');
    const col = core.registry.get(collection).compiled;
    assertCan(ctx, 'create', `doc:${collection}`);
    const body = await jsonBody(c);
    if (body['data'] === undefined || typeof body['data'] !== 'object' || body['data'] === null || Array.isArray(body['data'])) {
      throw errors.badRequest('Body must include a "data" object');
    }
    const publish = body['publish'] === true;
    if (publish) assertCan(ctx, 'publish', `doc:${collection}`);
    const doc = await createDoc(core.db, col, storeContextFor(ctx, core), {
      data: body['data'] as Record<string, unknown>,
      locale: parseLocale(body['locale'] as string | undefined, core.config.defaultLocale),
      ...(typeof body['docId'] === 'string' ? { docId: body['docId'] } : {}),
      publish,
    });
    return c.json({ data: doc }, 201);
  });

  // read one
  app.get('/:collection/docs/:docId', async (c) => {
    const core = c.get('core');
    const ctx = c.get('access');
    const q = c.req.query();
    const params = parseListParams(q, core.config.defaultLocale);
    const doc = await getDoc(core.db, core.registry, ctx, c.req.param('collection'), c.req.param('docId'), {
      ...(params.status !== undefined ? { status: params.status } : {}),
      ...(params.locale !== undefined ? { locale: params.locale } : {}),
      ...(params.populate !== undefined ? { populate: params.populate } : {}),
      ...(params.fields !== undefined ? { fields: params.fields } : {}),
    });
    if (!doc) throw errors.notFound('Document not found');
    return c.json({ data: doc });
  });

  // patch draft
  app.patch('/:collection/docs/:docId', async (c) => {
    const core = c.get('core');
    const ctx = c.get('access');
    const collection = c.req.param('collection');
    const col = core.registry.get(collection).compiled;
    assertCan(ctx, 'update', `doc:${collection}`);
    const body = await jsonBody(c);
    if (body['patch'] === undefined || typeof body['patch'] !== 'object' || body['patch'] === null || Array.isArray(body['patch'])) {
      throw errors.badRequest('Body must include a "patch" object (RFC 7386 merge patch)');
    }
    const doc = await patchDoc(core.db, col, storeContextFor(ctx, core), {
      docId: c.req.param('docId'),
      patch: body['patch'] as Record<string, unknown>,
      locale: parseLocale(body['locale'] as string | undefined, core.config.defaultLocale),
      ...(typeof body['ifVersion'] === 'number' ? { ifVersion: body['ifVersion'] } : {}),
      ...(body['upsertLocale'] === true ? { upsertLocale: true } : {}),
    });
    return c.json({ data: doc });
  });

  // delete
  app.delete('/:collection/docs/:docId', async (c) => {
    const core = c.get('core');
    const ctx = c.get('access');
    const collection = c.req.param('collection');
    const col = core.registry.get(collection).compiled;
    assertCan(ctx, 'delete', `doc:${collection}`);
    const locale = c.req.query('locale');
    const result = await deleteDoc(
      core.db,
      col,
      storeContextFor(ctx, core),
      c.req.param('docId'),
      locale ? parseLocale(locale, core.config.defaultLocale) : undefined,
    );
    return c.json({ data: result });
  });

  // publish / unpublish
  app.post('/:collection/docs/:docId/publish', async (c) => {
    const core = c.get('core');
    const ctx = c.get('access');
    const collection = c.req.param('collection');
    assertCan(ctx, 'publish', `doc:${collection}`);
    const col = core.registry.get(collection).compiled;
    const locale = parseLocale(c.req.query('locale'), core.config.defaultLocale);
    const doc = await publishDoc(core.db, col, storeContextFor(ctx, core), c.req.param('docId'), locale);
    return c.json({ data: doc });
  });

  app.post('/:collection/docs/:docId/unpublish', async (c) => {
    const core = c.get('core');
    const ctx = c.get('access');
    const collection = c.req.param('collection');
    assertCan(ctx, 'publish', `doc:${collection}`);
    const col = core.registry.get(collection).compiled;
    const locale = parseLocale(c.req.query('locale'), core.config.defaultLocale);
    const doc = await unpublishDoc(core.db, col, storeContextFor(ctx, core), c.req.param('docId'), locale);
    return c.json({ data: doc });
  });

  // versions: history + rollback (free, not an upsell)
  app.get('/:collection/docs/:docId/versions', async (c) => {
    const core = c.get('core');
    const ctx = c.get('access');
    const collection = c.req.param('collection');
    assertCan(ctx, 'readDraft', `doc:${collection}`);
    const col = core.registry.get(collection).compiled;
    const locale = parseLocale(c.req.query('locale'), core.config.defaultLocale);
    const versions = await listVersions(core.db, col, ctx.tenantId, c.req.param('docId'), locale);
    return c.json({ data: versions });
  });

  app.get('/:collection/docs/:docId/versions/:version', async (c) => {
    const core = c.get('core');
    const ctx = c.get('access');
    const collection = c.req.param('collection');
    assertCan(ctx, 'readDraft', `doc:${collection}`);
    const col = core.registry.get(collection).compiled;
    const version = Number.parseInt(c.req.param('version'), 10);
    if (!Number.isInteger(version) || version < 1) throw errors.badRequest('version must be a positive integer');
    const locale = parseLocale(c.req.query('locale'), core.config.defaultLocale);
    const data = await getVersion(core.db, col, ctx.tenantId, c.req.param('docId'), version, locale);
    if (!data) throw errors.notFound('Version not found');
    return c.json({ data });
  });

  app.post('/:collection/docs/:docId/versions/:version/restore', async (c) => {
    const core = c.get('core');
    const ctx = c.get('access');
    const collection = c.req.param('collection');
    assertCan(ctx, 'update', `doc:${collection}`);
    const col = core.registry.get(collection).compiled;
    const version = Number.parseInt(c.req.param('version'), 10);
    if (!Number.isInteger(version) || version < 1) throw errors.badRequest('version must be a positive integer');
    const locale = parseLocale(c.req.query('locale'), core.config.defaultLocale);
    const doc = await restoreVersion(core.db, col, storeContextFor(ctx, core), c.req.param('docId'), version, locale);
    return c.json({ data: doc });
  });

  return app;
}
