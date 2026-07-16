import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Hono } from 'hono';
import { runWithDraftPreview } from '@apick/core';
import type { CmsContext } from '../context.js';

/**
 * Draft preview: an editor gets a short-lived signed URL that renders a
 * document's DRAFT through the real site theme — default or fully custom
 * routes alike (core's preview scope swaps that one doc's draft in for its
 * published head during the render). The token authorizes exactly one
 * document for 30 minutes; nothing else is widened.
 */

const TTL_MS = 30 * 60_000;

export interface PreviewConfig {
  /**
   * Site path for a document, e.g. ('site-pages', doc) => `/${doc.data.path}`.
   * Return null for collections that have no page of their own.
   */
  pathFor?: (collection: string, doc: { docId: string; data: Record<string, unknown> }) => string | null;
}

/** Default mapping for the built-in pages+posts model. */
export function defaultPathFor(collection: string, doc: { data: Record<string, unknown> }): string | null {
  const slug = typeof doc.data['slug'] === 'string' ? doc.data['slug'] : null;
  if (collection === 'pages') return slug === 'home' ? '/' : slug ? `/${slug}` : null;
  if (collection === 'posts') return slug ? `/blog/${slug}` : null;
  return null;
}

export function signPreviewToken(secret: string, docId: string, path: string): string {
  const body = Buffer.from(JSON.stringify({ d: docId, p: path, exp: Date.now() + TTL_MS })).toString('base64url');
  const sig = createHmac('sha256', secret).update(`preview.${body}`).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyPreviewToken(secret: string, token: string): { docId: string; path: string } | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret).update(`preview.${body}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as { d: string; p: string; exp: number };
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    if (typeof payload.d !== 'string' || typeof payload.p !== 'string' || !payload.p.startsWith('/')) return null;
    return { docId: payload.d, path: payload.p };
  } catch {
    return null;
  }
}

const BANNER = `<div style="position:fixed;bottom:0;left:0;right:0;z-index:9999;background:#18181b;color:#fafafa;font:500 13px/1 system-ui,sans-serif;padding:10px 16px;display:flex;gap:12px;align-items:center;justify-content:center">
<span style="display:inline-block;width:8px;height:8px;border-radius:99px;background:#f59e0b"></span>
Draft preview — this is not published.
<a href="/admin" style="color:#a1a1aa;text-decoration:underline">Back to admin</a>
</div>`;

export function previewRoutes(
  app: Hono<never>,
  box: { ctx: CmsContext | null },
  config: PreviewConfig | undefined,
): void {
  const pathFor = config?.pathFor ?? defaultPathFor;

  // Session-authed: mint a preview URL for one document.
  app.post('/admin/api/preview', async (c) => {
    const ctx = box.ctx;
    if (!ctx) return c.json({ error: { code: 'internal', message: 'CMS not ready', details: null } }, 500);
    const access = (c as unknown as { get: (k: string) => { principalId: string | null } | undefined }).get('access');
    if (!access?.principalId) return c.json({ error: { code: 'unauthorized', message: 'Not signed in', details: null } }, 401);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const collection = typeof body['collection'] === 'string' ? body['collection'] : '';
    const docId = typeof body['docId'] === 'string' ? body['docId'] : '';
    if (!collection || !docId) return c.json({ error: { code: 'bad_request', message: 'collection and docId required', details: null } }, 400);
    // fetch the DRAFT head server-side (internal token) so pathFor sees current data
    const res = await ctx.fetchApi(`/v1/collections/${encodeURIComponent(collection)}/docs/${encodeURIComponent(docId)}?status=draft`, {
      token: ctx.internalToken,
    });
    if (!res.ok) return new Response(res.body, res);
    const doc = (await res.json()) as { data: { docId: string; data: Record<string, unknown> } };
    const path = pathFor(collection, doc.data);
    if (!path) return c.json({ error: { code: 'not_found', message: 'This document has no site page', details: null } }, 404);
    const token = signPreviewToken(ctx.secret, docId, path);
    return c.json({ data: { url: `/preview?token=${encodeURIComponent(token)}`, path } });
  });

  // Public (token IS the authorization): render the draft through the theme.
  app.get('/preview', async (c) => {
    const ctx = box.ctx;
    if (!ctx) return c.text('CMS not ready', 500);
    const token = c.req.query('token') ?? '';
    const payload = verifyPreviewToken(ctx.secret, token);
    if (!payload) return c.text('Preview link is invalid or has expired.', 403);
    const origin = new URL(c.req.url).origin;
    const res = await runWithDraftPreview(payload.docId, () => app.fetch(new Request(`${origin}${payload.path}`)));
    const headers = new Headers(res.headers);
    headers.set('x-robots-tag', 'noindex');
    headers.set('cache-control', 'no-store');
    if ((headers.get('content-type') ?? '').includes('text/html')) {
      const html = await res.text();
      return new Response(html.includes('</body>') ? html.replace('</body>', `${BANNER}</body>`) : html + BANNER, {
        status: res.status,
        headers,
      });
    }
    return new Response(res.body, { status: res.status, headers });
  });
}
