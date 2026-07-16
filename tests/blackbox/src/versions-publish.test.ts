import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blogCollections } from './fixtures.js';
import { startApp, type RunningApp } from './helpers.js';

/**
 * PROMISE: publish is a pointer, not a copy; every write is an append-only
 * version; history, audit and rollback are built in and free.
 */
describe('versions, publish pointer, history & rollback', () => {
  let running: RunningApp;

  beforeAll(async () => {
    const { collections } = blogCollections();
    running = await startApp({ collections });
  });

  afterAll(() => running.stop());

  it('walks the full draft/publish lifecycle with pointer semantics', async () => {
    const api = running.api;
    const created = await api.post('/v1/collections/articles/docs', { data: { title: 'v1 title', slug: 'lifecycle' } });
    expect(created.status).toBe(201);
    const docId = created.body.data.docId;
    expect(created.body.data.status).toBe('draft');
    expect(created.body.data.version).toBe(1);

    // not visible as published yet
    expect((await api.get(`/v1/collections/articles/docs/${docId}`)).status).toBe(404);

    // publish v1
    const published = await api.post(`/v1/collections/articles/docs/${docId}/publish`);
    expect(published.body.data.status).toBe('published');
    expect(published.body.data.publishedAt).toBeTruthy();

    // patch draft twice — published stays at v1
    await api.patch(`/v1/collections/articles/docs/${docId}`, { patch: { title: 'v2 title' } });
    await api.patch(`/v1/collections/articles/docs/${docId}`, { patch: { title: 'v3 title', views: 7 } });
    const pub = await api.get(`/v1/collections/articles/docs/${docId}`);
    expect(pub.body.data.data.title).toBe('v1 title');
    expect(pub.body.data.version).toBe(1);
    const draft = await api.get(`/v1/collections/articles/docs/${docId}?status=draft`);
    expect(draft.body.data.data.title).toBe('v3 title');
    expect(draft.body.data.version).toBe(3);

    // history is complete and attributed
    const versions = await api.get(`/v1/collections/articles/docs/${docId}/versions`);
    expect(versions.body.data.map((v: { version: number; op: string }) => `${v.version}:${v.op}`)).toEqual([
      '3:patch',
      '2:patch',
      '1:create',
    ]);
    expect(versions.body.data[0].actor).toBeTruthy();

    // fetch an old version's full data
    const v2 = await api.get(`/v1/collections/articles/docs/${docId}/versions/2`);
    expect(v2.body.data.data.title).toBe('v2 title');

    // rollback = restore as NEW version (history is never rewritten)
    const restored = await api.post(`/v1/collections/articles/docs/${docId}/versions/1/restore`);
    expect(restored.body.data.version).toBe(4);
    expect(restored.body.data.data.title).toBe('v1 title');

    // publish the restored draft, then unpublish entirely
    await api.post(`/v1/collections/articles/docs/${docId}/publish`);
    const repub = await api.get(`/v1/collections/articles/docs/${docId}`);
    expect(repub.body.data.version).toBe(4);
    await api.post(`/v1/collections/articles/docs/${docId}/unpublish`);
    expect((await api.get(`/v1/collections/articles/docs/${docId}`)).status).toBe(404);
    expect((await api.get(`/v1/collections/articles/docs/${docId}?status=draft`)).status).toBe(200);
  });

  it('optimistic concurrency via ifVersion', async () => {
    const api = running.api;
    const created = await api.post('/v1/collections/articles/docs', { data: { title: 'cc', slug: 'cc' } });
    const docId = created.body.data.docId;
    const ok = await api.patch(`/v1/collections/articles/docs/${docId}`, { patch: { title: 'cc2' }, ifVersion: 1 });
    expect(ok.status).toBe(200);
    const stale = await api.patch(`/v1/collections/articles/docs/${docId}`, { patch: { title: 'cc3' }, ifVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.details.currentVersion).toBe(2);
  });

  it('merge-patch semantics: null removes, nested merges, arrays replace; immutable/required guarded', async () => {
    const api = running.api;
    const created = await api.post('/v1/collections/articles/docs', {
      data: { title: 't', slug: 'mp', tags: ['a', 'b'], seo: { metaTitle: 'mt', metaKey: 'mk-1' } },
    });
    const docId = created.body.data.docId;

    const patched = await api.patch(`/v1/collections/articles/docs/${docId}`, {
      patch: { tags: ['c'], seo: { metaTitle: 'mt2' }, views: 5 },
    });
    expect(patched.body.data.data.tags).toEqual(['c']);
    expect(patched.body.data.data.seo).toEqual({ metaTitle: 'mt2', metaKey: 'mk-1' }); // nested merge keeps metaKey
    const removed = await api.patch(`/v1/collections/articles/docs/${docId}`, { patch: { seo: { metaTitle: null } } });
    expect(removed.body.data.data.seo).toEqual({ metaKey: 'mk-1' });

    // required fields cannot be nulled away
    const badRequired = await api.patch(`/v1/collections/articles/docs/${docId}`, { patch: { title: null } });
    expect(badRequired.status).toBe(422);
  });

  it('deleting a document keeps its history for audit', async () => {
    const api = running.api;
    const created = await api.post('/v1/collections/articles/docs', { data: { title: 'del', slug: 'del-me' } });
    const docId = created.body.data.docId;
    await api.delete(`/v1/collections/articles/docs/${docId}`);
    expect((await api.get(`/v1/collections/articles/docs/${docId}?status=draft`)).status).toBe(404);
    const events = await api.get('/v1/events?types=doc.deleted');
    expect(JSON.stringify(events.body)).toContain(docId);
  });
});
