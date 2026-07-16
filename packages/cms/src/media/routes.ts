import { createHash } from 'node:crypto';
import type { Hono } from 'hono';
import { assertCan, deleteBlob, getBlob, putBlob, type HonoEnv } from '@apick/core';
import type { CmsContext } from '../context.js';
import { requireCtx } from '../context.js';

/**
 * The media library. Binary bytes live in core's blob store (zero-config,
 * replica-safe Postgres storage — swap for object storage via a custom
 * `media.storage` driver when your library outgrows the database); metadata
 * is an ordinary `media` collection, so listing, permissions, webhooks,
 * audit and MCP all apply like any other content.
 */

export const MEDIA_COLLECTION = 'media';

export interface MediaStorage {
  put(tenantId: string, data: Buffer, mime: string): Promise<{ key: string }>;
  get(tenantId: string, key: string): Promise<{ data: Buffer; mime: string } | null>;
  delete(tenantId: string, key: string): Promise<void>;
}

export interface MediaOptions {
  maxFileSizeMB: number;
  /** Mime allow-list; entries may be exact ("application/pdf") or prefixes ("image/"). */
  allowedTypes: string[];
  storage: MediaStorage | null; // null = core blob store
}

export const DEFAULT_MEDIA_OPTIONS: MediaOptions = {
  maxFileSizeMB: 25,
  allowedTypes: ['image/', 'video/', 'audio/', 'application/pdf', 'text/plain'],
  storage: null,
};

function databaseStorage(ctx: CmsContext): MediaStorage {
  return {
    put: async (tenantId, data, mime) => ({ key: (await putBlob(ctx.db, tenantId, data, mime)).id }),
    get: async (tenantId, key) => {
      const blob = await getBlob(ctx.db, tenantId, key);
      return blob ? { data: blob.data, mime: blob.mime } : null;
    },
    delete: async (tenantId, key) => {
      await deleteBlob(ctx.db, tenantId, key);
    },
  };
}

const err = (code: string, message: string, status: number) =>
  Response.json({ error: { code, message, details: null } }, { status });

function mimeAllowed(mime: string, allowed: string[]): boolean {
  return allowed.some((entry) => (entry.endsWith('/') ? mime.startsWith(entry) : mime === entry));
}

function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  return base.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 120) || 'file';
}

export function mediaUrl(docId: string, filename: string): string {
  return `/media/${docId}/${encodeURIComponent(filename)}`;
}

// ---- image width variants ----------------------------------------------------
// Allow-list only: the URL is the CDN cache key, so an open `w` would be an
// amplification vector (unbounded derivative storage + CPU per unique value).
export const VARIANT_WIDTHS = [320, 480, 960, 1600] as const;

/** Deterministic lookup key for a derived variant: sha256(blobKey + width). */
function variantCacheKey(blobKey: string, width: number): string {
  return createHash('sha256').update(`${blobKey}:${width}`).digest('hex');
}

// sharp is an OPTIONAL peer dependency: loaded lazily, and its absence must
// never 500 — the original bytes serve with `x-apick-variant: unavailable`.
type SharpFactory = typeof import('sharp').default;
let sharpFactory: SharpFactory | null | undefined;
async function loadSharp(): Promise<SharpFactory | null> {
  if (sharpFactory === undefined) {
    try {
      sharpFactory = (await import('sharp')).default;
    } catch {
      sharpFactory = null;
    }
  }
  return sharpFactory;
}

export function mediaRoutes(app: Hono<HonoEnv>, box: { ctx: CmsContext | null }, options: MediaOptions): void {
  const storageOf = (ctx: CmsContext): MediaStorage => options.storage ?? databaseStorage(ctx);

  // Variant lookup cache: sha256(blobKey+width) -> derived blob key. In-memory
  // and per-process by design (the blob store has no metadata field to query
  // by); a replica that hasn't derived a variant simply re-derives on miss —
  // idempotent-ish, at the cost of a possible duplicate derivative blob.
  const variantKeys = new Map<string, string>();
  const VARIANT_CACHE_MAX = 10_000;
  const rememberVariant = (cacheKey: string, blobId: string): void => {
    if (variantKeys.size >= VARIANT_CACHE_MAX) {
      const oldest = variantKeys.keys().next().value;
      if (oldest !== undefined) variantKeys.delete(oldest);
    }
    variantKeys.set(cacheKey, blobId);
  };

  // ---- upload (editors and up) -------------------------------------------------
  app.post('/admin/api/media', async (c) => {
    const ctx = requireCtx(box);
    const access = c.get('access');
    assertCan(access, 'create', `doc:${MEDIA_COLLECTION}`);

    const body = await c.req.parseBody();
    const file = body['file'];
    if (!(file instanceof File)) return err('bad_request', 'multipart field "file" is required', 400);
    if (file.size > options.maxFileSizeMB * 1024 * 1024) {
      return err('validation', `File exceeds the ${options.maxFileSizeMB}MB limit`, 422);
    }
    const mime = file.type || 'application/octet-stream';
    if (!mimeAllowed(mime, options.allowedTypes)) {
      return err('validation', `File type "${mime}" is not allowed`, 422);
    }
    const filename = safeFilename(file.name);
    const alt = typeof body['alt'] === 'string' ? body['alt'] : '';
    const data = Buffer.from(await file.arrayBuffer());

    const stored = await storageOf(ctx).put(access.tenantId, data, mime);
    // Create the metadata doc AS THE CALLER (attribution + their permissions).
    const token = c.req.header('authorization')!.slice(7).trim();
    const res = await ctx.fetchApi(`/v1/collections/${MEDIA_COLLECTION}/docs`, {
      method: 'POST',
      token,
      body: JSON.stringify({
        data: { filename, alt, mime, size: file.size, blobKey: stored.key },
        publish: true,
      }),
    });
    if (!res.ok) {
      await storageOf(ctx).delete(access.tenantId, stored.key).catch(() => {});
      return new Response(res.body, res);
    }
    const created = (await res.json()) as { data: { docId: string } };
    return c.json(
      { data: { docId: created.data.docId, url: mediaUrl(created.data.docId, filename), filename, mime, size: file.size, alt } },
      201,
    );
  });

  // ---- delete (doc + bytes) ------------------------------------------------------
  app.delete('/admin/api/media/:docId', async (c) => {
    const ctx = requireCtx(box);
    const access = c.get('access');
    assertCan(access, 'delete', `doc:${MEDIA_COLLECTION}`);
    const docId = c.req.param('docId');

    const lookup = await ctx.fetchApi(
      `/v1/collections/${MEDIA_COLLECTION}/docs/${docId}?status=draft&fields=blobKey`,
      { token: ctx.internalToken },
    );
    if (!lookup.ok) return new Response(lookup.body, lookup);
    const doc = (await lookup.json()) as { data: { data: { blobKey?: string } } };

    const token = c.req.header('authorization')!.slice(7).trim();
    const del = await ctx.fetchApi(`/v1/collections/${MEDIA_COLLECTION}/docs/${docId}`, { method: 'DELETE', token });
    if (!del.ok) return new Response(del.body, del);
    if (doc.data.data.blobKey) {
      const blobKey = doc.data.data.blobKey;
      await storageOf(ctx).delete(access.tenantId, blobKey).catch(() => {});
      // Best-effort reclaim of derived variants this process knows about.
      for (const width of VARIANT_WIDTHS) {
        const cacheKey = variantCacheKey(blobKey, width);
        const variantId = variantKeys.get(cacheKey);
        if (variantId) {
          variantKeys.delete(cacheKey);
          await storageOf(ctx).delete(access.tenantId, variantId).catch(() => {});
        }
      }
    }
    return c.json({ data: { deleted: true } });
  });

  // ---- public serving --------------------------------------------------------------
  // Published media only, resolved through the anonymous API view (publicRead),
  // bytes streamed with hardened headers (nosniff + CSP sandbox neuter SVG/HTML).
  // Optional `?w=320|480|960|1600` (allow-list) serves a resized image variant.
  app.get('/media/:docId/:filename', async (c) => {
    const ctx = requireCtx(box);
    const docId = c.req.param('docId');
    const lookup = await ctx.fetchApi(`/v1/collections/${MEDIA_COLLECTION}/docs/${docId}`);
    if (!lookup.ok) return err('not_found', 'Media not found', 404);
    const doc = (await lookup.json()) as { data: { data: { blobKey?: string; mime?: string; filename?: string } } };
    const blobKey = doc.data.data.blobKey;
    if (!blobKey) return err('not_found', 'Media not found', 404);
    const docMime = doc.data.data.mime ?? '';

    const wParam = c.req.query('w');
    let width: number | null = null;
    if (wParam !== undefined) {
      width = Number(wParam);
      if (!(VARIANT_WIDTHS as readonly number[]).includes(width)) {
        return err('bad_request', `Unsupported width; allowed values: ${VARIANT_WIDTHS.join(', ')}`, 400);
      }
      if (!docMime.startsWith('image/')) {
        return err('bad_request', 'Width variants are only available for images', 400);
      }
    }

    // Variant URLs are their own immutable cache keys, so the etag carries the width.
    const etag = width === null ? `"${blobKey}"` : `"${blobKey}:w${width}"`;
    if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304 });

    const serve = (data: Buffer, mime: string, extra: Record<string, string> = {}): Response =>
      new Response(new Uint8Array(data), {
        headers: {
          'content-type': mime,
          'content-length': String(data.length),
          etag,
          'cache-control': 'public, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox",
          'content-disposition': `inline; filename="${safeFilename(doc.data.data.filename ?? 'file')}"`,
          ...extra,
        },
      });

    // gif is passthrough-skipped (sharp would flatten animation frames).
    if (width !== null && docMime !== 'image/gif') {
      const sharp = await loadSharp();
      if (sharp) {
        const cacheKey = variantCacheKey(blobKey, width);
        const cachedId = variantKeys.get(cacheKey);
        if (cachedId) {
          const cached = await storageOf(ctx).get(ctx.tenantId, cachedId);
          if (cached) return serve(cached.data, cached.mime);
          variantKeys.delete(cacheKey); // stale entry (bytes reclaimed) → re-derive
        }
        const original = await storageOf(ctx).get(ctx.tenantId, blobKey);
        if (!original) return err('not_found', 'Media bytes missing', 404);
        let derived: Buffer | null = null;
        try {
          // Keep the input format; never upscale (the URL still resolves).
          derived = await sharp(original.data).resize({ width, withoutEnlargement: true }).toBuffer();
        } catch {
          derived = null; // undecodable "image" — fall back to the original, never 500
        }
        if (derived) {
          const stored = await storageOf(ctx).put(ctx.tenantId, derived, original.mime);
          rememberVariant(cacheKey, stored.key);
          return serve(derived, original.mime);
        }
        return serve(original.data, original.mime, { 'x-apick-variant': 'unavailable' });
      }
      // sharp not installed → serve the original, flagged, never 500.
      const blob = await storageOf(ctx).get(ctx.tenantId, blobKey);
      if (!blob) return err('not_found', 'Media bytes missing', 404);
      return serve(blob.data, blob.mime, { 'x-apick-variant': 'unavailable' });
    }

    const blob = await storageOf(ctx).get(ctx.tenantId, blobKey);
    if (!blob) return err('not_found', 'Media bytes missing', 404);
    return serve(blob.data, blob.mime, width !== null ? { 'x-apick-variant': 'passthrough' } : {});
  });
}
