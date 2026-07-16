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

export function mediaRoutes(app: Hono<HonoEnv>, box: { ctx: CmsContext | null }, options: MediaOptions): void {
  const storageOf = (ctx: CmsContext): MediaStorage => options.storage ?? databaseStorage(ctx);

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
      await storageOf(ctx).delete(access.tenantId, doc.data.data.blobKey).catch(() => {});
    }
    return c.json({ data: { deleted: true } });
  });

  // ---- public serving --------------------------------------------------------------
  // Published media only, resolved through the anonymous API view (publicRead),
  // bytes streamed with hardened headers (nosniff + CSP sandbox neuter SVG/HTML).
  app.get('/media/:docId/:filename', async (c) => {
    const ctx = requireCtx(box);
    const docId = c.req.param('docId');
    const lookup = await ctx.fetchApi(`/v1/collections/${MEDIA_COLLECTION}/docs/${docId}`);
    if (!lookup.ok) return err('not_found', 'Media not found', 404);
    const doc = (await lookup.json()) as { data: { data: { blobKey?: string; mime?: string; filename?: string } } };
    const blobKey = doc.data.data.blobKey;
    if (!blobKey) return err('not_found', 'Media not found', 404);

    const etag = `"${blobKey}"`;
    if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304 });

    const blob = await storageOf(ctx).get(ctx.tenantId, blobKey);
    if (!blob) return err('not_found', 'Media bytes missing', 404);
    return new Response(new Uint8Array(blob.data), {
      headers: {
        'content-type': blob.mime,
        'content-length': String(blob.data.length),
        etag,
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'content-disposition': `inline; filename="${safeFilename(doc.data.data.filename ?? 'file')}"`,
      },
    });
  });
}
