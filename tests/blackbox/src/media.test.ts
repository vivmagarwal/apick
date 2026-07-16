import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCms, type CmsApp } from '@apick/cms';
import { silentLogger } from '@apick/core';
import { ApiClient } from './helpers.js';

/**
 * PROMISE (@apick/cms media): binary uploads become ordinary `media` documents
 * over core's blob store; bytes serve publicly with hardened headers; limits
 * and permissions are enforced; deleting reclaims the bytes.
 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

describe('CMS media library', () => {
  let cms: CmsApp;
  let url: string;
  let adminToken: string;

  const upload = (token: string, buf: Buffer, name: string, type: string) => {
    const fd = new FormData();
    fd.set('file', new Blob([buf], { type }), name);
    return fetch(`${url}/admin/api/media`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
  };

  beforeAll(async () => {
    cms = await createCms({ database: 'pglite://memory', logger: silentLogger, media: { maxFileSizeMB: 2 } });
    ({ url } = await cms.listen());
    const setup = await fetch(`${url}/admin/api/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'A', email: 'a@x.com', password: 'password-1234' }),
    });
    adminToken = ((await setup.json()) as { data: { token: string } }).data.token;
  });

  afterAll(() => cms.stop());

  it('uploads, lists as a media doc, and serves the bytes publicly with hardened headers', async () => {
    const res = await upload(adminToken, PNG, 'pixel.png', 'image/png');
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { docId: string; url: string; mime: string; size: number } };
    expect(data.url).toMatch(/^\/media\//);
    expect(data.mime).toBe('image/png');

    const served = await fetch(`${url}${data.url}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(served.headers.get('content-security-policy')).toContain('sandbox');
    expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true);

    // it's an ordinary content doc (listable, MCP-visible, etc.)
    const list = await new ApiClient(url, adminToken).get('/v1/collections/media/docs?status=draft');
    expect(list.body.data.some((d: { docId: string }) => d.docId === data.docId)).toBe(true);
  });

  it('enforces size and type limits, and requires create permission', async () => {
    const big = await upload(adminToken, Buffer.alloc(3 * 1024 * 1024), 'big.png', 'image/png');
    expect([400, 422]).toContain(big.status); // rejected (body cap or media limit)

    const exe = await upload(adminToken, Buffer.from('MZ'), 'x.exe', 'application/x-msdownload');
    expect(exe.status).toBe(422);

    const anon = await fetch(`${url}/admin/api/media`, { method: 'POST', body: new FormData() });
    expect(anon.status).toBe(401);
  });

  it('viewers cannot upload; editors can', async () => {
    const admin = new ApiClient(url, adminToken);
    await admin.post('/admin/api/users', { name: 'Ed', email: 'ed@x.com', role: 'editor', password: 'editor-pass-99' });
    await admin.post('/admin/api/users', { name: 'Vi', email: 'vi@x.com', role: 'viewer', password: 'viewer-pass-99' });
    const login = async (email: string, pw: string) =>
      ((await (
        await fetch(`${url}/admin/api/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password: pw }),
        })
      ).json()) as { data: { token: string } }).data.token;

    expect((await upload(await login('ed@x.com', 'editor-pass-99'), PNG, 'e.png', 'image/png')).status).toBe(201);
    expect((await upload(await login('vi@x.com', 'viewer-pass-99'), PNG, 'v.png', 'image/png')).status).toBe(403);
  });

  it('deleting a media doc reclaims the bytes', async () => {
    const res = await upload(adminToken, PNG, 'gone.png', 'image/png');
    const { data } = (await res.json()) as { data: { docId: string; url: string } };
    expect((await fetch(`${url}${data.url}`)).status).toBe(200);
    const del = await new ApiClient(url, adminToken).delete(`/admin/api/media/${data.docId}`);
    expect(del.status).toBe(200);
    expect((await fetch(`${url}${data.url}`)).status).toBe(404);
  });

  it('media metadata (blobKey) is not leakable via the public site path, only the bytes', async () => {
    const res = await upload(adminToken, PNG, 'meta.png', 'image/png');
    const { data } = (await res.json()) as { data: { docId: string } };
    // the public site catch-all does not expose the media collection JSON
    const site = await fetch(`${url}/media`);
    expect(site.status).toBe(404); // themed 404, not a JSON dump
  });
});
