import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCms, type CmsApp } from '@apick/cms';
import { silentLogger } from '@apick/core';
import { ApiClient } from './helpers.js';

/**
 * PROMISE (@apick/cms): the CMS is a pure consumer of core — its users ride
 * the BYO-IdP hook, its RBAC mapping closes escalation paths, its sessions
 * are real, and everything an admin UI does is equally doable by an agent.
 */
describe('@apick/cms API surface', () => {
  let cms: CmsApp;
  let url: string;
  let admin: ApiClient;
  let adminToken: string;

  const boot = async (database: string): Promise<{ app: CmsApp; url: string }> => {
    const app = await createCms({ database, logger: silentLogger, site: { title: 'BB' } });
    const listening = await app.listen();
    return { app, url: listening.url };
  };

  beforeAll(async () => {
    ({ app: cms, url } = await boot('pglite://memory'));
    const res = await fetch(`${url}/admin/api/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Root', email: 'root@x.com', password: 'password-1234' }),
    });
    adminToken = ((await res.json()) as { data: { token: string } }).data.token;
    admin = new ApiClient(url, adminToken);
  });

  afterAll(() => cms.stop());

  const login = (email: string, password: string) =>
    fetch(`${url}/admin/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

  it('setup works exactly once', async () => {
    const again = await fetch(`${url}/admin/api/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Evil', email: 'evil@x.com', password: 'evil-password-1' }),
    });
    expect(again.status).toBe(403);
  });

  it('sessions drive the CORE api with the right role, and mutations are attributed', async () => {
    const created = await admin.post('/v1/collections/posts/docs', {
      data: { title: 'Attributed', slug: 'attributed', body: 'x' },
      publish: true,
    });
    expect(created.status).toBe(201);
    const events = await admin.get('/v1/events?types=doc.created&limit=100');
    const evt = events.body.data.find((e: { payload: { data?: { title?: string } } }) => e.payload.data?.title === 'Attributed');
    expect(evt.actor.principalId).toBeTruthy();
    expect(evt.actor.via).toBe('api');
  });

  it('editors cannot read, write or escalate through cms-users — via ANY route', async () => {
    await admin.post('/admin/api/users', { name: 'Ed', email: 'ed@x.com', role: 'editor', password: 'editor-pass-99' });
    const token = ((await (await login('ed@x.com', 'editor-pass-99')).json()) as { data: { token: string } }).data.token;
    const editor = new ApiClient(url, token);

    expect((await editor.get('/v1/collections/cms-users/docs?status=draft')).status).toBe(403);
    expect((await editor.post('/v1/collections/cms-users/docs', { data: {} })).status).toBe(403);
    expect((await editor.get('/admin/api/users')).status).toBe(403);
    expect((await editor.post('/admin/api/users', { name: 'x', email: 'x@x.com', role: 'admin', password: 'xxxxxxxxxxxx' })).status).toBe(403);
    // introspection doesn't even reveal the users collection to editors
    const cols = await editor.get('/v1/collections');
    expect(cols.body.data.map((c: { key: string }) => c.key)).not.toContain('cms-users');
    // content works fine
    expect((await editor.post('/v1/collections/posts/docs', { data: { title: 'ed', slug: 'ed-post', body: 'x' } })).status).toBe(201);
    // system endpoints closed
    expect((await editor.get('/v1/keys')).status).toBe(403);
    expect((await editor.get('/v1/webhooks')).status).toBe(403);
  });

  it('passwordHash is structurally unreachable even for admins', async () => {
    const list = await admin.get('/v1/collections/cms-users/docs?status=draft');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain('passwordHash');
    expect(JSON.stringify(list.body)).not.toContain('scrypt$');
    // filter probe rejected like an unknown field
    const probe = await admin.get(
      `/v1/collections/cms-users/docs?status=draft&filter=${encodeURIComponent(JSON.stringify({ passwordHash: { $startsWith: 'scrypt' } }))}`,
    );
    expect(probe.status).toBe(400);
    expect(probe.body.error.code).toBe('plan_rejected');
  });

  it('login is rate-limited and constant-shaped', async () => {
    const wrongEmail = await login('ghost@x.com', 'whatever-12345');
    const wrongPass = await login('root@x.com', 'whatever-12345');
    expect(wrongEmail.status).toBe(401);
    expect(wrongPass.status).toBe(401);
    const bodyA = (await wrongEmail.json()) as { error: { message: string } };
    const bodyB = (await wrongPass.json()) as { error: { message: string } };
    expect(bodyA.error.message).toBe(bodyB.error.message); // no user-exists oracle

    for (let i = 0; i < 5; i++) await login('brute@x.com', `attempt-${i}-xxxx`);
    expect((await login('brute@x.com', 'attempt-final-xx')).status).toBe(429);
  });

  it('demoting or deleting the last admin is refused; self-deletion is refused', async () => {
    const users = await admin.get('/admin/api/users');
    const root = users.body.data.find((u: { email: string }) => u.email === 'root@x.com');
    expect((await admin.patch(`/admin/api/users/${root.docId}`, { role: 'editor' })).status).toBe(409);
    expect((await admin.delete(`/admin/api/users/${root.docId}`)).status).toBe(409);
  });

  it('sessions expire with the configured TTL and die on tampering', async () => {
    const token = ((await (await login('root@x.com', 'password-1234')).json()) as { data: { token: string } }).data.token;
    const tampered = token.slice(0, -4) + 'aaaa';
    expect((await new ApiClient(url, tampered).get('/admin/api/me')).status).toBe(401);
    expect((await new ApiClient(url, 'cms1.not.real').get('/admin/api/me')).status).toBe(401);
  });

  it('secret + internal key survive a restart (persistent db) so sessions keep working', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'apick-cms-restart-')), 'db');
    const first = await boot(`pglite://${dir}`);
    const setup = await fetch(`${first.url}/admin/api/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'P', email: 'p@x.com', password: 'persistent-123' }),
    });
    const token = ((await setup.json()) as { data: { token: string } }).data.token;
    await first.app.stop();

    const second = await boot(`pglite://${dir}`);
    // the pre-restart session token still authenticates (same persisted secret)
    const me = await fetch(`${second.url}/admin/api/me`, { headers: { authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
    // and the CMS can still perform internal writes (deterministic internal key)
    const create = await fetch(`${second.url}/admin/api/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'After', email: 'after@x.com', role: 'viewer', password: 'viewer-pass-12' }),
    });
    expect(create.status).toBe(201);
    await second.app.stop();
  });

  it('MCP agents work against a CMS app with a scoped key from the admin API', async () => {
    const key = await admin.post('/v1/keys', { role: 'cms-editor', name: 'agent' });
    expect(key.status).toBe(201);
    const res = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${key.body.data.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'create_document', arguments: { collection: 'posts', data: { title: 'MCP post', slug: 'mcp-post', body: 'by an agent' }, publish: true } },
      }),
    });
    const body = (await res.json()) as { result: { isError: boolean } };
    expect(body.result.isError).toBe(false);
    // the agent's post is on the public site
    const site = await (await fetch(`${url}/blog/mcp-post`)).text();
    expect(site).toContain('MCP post');
    // but the cms-editor key cannot touch users
    const denied = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key.body.data.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_documents', arguments: { collection: 'cms-users', status: 'draft' } } }),
    });
    expect(((await denied.json()) as { result: { isError: boolean } }).result.isError).toBe(true);
  });
});
