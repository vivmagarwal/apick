import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blogCollections, recentArticles } from './fixtures.js';
import { startApp, type RunningApp } from './helpers.js';

/**
 * PROMISE: first-class API — one stable error envelope, live OpenAPI 3.1,
 * llms.txt/llms-full.txt in sync with the schema, introspection, saved queries.
 */
describe('API contract & self-description', () => {
  let running: RunningApp;

  beforeAll(async () => {
    const { collections } = blogCollections();
    running = await startApp({ collections, queries: [recentArticles] });
    await running.api.post('/v1/collections/articles/docs', {
      data: { title: 'Tech A', slug: 'tech-a', category: 'tech' },
      publish: true,
    });
  });

  afterAll(() => running.stop());

  it('returns one stable error envelope everywhere', async () => {
    const cases: Array<[Promise<{ status: number; body: any }>, number, string]> = [
      [running.api.get('/v1/collections/nope/docs'), 404, 'not_found'],
      [running.api.get('/v1/nowhere'), 404, 'not_found'],
      [running.api.with({ token: null }).post('/v1/collections/articles/docs', { data: {} }), 401, 'unauthorized'],
      [running.api.post('/v1/collections/articles/docs', { data: { title: 123 } }), 422, 'validation'],
      [running.api.post('/v1/collections/articles/docs', {}), 400, 'bad_request'],
      [running.api.get('/v1/collections/articles/docs?filter=%7Bbroken'), 400, 'bad_request'],
    ];
    for (const [promise, status, code] of cases) {
      const res = await promise;
      expect(res.status).toBe(status);
      expect(res.body.error.code).toBe(code);
      expect(typeof res.body.error.message).toBe('string');
      expect('details' in res.body.error).toBe(true);
    }
  });

  it('validation errors pinpoint the failing paths', async () => {
    const res = await running.api.post('/v1/collections/articles/docs', {
      data: { title: 'ok', views: -5, seo: { metaTitle: 42 } },
    });
    expect(res.status).toBe(422);
    const paths = res.body.error.details.issues.map((i: { path: string }) => i.path);
    expect(paths).toContain('views');
    expect(paths).toContain('seo.metaTitle');
  });

  it('serves a live OpenAPI 3.1 document with real collection schemas', async () => {
    const res = await running.api.with({ token: null }).get('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.paths['/v1/collections/articles/docs']).toBeTruthy();
    expect(res.body.paths['/v1/queries/recent-articles']).toBeTruthy();
    expect(res.body.components.schemas.articlesDoc).toBeTruthy();
    expect(res.body.components.securitySchemes.bearerAuth.type).toBe('http');
    // request schema for creation references the write schema
    const post = res.body.paths['/v1/collections/articles/docs'].post;
    expect(JSON.stringify(post.requestBody)).toContain('articlesData');
  });

  it('serves llms.txt and llms-full.txt generated from the live schema', async () => {
    const short = await fetch(`${running.url}/llms.txt`).then((r) => r.text());
    expect(short).toContain('# APIck');
    expect(short).toContain('articles');
    expect(short).toContain('/llms-full.txt');

    const full = await fetch(`${running.url}/llms-full.txt`).then((r) => r.text());
    expect(full).toContain('## Collections & fields on this server');
    expect(full).toContain('### articles');
    expect(full).toContain('PRIVATE'); // private fields are called out
    expect(full).toContain('$contains'); // filter grammar documented
    expect(full).toContain('recent-articles'); // saved queries listed
    expect(full).toContain('apick-signature'); // webhook verification documented
  });

  it('introspection reflects caller permissions', async () => {
    const rootView = await running.api.get('/v1/collections');
    expect(rootView.body.data.map((c: { key: string }) => c.key).sort()).toEqual(['articles', 'authors']);
    const schema = await running.api.get('/v1/collections/articles/schema');
    expect(schema.body.data.readSchema).toBeTruthy();
    expect(schema.body.data.writeSchema).toBeTruthy();
    // anonymous: only public collections, and no write schema
    const anon = running.api.with({ token: null });
    expect((await anon.get('/v1/collections')).body.data.map((c: { key: string }) => c.key)).toEqual(['articles']);
    expect((await anon.get('/v1/collections/articles/schema')).body.data.writeSchema).toBeUndefined();
    expect((await anon.get('/v1/collections/authors/schema')).status).toBe(404);
  });

  it('saved queries validate params and page within their bounds', async () => {
    const ok = await running.api.get('/v1/queries/recent-articles?category=tech&count=true');
    expect(ok.status).toBe(200);
    expect(ok.body.data.length).toBeGreaterThan(0);
    expect(ok.body.data[0].data.category).toBe('tech');

    const missing = await running.api.get('/v1/queries/recent-articles');
    expect(missing.status).toBe(422);
    expect(missing.body.error.message).toContain('category');

    const unknown = await running.api.get('/v1/queries/does-not-exist');
    expect(unknown.status).toBe(404);
  });

  it('mutations land in the interaction log (AI-first observability)', async () => {
    const res = await running.api.get('/v1/events?types=http.request&limit=1000');
    expect(res.status).toBe(200);
    const posts = res.body.data.filter((e: { subject: { method: string } }) => e.subject.method === 'POST');
    expect(posts.length).toBeGreaterThan(0);
    expect(posts[0].payload.status).toBeTruthy();
    expect(posts[0].payload.latencyMs).toBeGreaterThanOrEqual(0);
    // reads are not logged by default ('mutations' mode)
    const reads = res.body.data.filter((e: { subject: { method: string } }) => e.subject.method === 'GET');
    expect(reads).toHaveLength(0);
  });
});
