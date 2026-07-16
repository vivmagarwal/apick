import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, defineCollection, f, runWithDraftPreview, silentLogger, type ApickApp } from '@apick/core';
import { ApiClient, eventually, startApp, type RunningApp } from './helpers.js';

/**
 * PROMISE: the authoring primitives behind schema-driven UIs —
 * admin hints + inverse-relation introspection, ranked full-text search,
 * scheduled publishing, and single-document draft preview.
 */

const pages = () =>
  defineCollection('pages2', {
    access: { publicRead: true },
    admin: { label: 'Pages', icon: '📄', titleField: 'title' },
    fields: {
      title: f.text({ required: true }),
      slug: f.slug({ required: true, unique: true }),
      body: f.markdown(),
      secret: f.text({ private: true }),
    },
  });

const attachments = () =>
  defineCollection('attachments', {
    access: { publicRead: true },
    admin: { label: 'Attachments', titleField: 'name', orderField: 'order' },
    fields: {
      name: f.text({ required: true }),
      order: f.integer({ default: 0 }),
      page: f.relation('pages2'),
    },
  });

describe('authoring primitives', () => {
  let running: RunningApp;

  beforeAll(async () => {
    running = await startApp({ collections: [pages(), attachments()] });
  });

  afterAll(() => running.stop());

  it('schema introspection carries admin hints and inverse relations', async () => {
    const res = await running.api.get('/v1/collections/pages2/schema');
    expect(res.status).toBe(200);
    expect(res.body.data.admin).toEqual({ label: 'Pages', icon: '📄', titleField: 'title' });
    expect(res.body.data.referencedBy).toEqual([
      { collection: 'attachments', field: 'page', many: false, admin: { label: 'Attachments', titleField: 'name', orderField: 'order' } },
    ]);
    const list = await running.api.get('/v1/collections');
    const entry = list.body.data.find((c: { key: string }) => c.key === 'pages2');
    expect(entry.admin.label).toBe('Pages');
  });

  it('rejects admin hints that name unknown fields', () => {
    expect(() =>
      defineCollection('broken', { admin: { titleField: 'nope' }, fields: { title: f.text() } }),
    ).toThrow(/titleField/);
  });

  describe('full-text search', () => {
    beforeAll(async () => {
      const docs = [
        { title: 'Sovereignty and the state', slug: 'sov', body: 'Westphalia established sovereign statehood in 1648.' },
        { title: 'Power in global politics', slug: 'power', body: 'Hard power, soft power, and smart power combined.' },
        { title: 'Unpublished draft about sovereignty', slug: 'draft-sov', body: 'sovereignty draft only' },
      ];
      for (const [i, data] of docs.entries()) {
        await running.api.post('/v1/collections/pages2/docs', { data, publish: i < 2 });
      }
    });

    it('ranks matches and only searches published heads for anonymous callers', async () => {
      const anon = running.api.with({ token: null });
      const res = await anon.get('/v1/search?q=sovereignty');
      expect(res.status).toBe(200);
      const group = res.body.data.find((g: { collection: string }) => g.collection === 'pages2');
      expect(group.hits).toHaveLength(1);
      expect(group.hits[0].data.slug).toBe('sov');
    });

    it('draft search needs readDraft and sees drafts', async () => {
      const res = await running.api.get('/v1/search?q=sovereignty&status=draft');
      const group = res.body.data.find((g: { collection: string }) => g.collection === 'pages2');
      expect(group.hits.map((h: { data: { slug: string } }) => h.data.slug).sort()).toEqual(['draft-sov', 'sov']);
    });

    it('supports websearch syntax through list ?search= too', async () => {
      const res = await running.api.get('/v1/collections/pages2/docs?search=power');
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].data.slug).toBe('power');
    });

    it('rejects short queries', async () => {
      expect((await running.api.get('/v1/search?q=a')).status).toBe(400);
    });
  });

  describe('scheduled publishing', () => {
    it('schedules, exposes scheduledPublishAt, and cancel clears it', async () => {
      const created = await running.api.post('/v1/collections/pages2/docs', {
        data: { title: 'Scheduled page', slug: 'scheduled' },
      });
      const docId = created.body.data.docId;
      const at = new Date(Date.now() + 3600_000).toISOString();
      const scheduled = await running.api.post(`/v1/collections/pages2/docs/${docId}/publish`, { at });
      expect(scheduled.status).toBe(200);
      expect(scheduled.body.data.scheduledPublishAt).toBe(at);
      expect(scheduled.body.data.publishedVersion).toBeNull();

      const cancelled = await running.api.request('DELETE', `/v1/collections/pages2/docs/${docId}/publish-schedule`);
      expect(cancelled.body.data.scheduledPublishAt).toBeNull();
    });

    it('rejects past datetimes and publishes immediately without "at"', async () => {
      const created = await running.api.post('/v1/collections/pages2/docs', {
        data: { title: 'Now page', slug: 'now-page' },
      });
      const docId = created.body.data.docId;
      const past = await running.api.post(`/v1/collections/pages2/docs/${docId}/publish`, {
        at: new Date(Date.now() - 1000).toISOString(),
      });
      expect(past.status).toBe(400);
      const now = await running.api.post(`/v1/collections/pages2/docs/${docId}/publish`);
      expect(now.body.data.publishedVersion).not.toBeNull();
      expect(now.body.data.scheduledPublishAt).toBeNull();
    });
  });

  describe('draft preview scope', () => {
    it('one doc impersonates its published head inside the scope — everything else unchanged', async () => {
      const created = await running.api.post('/v1/collections/pages2/docs', {
        data: { title: 'Preview me', slug: 'preview-me', body: 'v1 body' },
        publish: true,
      });
      const docId = created.body.data.docId;
      await running.api.patch(`/v1/collections/pages2/docs/${docId}`, { patch: { body: 'v2 DRAFT body' } });

      const anonFetch = (path: string) => running.app.fetch(new Request(`http://x${path}`));
      // outside the scope: published body
      const outside = await (await anonFetch(`/v1/collections/pages2/docs/${docId}`)).json();
      expect(outside.data.data.body).toBe('v1 body');
      // inside the scope: the draft, via LIST and GET alike (custom routes use lists)
      const inside = await runWithDraftPreview(docId, async () => {
        const get = await (await anonFetch(`/v1/collections/pages2/docs/${docId}`)).json();
        const list = await (
          await anonFetch(`/v1/collections/pages2/docs?filter=${encodeURIComponent(JSON.stringify({ slug: { $eq: 'preview-me' } }))}`)
        ).json();
        return { get, list };
      });
      expect(inside.get.data.data.body).toBe('v2 DRAFT body');
      expect(inside.list.data[0].data.body).toBe('v2 DRAFT body');

      // a NEVER-published doc appears inside its own preview scope (and only there)
      const draftOnly = await running.api.post('/v1/collections/pages2/docs', {
        data: { title: 'Brand new', slug: 'brand-new', body: 'unpublished' },
      });
      const missing = await (await anonFetch(`/v1/collections/pages2/docs/${draftOnly.body.data.docId}`)).json();
      expect(missing.error.code).toBe('not_found');
      const found = await runWithDraftPreview(draftOnly.body.data.docId, async () =>
        (await anonFetch(`/v1/collections/pages2/docs/${draftOnly.body.data.docId}`)).json(),
      );
      expect(found.data.data.body).toBe('unpublished');
    });

    it('rejects non-uuid preview ids', () => {
      expect(() => runWithDraftPreview("x' or 1=1 --", () => null)).toThrow();
    });
  });
});
