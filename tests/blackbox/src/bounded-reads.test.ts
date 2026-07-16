import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blogCollections } from './fixtures.js';
import { filterQs, startApp, type RunningApp } from './helpers.js';

/**
 * PROMISE: bounded, predictable reads — the API cannot be coerced into a
 * pathological query. Depth, breadth and size caps are enforced at plan time.
 */
describe('bounded reads', () => {
  let running: RunningApp;

  beforeAll(async () => {
    const { collections } = blogCollections();
    running = await startApp({ collections });
    for (let i = 0; i < 5; i++) {
      await running.api.post('/v1/collections/articles/docs', {
        data: { title: `Doc ${i}`, slug: `doc-${i}`, views: i * 10, category: i % 2 ? 'tech' : 'life' },
        publish: true,
      });
    }
  });

  afterAll(() => running.stop());

  it('clamps page size to 100', async () => {
    const res = await running.api.get('/v1/collections/articles/docs?pageSize=100000');
    expect(res.status).toBe(200);
    expect(res.body.meta.pageSize).toBe(100);
  });

  it('rejects oversized filters (node budget)', async () => {
    const huge = { $or: Array.from({ length: 60 }, (_, i) => ({ views: { $eq: i } })) };
    const res = await running.api.get(`/v1/collections/articles/docs?${filterQs(huge)}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('plan_rejected');
  });

  it('rejects $in with more than 100 values', async () => {
    const res = await running.api.get(`/v1/collections/articles/docs?${filterQs({ views: { $in: Array.from({ length: 101 }, (_, i) => i) } })}`);
    expect(res.status).toBe(400);
  });

  it('rejects more than 3 sort keys and unsortable fields', async () => {
    expect((await running.api.get('/v1/collections/articles/docs?sort=title,views,category,featured')).status).toBe(400);
    expect((await running.api.get('/v1/collections/articles/docs?sort=tags')).status).toBe(400);
    expect((await running.api.get('/v1/collections/articles/docs?sort=author')).status).toBe(400);
  });

  it('rejects unknown operators and malformed filters', async () => {
    expect((await running.api.get(`/v1/collections/articles/docs?${filterQs({ views: { $regex: '.*' } })}`)).status).toBe(400);
    expect((await running.api.get(`/v1/collections/articles/docs?${filterQs({ $magic: [] })}`)).status).toBe(400);
    expect((await running.api.get('/v1/collections/articles/docs?filter=not-json')).status).toBe(400);
  });

  it('rejects filters on unfilterable field types (json, lists, blocks, objects)', async () => {
    for (const field of ['tags', 'blocks', 'seo']) {
      const res = await running.api.get(`/v1/collections/articles/docs?${filterQs({ [field]: { $eq: 'x' } })}`);
      expect(res.status, field).toBe(400);
    }
  });

  it('caps populate breadth', async () => {
    const res = await running.api.get(
      '/v1/collections/articles/docs?populate=author,related,a3,a4,a5,a6,a7,a8,a9',
    );
    expect(res.status).toBe(400);
  });

  it('supports real filtering/sorting/pagination inside the budget', async () => {
    const res = await running.api.get(
      `/v1/collections/articles/docs?${filterQs({ $and: [{ views: { $gte: 10 } }, { category: 'tech' }] })}&sort=-views&pageSize=2&count=true`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    const views = res.body.data.map((d: { data: { views: number } }) => d.data.views);
    expect(views).toEqual([...views].sort((a, b) => b - a));
    expect(res.body.meta.total).toBeGreaterThan(0);
  });

  it('LIKE metacharacters in $contains are literals, not wildcards', async () => {
    await running.api.post('/v1/collections/articles/docs', { data: { title: '100% real', slug: 'pct' }, publish: true });
    const literal = await running.api.get(`/v1/collections/articles/docs?${filterQs({ title: { $contains: '100%' } })}`);
    expect(literal.body.data).toHaveLength(1);
    const wild = await running.api.get(`/v1/collections/articles/docs?${filterQs({ title: { $contains: '1%l' } })}`);
    expect(wild.body.data).toHaveLength(0); // % must not act as a wildcard
  });
});
