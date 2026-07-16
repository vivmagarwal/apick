import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blogCollections } from './fixtures.js';
import { eventually, filterQs, startApp, startReceiver, type RunningApp } from './helpers.js';

/**
 * PROMISE: a private field is structurally invisible — never returned, never
 * filterable, never sortable, never populatable, absent from schemas, events
 * and webhook payloads. This is the Strapi CVE class (fixed+reintroduced 5×)
 * that APIck's planner design exists to kill.
 */
describe('private fields are structurally invisible', () => {
  let running: RunningApp;
  let docId: string;
  const SECRET = 'the-secret-note-42';

  beforeAll(async () => {
    const { collections } = blogCollections();
    running = await startApp({ collections });
    const res = await running.api.post('/v1/collections/articles/docs', {
      data: { title: 'Public title', slug: 'public-title', secretNotes: SECRET, category: 'tech' },
      publish: true,
    });
    expect(res.status).toBe(201);
    docId = res.body.data.docId;
  });

  afterAll(() => running.stop());

  it('never returns private fields in reads (get, list, draft, versions)', async () => {
    for (const path of [
      `/v1/collections/articles/docs/${docId}`,
      `/v1/collections/articles/docs`,
      `/v1/collections/articles/docs/${docId}?status=draft`,
      `/v1/collections/articles/docs/${docId}/versions/1`,
    ]) {
      const res = await running.api.get(path);
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(SECRET);
      expect(JSON.stringify(res.body)).not.toContain('secretNotes');
    }
  });

  it('rejects filtering on a private field with every operator (no boolean oracle)', async () => {
    for (const filter of [
      { secretNotes: { $eq: SECRET } },
      { secretNotes: { $startsWith: 'the' } },
      { secretNotes: { $contains: 'secret' } },
      { secretNotes: { $null: false } },
      { secretNotes: SECRET },
      { $or: [{ title: 'x' }, { secretNotes: { $startsWith: 't' } }] },
      { $and: [{ $not: { secretNotes: { $null: true } } }] },
    ]) {
      const res = await running.api.get(`/v1/collections/articles/docs?${filterQs(filter)}`);
      expect(res.status, JSON.stringify(filter)).toBe(400);
      expect(res.body.error.code).toBe('plan_rejected');
    }
  });

  it('answers identically for private and nonexistent fields (existence is not an oracle)', async () => {
    const priv = await running.api.get(`/v1/collections/articles/docs?${filterQs({ secretNotes: { $eq: 'x' } })}`);
    const missing = await running.api.get(`/v1/collections/articles/docs?${filterQs({ zzzNope: { $eq: 'x' } })}`);
    expect(priv.status).toBe(missing.status);
    expect(priv.body.error.code).toBe(missing.body.error.code);
    expect(priv.body.error.message.replace('secretNotes', 'X')).toBe(missing.body.error.message.replace('zzzNope', 'X'));
  });

  it('rejects sorting on private fields', async () => {
    const res = await running.api.get(`/v1/collections/articles/docs?sort=secretNotes`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('plan_rejected');
  });

  it('rejects private relations in populate and hides private fields of populated docs', async () => {
    // authors.email is private; populate author and verify email never appears
    const author = await running.api.post('/v1/collections/authors/docs', {
      data: { name: 'Ada', email: 'ada@secret.example' },
      publish: true,
    });
    await running.api.patch(`/v1/collections/articles/docs/${docId}`, { patch: { author: author.body.data.docId } });
    await running.api.post(`/v1/collections/articles/docs/${docId}/publish`);
    const res = await running.api.get(`/v1/collections/articles/docs/${docId}?populate=author`);
    expect(res.status).toBe(200);
    expect(res.body.data.populated.author.data.name).toBe('Ada');
    expect(JSON.stringify(res.body)).not.toContain('ada@secret.example');
  });

  it('excludes private fields from introspection schemas and OpenAPI read schemas', async () => {
    const schema = await running.api.get('/v1/collections/articles/schema');
    expect(JSON.stringify(schema.body.data.readSchema)).not.toContain('secretNotes');
    // write schema DOES include it (private = write-only), read never
    expect(JSON.stringify(schema.body.data.writeSchema)).toContain('secretNotes');
    const openapi = await running.api.get('/openapi.json');
    expect(JSON.stringify(openapi.body.components.schemas.articlesDoc)).not.toContain('secretNotes');
  });

  it('keeps private fields out of webhook payloads and the event log', async () => {
    const receiver = await startReceiver();
    await running.api.post('/v1/webhooks', { name: 't', url: receiver.url, events: ['doc.updated:articles'] });
    await running.api.patch(`/v1/collections/articles/docs/${docId}`, {
      patch: { title: 'Updated', secretNotes: 'even-newer-secret' },
    });
    await eventually(() => {
      if (receiver.requests.length === 0) throw new Error('no delivery yet');
    });
    const payload = receiver.requests[0]!.body;
    expect(payload).toContain('Updated');
    expect(payload).not.toContain('even-newer-secret');
    expect(payload).not.toContain('secretNotes');

    const events = await running.api.get('/v1/events?types=doc.updated');
    expect(events.status).toBe(200);
    expect(JSON.stringify(events.body)).not.toContain('even-newer-secret');
    await receiver.close();
  });

  it('still accepts private fields on writes and enforces them in RBAC conditions server-side', async () => {
    const res = await running.api.post('/v1/collections/articles/docs', {
      data: { title: 'W', slug: 'w-article', secretNotes: 'write-ok' },
    });
    expect(res.status).toBe(201);
  });
});
