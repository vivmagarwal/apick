import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExternalIdentity } from '@apick/core';
import { blogCollections } from './fixtures.js';
import { startApp, type RunningApp } from './helpers.js';

/**
 * PROMISE: one coherent, pluggable auth model. `auth.verifyToken` maps your
 * IdP's tokens (JWTs etc.) into the SAME principal/RBAC system as API keys —
 * no second auth stack. Test tokens look like `idp_<sub>:<role|role>`.
 */
describe('bring-your-own-IdP auth', () => {
  let running: RunningApp;

  beforeAll(async () => {
    const { collections } = blogCollections();
    running = await startApp({
      collections,
      auth: {
        verifyToken: (token): ExternalIdentity | null => {
          // stand-in for real JWT verification
          if (!token.startsWith('idp_')) return null;
          const [sub, roles] = token.slice(4).split(':');
          if (!sub) return null;
          return { externalId: sub, name: `User ${sub}`, roles: roles ? roles.split('|') : [] };
        },
      },
    });
  });

  afterAll(() => running.stop());

  it('maps IdP roles from claims: an editor token can write, and is attributed in the audit log', async () => {
    const alice = running.api.with({ token: 'idp_alice:content-editor' });
    const created = await alice.post('/v1/collections/articles/docs', {
      data: { title: 'By Alice', slug: 'by-alice' },
      publish: true,
    });
    expect(created.status).toBe(201);

    // stable principal across requests (upsert by externalId)
    const principals = await running.api.get('/v1/principals');
    const aliceRows = principals.body.data.filter((p: { external_id: string }) => p.external_id === 'alice');
    expect(aliceRows).toHaveLength(1);
    expect(aliceRows[0].kind).toBe('user');

    const events = await running.api.get('/v1/events?types=doc.created&limit=1000');
    const evt = events.body.data.find((e: { payload: { data?: { title?: string } } }) => e.payload.data?.title === 'By Alice');
    expect(evt.actor.principalId).toBe(aliceRows[0].id);
    expect(evt.actor.keyId).toBeUndefined(); // not an API key
  });

  it('a token with no roles gets only the public baseline', async () => {
    const bob = running.api.with({ token: 'idp_bob' });
    expect((await bob.get('/v1/collections/articles/docs')).status).toBe(200); // articles are publicRead
    expect((await bob.get('/v1/collections/articles/docs?status=draft')).status).toBe(403);
    expect((await bob.post('/v1/collections/articles/docs', { data: { title: 'x' } })).status).toBe(403);
    expect((await bob.get('/v1/webhooks')).status).toBe(403);
  });

  it('rejected tokens are 401; API keys still work alongside the hook', async () => {
    expect((await running.api.with({ token: 'not-an-idp-token' }).get('/v1/collections/articles/docs?status=draft')).status).toBe(401);
    expect((await running.api.get('/v1/collections/articles/docs?status=draft')).status).toBe(200); // root API key path unaffected
  });

  it('persistent grants can be layered on an external principal (and apply immediately)', async () => {
    // carol logs in once so her principal exists
    const carol = running.api.with({ token: 'idp_carol' });
    expect((await carol.get('/v1/webhooks')).status).toBe(403);

    const principals = await running.api.get('/v1/principals');
    const carolRow = principals.body.data.find((p: { external_id: string }) => p.external_id === 'carol');
    const grant = await running.api.post('/v1/grants', { principalId: carolRow.id, roleKey: 'tenant-admin' });
    expect(grant.status).toBe(201);

    expect((await carol.get('/v1/webhooks')).status).toBe(200); // cache invalidated on grant
  });

  it('claim roles never confer operator scope', async () => {
    const eve = running.api.with({ token: 'idp_eve:operator-admin' });
    // operator-admin RULES apply within the tenant …
    expect((await eve.get('/v1/collections/articles/docs?status=draft')).status).toBe(200);
    // … but operator-scope endpoints stay closed (isOperator requires a persistent operator grant)
    expect((await eve.get('/v1/tenants')).status).toBe(403);
    expect((await eve.post('/v1/tenants', { slug: 'evil', name: 'evil' })).status).toBe(403);
  });
});
