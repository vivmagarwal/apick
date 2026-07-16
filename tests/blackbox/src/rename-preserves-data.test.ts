import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp, defineCollection, f, silentLogger } from '@apick/core';
import { ApiClient } from './helpers.js';

/**
 * PROMISE: a field rename is a rename — data survives, history survives,
 * filters work on the new name. (Strapi's #1 data-loss pain point: rename =
 * silent drop-and-recreate.) Uses a persistent embedded DB across two boots
 * exactly like a developer editing their schema between deploys.
 */
describe('field rename preserves data', () => {
  it('renames headline -> title across a restart without losing anything', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'apick-rename-')), 'db');
    const rootKey = 'apick_rename_test';

    // v1 schema: "headline"
    const v1 = await createApp({
      database: `pglite://${dir}`,
      rootKey,
      logger: silentLogger,
      collections: [
        defineCollection('posts', {
          fields: { headline: f.text({ required: true }), body: f.markdown() },
        }),
      ],
    });
    const s1 = await v1.listen();
    const api1 = new ApiClient(s1.url, rootKey);
    const created = await api1.post('/v1/collections/posts/docs', {
      data: { headline: 'Survives renames', body: 'content' },
      publish: true,
    });
    expect(created.status).toBe(201);
    const docId = created.body.data.docId;
    await api1.patch(`/v1/collections/posts/docs/${docId}`, { patch: { headline: 'Survives renames v2' } });
    await v1.stop();

    // v2 schema: renamed to "title" with the rename declared
    const v2 = await createApp({
      database: `pglite://${dir}`,
      rootKey,
      logger: silentLogger,
      collections: [
        defineCollection('posts', {
          fields: { title: f.text({ required: true }), body: f.markdown() },
          renamedFields: { title: 'headline' },
        }),
      ],
    });
    const s2 = await v2.listen();
    const api2 = new ApiClient(s2.url, rootKey);

    // published head preserved under the new name
    const pub = await api2.get(`/v1/collections/posts/docs/${docId}`);
    expect(pub.status).toBe(200);
    expect(pub.body.data.data.title).toBe('Survives renames');
    expect(pub.body.data.data.headline).toBeUndefined();

    // draft head preserved
    const draft = await api2.get(`/v1/collections/posts/docs/${docId}?status=draft`);
    expect(draft.body.data.data.title).toBe('Survives renames v2');

    // history migrated too — old versions readable under the new name
    const v1data = await api2.get(`/v1/collections/posts/docs/${docId}/versions/1`);
    expect(v1data.body.data.data.title).toBe('Survives renames');

    // the new name is filterable; a further patch works
    const filtered = await api2.get(
      `/v1/collections/posts/docs?filter=${encodeURIComponent(JSON.stringify({ title: { $startsWith: 'Survives' } }))}`,
    );
    expect(filtered.body.data).toHaveLength(1);
    expect((await api2.patch(`/v1/collections/posts/docs/${docId}`, { patch: { title: 'v3' } })).status).toBe(200);

    // rename is idempotent across another restart
    await v2.stop();
    const v3 = await createApp({
      database: `pglite://${dir}`,
      rootKey,
      logger: silentLogger,
      collections: [
        defineCollection('posts', {
          fields: { title: f.text({ required: true }), body: f.markdown() },
          renamedFields: { title: 'headline' },
        }),
      ],
    });
    const s3 = await v3.listen();
    const api3 = new ApiClient(s3.url, rootKey);
    expect((await api3.get(`/v1/collections/posts/docs/${docId}?status=draft`)).body.data.data.title).toBe('v3');
    await v3.stop();
  });

  it('removing a field from code never deletes stored data', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'apick-remove-')), 'db');
    const rootKey = 'apick_remove_test';
    const mk = (withExtra: boolean) =>
      createApp({
        database: `pglite://${dir}`,
        rootKey,
        logger: silentLogger,
        collections: [
          defineCollection('posts', {
            fields: withExtra
              ? { title: f.text({ required: true }), extra: f.text() }
              : { title: f.text({ required: true }) },
          }),
        ],
      });

    const v1 = await mk(true);
    const s1 = await v1.listen();
    const api1 = new ApiClient(s1.url, rootKey);
    const created = await api1.post('/v1/collections/posts/docs', { data: { title: 't', extra: 'precious' } });
    const docId = created.body.data.docId;
    await v1.stop();

    // field removed from code: value hidden from responses but NOT destroyed
    const v2 = await mk(false);
    const s2 = await v2.listen();
    const api2 = new ApiClient(s2.url, rootKey);
    expect(JSON.stringify((await api2.get(`/v1/collections/posts/docs/${docId}?status=draft`)).body)).not.toContain('precious');
    await v2.stop();

    // field restored in code: the data is still there
    const v3 = await mk(true);
    const s3 = await v3.listen();
    const api3 = new ApiClient(s3.url, rootKey);
    expect((await api3.get(`/v1/collections/posts/docs/${docId}?status=draft`)).body.data.data.extra).toBe('precious');
    await v3.stop();
  });
});
