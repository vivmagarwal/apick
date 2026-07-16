import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineCollection, f } from 'apick';
import { blogCollections } from './fixtures.js';
import { filterQs, startApp, type ApiClient, type RunningApp } from './helpers.js';

/** NOT publicRead — the target for field-whitelist / row-condition tests.
 * (Grants are additive: on a publicRead collection nobody can see less than
 * anonymous, so restrictions are only meaningful on non-public collections.) */
const reports = defineCollection('reports', {
  fields: {
    title: f.text({ required: true }),
    category: f.enum(['tech', 'life'] as const),
    views: f.integer({ default: 0 }),
  },
});

/**
 * PROMISE: one coherent RBAC model — built-in roles, custom roles with field
 * whitelists and row conditions, all enforced by the planner (not response
 * filtering), with operator and tenant as scopes of the same system.
 */
describe('RBAC', () => {
  let running: RunningApp;
  let editor: ApiClient;
  let reader: ApiClient;
  let techDocId: string;
  let lifeDocId: string;

  beforeAll(async () => {
    const { collections } = blogCollections();
    running = await startApp({ collections: [...collections, reports] });
    const mkKey = async (role: string) => {
      const res = await running.api.post('/v1/keys', { role, name: `${role} svc` });
      expect(res.status).toBe(201);
      return running.api.with({ token: res.body.data.token });
    };
    editor = await mkKey('content-editor');
    reader = await mkKey('content-reader');

    const tech = await editor.post('/v1/collections/reports/docs', {
      data: { title: 'Tech report', category: 'tech', views: 5 },
      publish: true,
    });
    techDocId = tech.body.data.docId;
    const life = await editor.post('/v1/collections/reports/docs', {
      data: { title: 'Life report', category: 'life', views: 50 },
      publish: true,
    });
    lifeDocId = life.body.data.docId;
    // one published article so the anonymous/public path has data
    await editor.post('/v1/collections/articles/docs', { data: { title: 'Pub', slug: 'pub-a' }, publish: true });
  });

  afterAll(() => running.stop());

  it('anonymous callers only see what the public role allows', async () => {
    const anon = running.api.with({ token: null });
    expect((await anon.get('/v1/collections/articles/docs')).status).toBe(200); // publicRead
    expect((await anon.get('/v1/collections/authors/docs')).status).toBe(401); // not public
    expect((await anon.get('/v1/collections/articles/docs?status=draft')).status).toBe(401);
    expect((await anon.post('/v1/collections/articles/docs', { data: { title: 'x' } })).status).toBe(401);
    expect((await anon.get('/v1/webhooks')).status).toBe(401);
    // introspection shows only public collections
    const cols = await anon.get('/v1/collections');
    expect(cols.body.data.map((c: { key: string }) => c.key)).toEqual(['articles']);
  });

  it('content-editor can write but cannot manage system resources', async () => {
    expect((await editor.post('/v1/collections/articles/docs', { data: { title: 'e', slug: 'e1' } })).status).toBe(201);
    expect((await editor.get('/v1/collections/articles/docs?status=draft')).status).toBe(200);
    expect((await editor.get('/v1/webhooks')).status).toBe(403);
    expect((await editor.post('/v1/keys', { role: 'content-reader', name: 'x' })).status).toBe(403);
    expect((await editor.get('/v1/events')).status).toBe(403);
    expect((await editor.get('/v1/tenants')).status).toBe(403);
  });

  it('content-reader reads published only — drafts, versions and writes are denied', async () => {
    expect((await reader.get('/v1/collections/reports/docs')).status).toBe(200);
    expect((await reader.get('/v1/collections/reports/docs?status=draft')).status).toBe(403);
    expect((await reader.get(`/v1/collections/reports/docs/${techDocId}/versions`)).status).toBe(403);
    expect((await reader.post('/v1/collections/reports/docs', { data: { title: 'r' } })).status).toBe(403);
    expect((await reader.patch(`/v1/collections/reports/docs/${techDocId}`, { patch: { title: 'r' } })).status).toBe(403);
    expect((await reader.delete(`/v1/collections/reports/docs/${techDocId}`)).status).toBe(403);
    expect((await reader.post(`/v1/collections/reports/docs/${techDocId}/publish`)).status).toBe(403);
  });

  it('custom role with a field whitelist: projection AND filter/sort restrictions are structural', async () => {
    const role = await running.api.post('/v1/roles', {
      key: 'title-only',
      name: 'Title only',
      permissions: [{ action: 'read', resource: 'doc:reports', fields: ['title'] }],
    });
    expect(role.status).toBe(201);
    const key = await running.api.post('/v1/keys', { role: 'title-only', name: 'limited' });
    const limited = running.api.with({ token: key.body.data.token });

    const list = await limited.get('/v1/collections/reports/docs');
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBeGreaterThan(0);
    for (const doc of list.body.data) {
      expect(Object.keys(doc.data)).toEqual(['title']);
    }
    // filtering/sorting on a field outside the whitelist is rejected like an unknown field
    expect((await limited.get(`/v1/collections/reports/docs?${filterQs({ views: { $gt: 1 } })}`)).status).toBe(400);
    expect((await limited.get('/v1/collections/reports/docs?sort=views')).status).toBe(400);
    // populating a relation the key cannot read is denied (articles.author -> authors is not granted)
    expect((await limited.get('/v1/collections/articles/docs?populate=author')).status).toBe(403);
  });

  it('custom role with a row condition sees only matching rows (planner-enforced)', async () => {
    await running.api.post('/v1/roles', {
      key: 'tech-only',
      name: 'Tech only',
      permissions: [{ action: 'read', resource: 'doc:reports', condition: { category: { $eq: 'tech' } } }],
    });
    const key = await running.api.post('/v1/keys', { role: 'tech-only', name: 'tech svc' });
    const tech = running.api.with({ token: key.body.data.token });

    const list = await tech.get('/v1/collections/reports/docs?count=true');
    const categories = list.body.data.map((d: { data: { category: string } }) => d.data.category);
    expect(categories.length).toBeGreaterThan(0);
    expect(new Set(categories)).toEqual(new Set(['tech']));
    expect(list.body.meta.total).toBe(categories.length); // count respects the condition too

    expect((await tech.get(`/v1/collections/reports/docs/${techDocId}`)).status).toBe(200);
    expect((await tech.get(`/v1/collections/reports/docs/${lifeDocId}`)).status).toBe(404); // invisible, not forbidden
  });

  it('custom role with a WRITE field whitelist: only listed fields are writable', async () => {
    await running.api.post('/v1/roles', {
      key: 'title-writer',
      name: 'Title writer',
      permissions: [
        { action: 'read', resource: 'doc:reports' },
        { action: 'readDraft', resource: 'doc:reports' },
        { action: 'create', resource: 'doc:reports', fields: ['title'] },
        { action: 'update', resource: 'doc:reports', fields: ['title'] },
      ],
    });
    const key = await running.api.post('/v1/keys', { role: 'title-writer', name: 'tw' });
    const writer = running.api.with({ token: key.body.data.token });

    const ok = await writer.post('/v1/collections/reports/docs', { data: { title: 'allowed' } });
    expect(ok.status).toBe(201);
    const docId = ok.body.data.docId;

    const badCreate = await writer.post('/v1/collections/reports/docs', { data: { title: 'x', views: 5 } });
    expect(badCreate.status).toBe(403);

    expect((await writer.patch(`/v1/collections/reports/docs/${docId}`, { patch: { title: 'renamed' } })).status).toBe(200);
    const badPatch = await writer.patch(`/v1/collections/reports/docs/${docId}`, { patch: { views: 9 } });
    expect(badPatch.status).toBe(403);

    // restore rewrites the whole document: requires unrestricted write
    expect((await writer.post(`/v1/collections/reports/docs/${docId}/versions/1/restore`)).status).toBe(403);
  });

  it('revoked and expired keys stop working', async () => {
    const key = await running.api.post('/v1/keys', { role: 'content-reader', name: 'shortlived' });
    const client = running.api.with({ token: key.body.data.token });
    expect((await client.get('/v1/collections/articles/docs')).status).toBe(200);
    await running.api.delete(`/v1/keys/${key.body.data.id}`);
    expect((await client.get('/v1/collections/articles/docs')).status).toBe(401);

    const expired = await running.api.post('/v1/keys', {
      role: 'content-reader',
      name: 'expired',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect((await running.api.with({ token: expired.body.data.token }).get('/v1/collections/articles/docs')).status).toBe(401);
  });

  it('garbage tokens are rejected', async () => {
    expect((await running.api.with({ token: 'apick_notreal' }).get('/v1/collections/articles/docs?status=draft')).status).toBe(401);
  });
});
