import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blogCollections } from './fixtures.js';
import { startApp, type RunningApp } from './helpers.js';

/**
 * PROMISE: reliable, lossless data portability — export from one install,
 * import into a fresh one, and nothing is lost: drafts, published heads,
 * private fields, nested data, relations, docIds (portable uuids).
 */
describe('export / import portability', () => {
  let source: RunningApp;
  let target: RunningApp;

  beforeAll(async () => {
    source = await startApp({ collections: blogCollections().collections });
    target = await startApp({ collections: blogCollections().collections });
  });

  afterAll(async () => {
    await source.stop();
    await target.stop();
  });

  it('round-trips a full dataset into a fresh install losslessly', async () => {
    const api = source.api;
    const author = await api.post('/v1/collections/authors/docs', {
      data: { name: 'Ada', email: 'private@example.com', bio: '**hi**' },
      publish: true,
    });
    const authorId = author.body.data.docId;

    const art = await api.post('/v1/collections/articles/docs', {
      data: {
        title: 'Published with divergent draft',
        slug: 'divergent',
        secretNotes: 'private survives export',
        seo: { metaTitle: 'mt', metaKey: 'mk' },
        tags: ['a', 'b'],
        author: authorId,
        blocks: [{ __type: 'quote', text: 'q', attribution: 'me' }],
        category: 'tech',
      },
      publish: true,
    });
    const artId = art.body.data.docId;
    // diverge the draft from the published head
    await api.patch(`/v1/collections/articles/docs/${artId}`, { patch: { title: 'Draft-only title' } });
    // and one draft-only doc
    await api.post('/v1/collections/articles/docs', { data: { title: 'Draft only', slug: 'draft-only' } });

    const exported = await api.get('/v1/export');
    expect(exported.status).toBe(200);
    expect(exported.body.docs.length).toBe(3);
    // export is a backup: it DOES include private fields
    expect(JSON.stringify(exported.body)).toContain('private survives export');

    const imported = await target.api.post('/v1/import', { docs: exported.body.docs });
    expect(imported.status).toBe(200);
    expect(imported.body.data.imported).toBe(3);

    // re-export from the target and compare the portable content exactly
    const reExported = await target.api.get('/v1/export');
    const normalize = (docs: Array<Record<string, unknown>>) =>
      docs
        .map((d) => ({ collection: d['collection'], docId: d['docId'], locale: d['locale'], draft: (d['draft'] as { data: unknown }).data, published: (d['published'] as { data: unknown } | null)?.data ?? null }))
        .sort((a, b) => String(a.docId).localeCompare(String(b.docId)));
    expect(normalize(reExported.body.docs)).toEqual(normalize(exported.body.docs));

    // behavior matches too: published/draft divergence and relations resolve
    const pub = await target.api.get(`/v1/collections/articles/docs/${artId}?populate=author`);
    expect(pub.body.data.data.title).toBe('Published with divergent draft');
    expect(pub.body.data.populated.author.data.name).toBe('Ada');
    const draft = await target.api.get(`/v1/collections/articles/docs/${artId}?status=draft`);
    expect(draft.body.data.data.title).toBe('Draft-only title');

    // unique index rebuilt on import: same slug now conflicts in the target
    const dup = await target.api.post('/v1/collections/articles/docs', { data: { title: 'x', slug: 'divergent' } });
    expect(dup.status).toBe(409);
  });

  it('import into a non-empty install skips existing docs by default', async () => {
    const exported = await source.api.get('/v1/export');
    const again = await target.api.post('/v1/import', { docs: exported.body.docs });
    expect(again.body.data.imported).toBe(0);
    expect(again.body.data.skipped).toBe(3);
  });

  it('export requires the export permission', async () => {
    const key = await source.api.post('/v1/keys', { role: 'content-editor', name: 'no-export' });
    expect((await source.api.with({ token: key.body.data.token }).get('/v1/export')).status).toBe(403);
  });
});
