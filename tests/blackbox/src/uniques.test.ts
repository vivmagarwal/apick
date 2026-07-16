import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blogCollections } from './fixtures.js';
import { startApp, type RunningApp } from './helpers.js';

/**
 * PROMISE: unique works — including inside nested objects, and across
 * draft/publish (Strapi crashes on unique-in-component because publish clones
 * rows; APIck's pointer-publish makes uniqueness per logical document).
 */
describe('unique fields', () => {
  let running: RunningApp;

  beforeAll(async () => {
    const { collections } = blogCollections();
    running = await startApp({ collections });
  });

  afterAll(() => running.stop());

  it('enforces unique on top-level fields with a clear 409', async () => {
    const api = running.api;
    expect((await api.post('/v1/collections/articles/docs', { data: { title: 'a', slug: 'unique-slug' } })).status).toBe(201);
    const dup = await api.post('/v1/collections/articles/docs', { data: { title: 'b', slug: 'unique-slug' } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('conflict');
    expect(dup.body.error.details.field).toBe('slug');
  });

  it('enforces unique INSIDE nested objects (the Strapi-impossible case)', async () => {
    const api = running.api;
    expect(
      (await api.post('/v1/collections/articles/docs', { data: { title: 'n1', slug: 'n1', seo: { metaKey: 'shared-key' } } })).status,
    ).toBe(201);
    const dup = await api.post('/v1/collections/articles/docs', { data: { title: 'n2', slug: 'n2', seo: { metaKey: 'shared-key' } } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details.field).toBe('seo.metaKey');
  });

  it('publishing does NOT collide with the draft of the same document', async () => {
    const api = running.api;
    const created = await api.post('/v1/collections/articles/docs', { data: { title: 'p', slug: 'pub-unique' } });
    const docId = created.body.data.docId;
    // publish, then patch the draft, then publish again — same unique value throughout
    expect((await api.post(`/v1/collections/articles/docs/${docId}/publish`)).status).toBe(200);
    expect((await api.patch(`/v1/collections/articles/docs/${docId}`, { patch: { title: 'p2' } })).status).toBe(200);
    expect((await api.post(`/v1/collections/articles/docs/${docId}/publish`)).status).toBe(200);
  });

  it('updating a doc keeping its own unique value is fine; stealing another doc’s value is 409', async () => {
    const api = running.api;
    const a = await api.post('/v1/collections/articles/docs', { data: { title: 'a', slug: 'val-a' } });
    await api.post('/v1/collections/articles/docs', { data: { title: 'b', slug: 'val-b' } });
    expect((await api.patch(`/v1/collections/articles/docs/${a.body.data.docId}`, { patch: { title: 'a!', slug: 'val-a' } })).status).toBe(200);
    const steal = await api.patch(`/v1/collections/articles/docs/${a.body.data.docId}`, { patch: { slug: 'val-b' } });
    expect(steal.status).toBe(409);
  });

  it('deleting a document frees its unique values', async () => {
    const api = running.api;
    const a = await api.post('/v1/collections/articles/docs', { data: { title: 'a', slug: 'freed' } });
    await api.delete(`/v1/collections/articles/docs/${a.body.data.docId}`);
    expect((await api.post('/v1/collections/articles/docs', { data: { title: 'b', slug: 'freed' } })).status).toBe(201);
  });

  it('same unique value in different locales of the same document is allowed', async () => {
    const api = running.api;
    const a = await api.post('/v1/collections/articles/docs', { data: { title: 'en', slug: 'same-slug-loc' } });
    const fr = await api.patch(`/v1/collections/articles/docs/${a.body.data.docId}`, {
      patch: { title: 'fr', slug: 'same-slug-loc' },
      locale: 'fr',
      upsertLocale: true,
    });
    expect(fr.status).toBe(200);
    expect(fr.body.data.locale).toBe('fr');
  });
});
