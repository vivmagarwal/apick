import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { createCms, type CmsApp } from '@apick/cms';
import { silentLogger } from '@apick/core';

/**
 * PROMISE (@apick/cms media variants, issue #6): `GET /media/:id/:filename?w=`
 * serves a width-resized image variant for an allow-listed set of widths
 * (320|480|960|1600). Variants keep the original format, are derived once and
 * stored in the blob store (second request serves identical bytes), and keep
 * every hardening + immutable-cache header. Any other width → 400; `?w=` on a
 * non-image upload → 400.
 */
describe('CMS media image variants', () => {
  let cms: CmsApp;
  let url: string;
  let adminToken: string;
  let original: Buffer;

  const upload = (buf: Buffer, name: string, type: string) => {
    const fd = new FormData();
    fd.set('file', new Blob([buf], { type }), name);
    return fetch(`${url}/admin/api/media`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}` },
      body: fd,
    });
  };

  beforeAll(async () => {
    cms = await createCms({ database: 'pglite://memory', logger: silentLogger, defaultContent: false });
    ({ url } = await cms.listen());
    const setup = await fetch(`${url}/admin/api/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'A', email: 'a@x.com', password: 'password-1234' }),
    });
    adminToken = ((await setup.json()) as { data: { token: string } }).data.token;
    // A real (non-trivial) PNG wider than the requested variant.
    original = await sharp({
      create: { width: 640, height: 400, channels: 3, background: { r: 210, g: 80, b: 40 } },
    })
      .png()
      .toBuffer();
  });

  afterAll(() => cms.stop());

  it('?w=320 serves a resized image: smaller than the original, correct content-type, hardened headers', async () => {
    const res = await upload(original, 'photo.png', 'image/png');
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { url: string } };

    const variant = await fetch(`${url}${data.url}?w=320`);
    expect(variant.status).toBe(200);
    expect(variant.headers.get('content-type')).toBe('image/png');
    expect(variant.headers.get('x-content-type-options')).toBe('nosniff');
    expect(variant.headers.get('content-security-policy')).toContain('sandbox');
    expect(variant.headers.get('cache-control')).toContain('immutable');
    expect(variant.headers.get('x-apick-variant')).toBeNull(); // real derivation, not a fallback

    const bytes = Buffer.from(await variant.arrayBuffer());
    expect(bytes.length).toBeLessThan(original.length);
    const meta = await sharp(bytes).metadata();
    expect(meta.width).toBe(320);
    expect(meta.format).toBe('png'); // format preserved

    // Same bytes on the second request (variant derived once, then served from the blob store).
    const again = await fetch(`${url}${data.url}?w=320`);
    expect(again.status).toBe(200);
    expect(Buffer.from(await again.arrayBuffer()).equals(bytes)).toBe(true);

    // The original stays untouched at the plain URL.
    const plain = await fetch(`${url}${data.url}`);
    expect(Buffer.from(await plain.arrayBuffer()).equals(original)).toBe(true);
  });

  it('rejects widths outside the allow-list with 400', async () => {
    const res = await upload(original, 'photo2.png', 'image/png');
    const { data } = (await res.json()) as { data: { url: string } };

    for (const bad of ['999', '0', '-320', 'abc', '']) {
      const r = await fetch(`${url}${data.url}?w=${bad}`);
      expect(r.status).toBe(400);
      const body = (await r.json()) as { error: { code: string } };
      expect(body.error.code).toBe('bad_request');
    }

    // Allow-listed widths all resolve.
    for (const good of [320, 480, 960, 1600]) {
      expect((await fetch(`${url}${data.url}?w=${good}`)).status).toBe(200);
    }
  });

  it('rejects ?w= on non-image uploads with 400', async () => {
    const res = await upload(Buffer.from('hello, plain text'), 'note.txt', 'text/plain');
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { url: string } };

    const r = await fetch(`${url}${data.url}?w=320`);
    expect(r.status).toBe(400);

    // ...while the plain URL still serves the file.
    const plain = await fetch(`${url}${data.url}`);
    expect(plain.status).toBe(200);
    expect(plain.headers.get('content-type')).toBe('text/plain');
  });
});
