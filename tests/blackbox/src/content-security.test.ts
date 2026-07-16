import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCms, type CmsApp } from '@apick/cms';
import { silentLogger } from '@apick/core';

/**
 * PROMISE: user content cannot inject scripts into the public site. The
 * markdown render boundary is hardened by default and covers EVERY write path
 * — including content written directly via the API/MCP, bypassing the editor.
 */
const XSS = [
  '<script>window.__pwned=1</script>',
  '<img src=x onerror="window.__pwned=1">',
  '<iframe src="javascript:window.__pwned=1"></iframe>',
  '[click me](javascript:window.__pwned=1)',
  '![evil](javascript:window.__pwned=1)',
  '[data](data:text/html,<script>window.__pwned=1</script>)',
  '<svg onload="window.__pwned=1"></svg>',
  '<a href="javascript:window.__pwned=1">x</a>',
].join('\n\n');

describe('public-site content sanitization', () => {
  let cms: CmsApp;
  let url: string;
  let token: string;

  const publishPost = async (slug: string, body: string) => {
    const res = await fetch(`${url}/v1/collections/posts/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ data: { title: 'x', slug, body }, publish: true }),
    });
    expect(res.status).toBe(201);
  };

  beforeAll(async () => {
    cms = await createCms({ database: 'pglite://memory', logger: silentLogger });
    ({ url } = await cms.listen());
    const setup = await fetch(`${url}/admin/api/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'A', email: 'a@x.com', password: 'password-1234' }),
    });
    token = ((await setup.json()) as { data: { token: string } }).data.token;
  });

  afterAll(() => cms.stop());

  it('neutralizes script/handler/protocol injection written via the API', async () => {
    await publishPost('xss', XSS);
    const html = await (await fetch(`${url}/blog/xss`)).text();
    expect(html).not.toContain('<script'); // dropped
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('onload');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('data:text/html');
    expect(html).not.toContain('__pwned');
  });

  it('preserves legitimate markdown (headings, formatting, safe links/images)', async () => {
    await publishPost('legit', '# Title\n\nSome **bold** text and a [link](https://example.com) and ![img](/media/a/b.png).');
    const html = await (await fetch(`${url}/blog/legit`)).text();
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('src="/media/a/b.png"');
  });

  it('sanitizes markdown inside page blocks too', async () => {
    const res = await fetch(`${url}/v1/collections/pages/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        data: { title: 'P', slug: 'blocked', body: [{ __type: 'prose', markdown: '<script>window.__pwned=1</script>\n\n# Real heading' }] },
        publish: true,
      }),
    });
    expect(res.status).toBe(201);
    const html = await (await fetch(`${url}/blocked`)).text();
    expect(html).not.toContain('<script');
    expect(html).not.toContain('__pwned');
    expect(html).toContain('<h1>Real heading</h1>');
  });

  it('opt-out (content.sanitize:false) restores raw HTML for trusted setups', async () => {
    const trusted = await createCms({ database: 'pglite://memory', logger: silentLogger, content: { sanitize: false } });
    const listening = await trusted.listen();
    const s = await fetch(`${listening.url}/admin/api/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'A', email: 'a@x.com', password: 'password-1234' }),
    });
    const tok = ((await s.json()) as { data: { token: string } }).data.token;
    await fetch(`${listening.url}/v1/collections/posts/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ data: { title: 'x', slug: 'raw', body: 'text <mark>kept</mark> here' }, publish: true }),
    });
    const html = await (await fetch(`${listening.url}/blog/raw`)).text();
    expect(html).toContain('<mark>kept</mark>');
    await trusted.stop();
  });
});
