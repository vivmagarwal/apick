/**
 * Typed API client — the SPA is a plain consumer of core's REST API plus the
 * CMS's /admin/api endpoints. Every call an agent could make with the same
 * token, this client makes; nothing here is privileged.
 */
import type {
  AdminStatus,
  ApiKeyRow,
  CmsUser,
  CollectionInfo,
  DeliveryRow,
  Envelope,
  EventRow,
  Me,
  MediaItem,
  SchemaInfo,
  SearchGroup,
  VersionDetail,
  VersionSummary,
  WebhookRow,
} from './types';

// ---- token ------------------------------------------------------------------

const TOKEN_KEY = 'apick-admin-token';
/** The pre-rebuild admin stored its token under this key — migrate on read. */
const LEGACY_TOKEN_KEY = 'apickAdminToken';

export function getToken(): string | null {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) return token;
  const legacy = localStorage.getItem(LEGACY_TOKEN_KEY);
  if (legacy) {
    localStorage.setItem(TOKEN_KEY, legacy);
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    return legacy;
  }
  return null;
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(LEGACY_TOKEN_KEY);
}

// ---- request core -------------------------------------------------------------

export interface ApiError {
  code: string;
  message: string;
  details: unknown;
}

export class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly error: ApiError,
  ) {
    super(error.message);
    this.name = 'RequestError';
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = getToken();
  if (token) headers['authorization'] = `Bearer ${token}`;
  const res = await fetch(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  // Expired session anywhere except the auth endpoints themselves → back to login.
  if (res.status === 401 && !path.startsWith('/admin/api/')) {
    clearToken();
    window.location.href = '/admin/login';
    throw new RequestError(401, { code: 'unauthorized', message: 'Session expired', details: null });
  }
  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = (json as { error?: ApiError } | null)?.error;
    throw new RequestError(res.status, err ?? { code: 'error', message: `HTTP ${res.status}`, details: null });
  }
  return json as T;
}

const get = <T>(path: string) => request<T>('GET', path);
const post = <T>(path: string, body?: unknown) => request<T>('POST', path, body);
const patch = <T>(path: string, body?: unknown) => request<T>('PATCH', path, body);
const del = <T>(path: string, body?: unknown) => request<T>('DELETE', path, body);

const enc = encodeURIComponent;

// ---- session -------------------------------------------------------------------

export function adminStatus(): Promise<AdminStatus> {
  return get<AdminStatus>('/admin/api/status');
}

export async function login(email: string, password: string): Promise<Me> {
  const res = await post<{ data: { token: string; user: Me } }>('/admin/api/login', { email, password });
  setToken(res.data.token);
  return res.data.user;
}

export async function setup(name: string, email: string, password: string): Promise<Me> {
  const res = await post<{ data: { token: string; user: Me } }>('/admin/api/setup', { name, email, password });
  setToken(res.data.token);
  return res.data.user;
}

export async function me(): Promise<Me> {
  const res = await get<{ data: Me }>('/admin/api/me');
  return res.data;
}

/** Sessions are stateless JWT-style tokens — logout is client-side. */
export function logout(): void {
  clearToken();
}

// ---- collections / schema --------------------------------------------------------

export async function collections(): Promise<CollectionInfo[]> {
  const res = await get<{ data: CollectionInfo[] }>('/v1/collections');
  return res.data;
}

export async function schema(key: string): Promise<SchemaInfo> {
  const res = await get<{ data: SchemaInfo }>(`/v1/collections/${enc(key)}/schema`);
  return res.data;
}

// ---- documents ---------------------------------------------------------------------

export interface ListDocsParams {
  search?: string;
  filter?: unknown;
  sort?: string;
  page?: number;
  pageSize?: number;
  status?: 'draft' | 'published';
  locale?: string;
  populate?: string[];
  fields?: string[];
  count?: boolean;
}

export interface ListResult {
  data: Envelope[];
  meta: { page: number; pageSize: number; total?: number };
}

function listQuery(params: ListDocsParams): string {
  const q = new URLSearchParams();
  if (params.search) q.set('search', params.search);
  if (params.filter !== undefined) q.set('filter', JSON.stringify(params.filter));
  if (params.sort) q.set('sort', params.sort);
  if (params.page !== undefined) q.set('page', String(params.page));
  if (params.pageSize !== undefined) q.set('pageSize', String(params.pageSize));
  if (params.status) q.set('status', params.status);
  if (params.locale) q.set('locale', params.locale);
  if (params.populate?.length) q.set('populate', params.populate.join(','));
  if (params.fields?.length) q.set('fields', params.fields.join(','));
  if (params.count) q.set('count', 'true');
  const s = q.toString();
  return s ? `?${s}` : '';
}

export function listDocs(collection: string, params: ListDocsParams = {}): Promise<ListResult> {
  return get<ListResult>(`/v1/collections/${enc(collection)}/docs${listQuery(params)}`);
}

export async function getDoc(
  collection: string,
  docId: string,
  params: Pick<ListDocsParams, 'status' | 'locale' | 'populate' | 'fields'> = {},
): Promise<Envelope> {
  const res = await get<{ data: Envelope }>(`/v1/collections/${enc(collection)}/docs/${enc(docId)}${listQuery(params)}`);
  return res.data;
}

export async function createDoc(
  collection: string,
  data: Record<string, unknown>,
  opts: { publish?: boolean; docId?: string; locale?: string } = {},
): Promise<Envelope> {
  const res = await post<{ data: Envelope }>(`/v1/collections/${enc(collection)}/docs`, {
    data,
    ...(opts.publish ? { publish: true } : {}),
    ...(opts.docId ? { docId: opts.docId } : {}),
    ...(opts.locale ? { locale: opts.locale } : {}),
  });
  return res.data;
}

/** RFC 7386 merge-patch: null removes a key, objects merge deep, arrays replace. */
export async function patchDoc(collection: string, docId: string, data: Record<string, unknown>): Promise<Envelope> {
  // The server's body key is "patch" (see packages/apick/src/http/docs.ts).
  const res = await patch<{ data: Envelope }>(`/v1/collections/${enc(collection)}/docs/${enc(docId)}`, { patch: data });
  return res.data;
}

export async function deleteDoc(collection: string, docId: string): Promise<void> {
  await del<{ data: { deleted: boolean } }>(`/v1/collections/${enc(collection)}/docs/${enc(docId)}`);
}

// ---- publish lifecycle ---------------------------------------------------------------

/** Publish now, or pass `at` (ISO datetime) to schedule a future publish. */
export async function publishDoc(collection: string, docId: string, at?: string): Promise<Envelope> {
  const res = await post<{ data: Envelope }>(
    `/v1/collections/${enc(collection)}/docs/${enc(docId)}/publish`,
    at ? { at } : undefined,
  );
  return res.data;
}

export async function unpublishDoc(collection: string, docId: string): Promise<Envelope> {
  const res = await post<{ data: Envelope }>(`/v1/collections/${enc(collection)}/docs/${enc(docId)}/unpublish`);
  return res.data;
}

export async function cancelSchedule(collection: string, docId: string): Promise<Envelope> {
  const res = await del<{ data: Envelope }>(`/v1/collections/${enc(collection)}/docs/${enc(docId)}/publish-schedule`);
  return res.data;
}

// ---- versions -------------------------------------------------------------------------

export async function listVersions(collection: string, docId: string): Promise<VersionSummary[]> {
  const res = await get<{ data: VersionSummary[] }>(`/v1/collections/${enc(collection)}/docs/${enc(docId)}/versions`);
  return res.data;
}

export async function getVersion(collection: string, docId: string, version: number): Promise<VersionDetail> {
  const res = await get<{ data: VersionDetail }>(`/v1/collections/${enc(collection)}/docs/${enc(docId)}/versions/${version}`);
  return res.data;
}

export async function restoreVersion(collection: string, docId: string, version: number): Promise<Envelope> {
  const res = await post<{ data: Envelope }>(`/v1/collections/${enc(collection)}/docs/${enc(docId)}/versions/${version}/restore`);
  return res.data;
}

// ---- cross-collection search ------------------------------------------------------------

export async function searchAll(
  q: string,
  opts: { status?: 'draft' | 'published'; collections?: string[]; pageSize?: number } = {},
): Promise<SearchGroup[]> {
  const query = new URLSearchParams({ q });
  if (opts.status) query.set('status', opts.status);
  if (opts.collections?.length) query.set('collections', opts.collections.join(','));
  if (opts.pageSize !== undefined) query.set('pageSize', String(opts.pageSize));
  const res = await get<{ data: SearchGroup[] }>(`/v1/search?${query}`);
  return res.data;
}

// ---- preview -------------------------------------------------------------------------------

/** Mint a draft-preview URL for a document; null when it has no site page. */
export async function previewUrl(collection: string, docId: string): Promise<{ url: string; path: string } | null> {
  try {
    const res = await post<{ data: { url: string; path: string } }>('/admin/api/preview', { collection, docId });
    return res.data;
  } catch (err) {
    if (err instanceof RequestError && err.status === 404) return null;
    throw err;
  }
}

// ---- events (audit feed — admins only) --------------------------------------------------------

export async function events(opts: { types?: string[]; afterSeq?: string; limit?: number } = {}): Promise<EventRow[]> {
  const q = new URLSearchParams();
  if (opts.types?.length) q.set('types', opts.types.join(','));
  if (opts.afterSeq) q.set('afterSeq', opts.afterSeq);
  if (opts.limit !== undefined) q.set('limit', String(opts.limit));
  const s = q.toString();
  const res = await get<{ data: EventRow[] }>(`/v1/events${s ? `?${s}` : ''}`);
  return res.data;
}

// ---- users (/admin/api/users — admins only) ----------------------------------------------------

export async function listUsers(): Promise<CmsUser[]> {
  const res = await get<{ data: CmsUser[] }>('/admin/api/users');
  return res.data;
}

export async function createUser(user: { name: string; email: string; role: string; password: string }): Promise<CmsUser> {
  const res = await post<{ data: CmsUser }>('/admin/api/users', user);
  return res.data;
}

export async function updateUser(
  docId: string,
  changes: { name?: string; email?: string; role?: string; password?: string },
): Promise<CmsUser> {
  const res = await patch<{ data: CmsUser }>(`/admin/api/users/${enc(docId)}`, changes);
  return res.data;
}

export async function deleteUser(docId: string): Promise<void> {
  await del<{ data: { deleted: boolean } }>(`/admin/api/users/${enc(docId)}`);
}

// ---- API keys (/v1/keys) -----------------------------------------------------------------------

export async function listKeys(): Promise<ApiKeyRow[]> {
  const res = await get<{ data: ApiKeyRow[] }>('/v1/keys');
  return res.data;
}

/** Returns the full token — shown exactly once. */
export async function createKey(body: { name: string; role: string }): Promise<{ token: string }> {
  const res = await post<{ data: { token: string } }>('/v1/keys', body);
  return res.data;
}

export async function revokeKey(id: string): Promise<void> {
  await del<{ data: { revoked: boolean } }>(`/v1/keys/${enc(id)}`);
}

// ---- webhooks (/v1/webhooks) ---------------------------------------------------------------------

export async function listWebhooks(): Promise<WebhookRow[]> {
  const res = await get<{ data: WebhookRow[] }>('/v1/webhooks');
  return res.data;
}

/** Returns the signing secret — shown exactly once. */
export async function createWebhook(body: { name: string; url: string; events: string[] }): Promise<{ id: string; secret: string }> {
  const res = await post<{ data: { id: string; secret: string } }>('/v1/webhooks', body);
  return res.data;
}

export async function updateWebhook(id: string, changes: Partial<Pick<WebhookRow, 'name' | 'url' | 'events' | 'enabled'>>): Promise<void> {
  await patch<{ data: unknown }>(`/v1/webhooks/${enc(id)}`, changes);
}

export async function deleteWebhook(id: string): Promise<void> {
  await del<{ data: { deleted: boolean } }>(`/v1/webhooks/${enc(id)}`);
}

export async function webhookDeliveries(id: string): Promise<DeliveryRow[]> {
  const res = await get<{ data: DeliveryRow[] }>(`/v1/webhooks/${enc(id)}/deliveries`);
  return res.data;
}

export async function replayDelivery(deliveryId: string): Promise<void> {
  await post<{ data: { replayed: boolean } }>(`/v1/deliveries/${enc(deliveryId)}/replay`);
}

// ---- media ------------------------------------------------------------------------------------------
// Metadata docs live in the `media` collection; bytes upload via multipart to
// /admin/api/media; files serve from /media/:docId/:filename (see ui-legacy/media.ts).

export function mediaUrl(docId: string, filename: string): string {
  return `/media/${docId}/${enc(filename)}`;
}

interface MediaDocData {
  filename: string;
  mime: string;
  size: number;
  alt?: string;
}

function toMediaItem(env: Envelope): MediaItem {
  const d = env.data as unknown as MediaDocData;
  return {
    docId: env.docId,
    url: mediaUrl(env.docId, d.filename),
    filename: d.filename,
    mime: d.mime,
    size: d.size,
    alt: d.alt ?? '',
  };
}

export async function listMedia(
  opts: { page?: number; pageSize?: number; search?: string } = {},
): Promise<{ items: MediaItem[]; total: number }> {
  const params: ListDocsParams = {
    status: 'draft',
    sort: '-createdAt',
    page: opts.page ?? 1,
    pageSize: opts.pageSize ?? 24,
    count: true,
    ...(opts.search ? { filter: { filename: { $icontains: opts.search } } } : {}),
  };
  const res = await listDocs('media', params);
  return { items: res.data.map(toMediaItem), total: res.meta.total ?? res.data.length };
}

/** POST multipart to /admin/api/media; returns the created item. */
export async function uploadMedia(file: File, alt = ''): Promise<MediaItem> {
  const body = new FormData();
  body.set('file', file);
  if (alt) body.set('alt', alt);
  const token = getToken();
  const res = await fetch('/admin/api/media', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body,
  });
  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = (json as { error?: ApiError } | null)?.error;
    throw new RequestError(res.status, err ?? { code: 'error', message: `HTTP ${res.status}`, details: null });
  }
  return (json as { data: MediaItem }).data;
}

/** Update media metadata (alt text); republishes so the change is live. */
export async function patchMedia(docId: string, changes: { alt?: string }): Promise<MediaItem> {
  const updated = await patchDoc('media', docId, changes);
  const published = await publishDoc('media', docId);
  return toMediaItem({ ...published, data: { ...updated.data, ...published.data } });
}

/** Deletes the metadata doc AND the stored bytes. */
export async function deleteMedia(docId: string): Promise<void> {
  await del<{ data: { deleted: boolean } }>(`/admin/api/media/${enc(docId)}`);
}
