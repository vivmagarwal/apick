import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blogCollections } from './fixtures.js';
import { filterQs, startApp, type ApiClient, type RunningApp } from './helpers.js';

/**
 * PROMISE: tenant isolation is structural — enforced in the query planner on
 * every read and write, not a filter someone can forget. One auth model:
 * operator is a scope above tenants, tenant keys cannot cross tenants even
 * with a forged header.
 */
describe('multi-tenant isolation', () => {
  let running: RunningApp;
  let acme: ApiClient; // tenant-admin key scoped to acme
  let globex: ApiClient; // tenant-admin key scoped to globex
  let acmeDocId: string;

  beforeAll(async () => {
    const { collections } = blogCollections();
    running = await startApp({ collections });
    const root = running.api;

    for (const slug of ['acme', 'globex']) {
      const res = await root.post('/v1/tenants', { slug, name: slug });
      expect(res.status).toBe(201);
    }
    const acmeKey = await root.with({ tenant: 'acme' }).post('/v1/keys', { role: 'tenant-admin', name: 'acme admin' });
    const globexKey = await root.with({ tenant: 'globex' }).post('/v1/keys', { role: 'tenant-admin', name: 'globex admin' });
    acme = running.api.with({ token: acmeKey.body.data.token, tenant: 'acme' });
    globex = running.api.with({ token: globexKey.body.data.token, tenant: 'globex' });

    const doc = await acme.post('/v1/collections/articles/docs', {
      data: { title: 'Acme secret plan', slug: 'acme-plan' },
      publish: true,
    });
    expect(doc.status).toBe(201);
    acmeDocId = doc.body.data.docId;
  });

  afterAll(() => running.stop());

  it('another tenant cannot see the document — list, get, or filter probe', async () => {
    const list = await globex.get('/v1/collections/articles/docs?status=draft&count=true');
    expect(list.body.data).toHaveLength(0);
    expect(list.body.meta.total).toBe(0);

    const get = await globex.get(`/v1/collections/articles/docs/${acmeDocId}?status=draft`);
    expect(get.status).toBe(404);

    const probe = await globex.get(`/v1/collections/articles/docs?${filterQs({ title: { $startsWith: 'Acme' } })}&status=draft`);
    expect(probe.body.data).toHaveLength(0);
  });

  it('a tenant key cannot act on another tenant via the header (one auth model, scoped grants)', async () => {
    const crossRead = await acme.with({ tenant: 'globex' }).get('/v1/collections/articles/docs?status=draft');
    expect([401, 403]).toContain(crossRead.status);
    const crossWrite = await acme.with({ tenant: 'globex' }).post('/v1/collections/articles/docs', { data: { title: 'x' } });
    expect([401, 403]).toContain(crossWrite.status);
  });

  it('tenant admins cannot reach operator endpoints', async () => {
    expect((await acme.get('/v1/tenants')).status).toBe(403);
    expect((await acme.post('/v1/tenants', { slug: 'evil', name: 'evil' })).status).toBe(403);
  });

  it('tenant admins cannot mint keys for arbitrary existing principals (privilege escalation guard)', async () => {
    // find the root principal id via operator listing
    const rootKeys = await running.api.get('/v1/keys');
    const rootPrincipal = rootKeys.body.data.find((k: { principal_name: string }) => k.principal_name === '__root');
    const attempt = await acme.post('/v1/keys', { principalId: rootPrincipal.principal_id });
    expect(attempt.status).toBe(403);
  });

  it('unique values are independent per tenant', async () => {
    const res = await globex.post('/v1/collections/articles/docs', { data: { title: 'Globex plan', slug: 'acme-plan' } });
    expect(res.status).toBe(201); // same slug, different tenant — fine
    const dup = await globex.post('/v1/collections/articles/docs', { data: { title: 'Again', slug: 'acme-plan' } });
    expect(dup.status).toBe(409); // within globex it conflicts
  });

  it('webhooks and events are tenant-scoped', async () => {
    await acme.post('/v1/webhooks', { name: 'acme-hook', url: 'http://127.0.0.1:9/dead', events: ['doc.created'] });
    const globexHooks = await globex.get('/v1/webhooks');
    expect(globexHooks.body.data).toHaveLength(0);

    const globexEvents = await globex.get('/v1/events?types=doc.created,doc.published');
    expect(JSON.stringify(globexEvents.body)).not.toContain('Acme secret plan');
  });

  it('operator (root) has cross-tenant visibility via the tenant header', async () => {
    const viaAcme = await running.api.with({ tenant: 'acme' }).get('/v1/collections/articles/docs?status=draft');
    expect(viaAcme.body.data.map((d: { data: { title: string } }) => d.data.title)).toContain('Acme secret plan');
    const viaGlobex = await running.api.with({ tenant: 'globex' }).get('/v1/collections/articles/docs?status=draft');
    expect(viaGlobex.body.data.map((d: { data: { title: string } }) => d.data.title)).toContain('Globex plan');
  });

  it('suspending a tenant turns it off', async () => {
    await running.api.post('/v1/tenants', { slug: 'doomed', name: 'Doomed' });
    const key = await running.api.with({ tenant: 'doomed' }).post('/v1/keys', { role: 'tenant-admin', name: 'd' });
    const doomed = running.api.with({ token: key.body.data.token, tenant: 'doomed' });
    expect((await doomed.get('/v1/collections/articles/docs')).status).toBe(200);
    await running.api.patch('/v1/tenants/doomed', { status: 'suspended' });
    expect((await doomed.get('/v1/collections/articles/docs')).status).toBe(403);
  });
});
