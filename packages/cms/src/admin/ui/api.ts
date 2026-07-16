/** Admin SPA API client — a plain consumer of core's REST API. */

const TOKEN_KEY = 'apickAdminToken';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

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
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = getToken();
  if (token) headers['authorization'] = `Bearer ${token}`;
  const res = await fetch(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  if (res.status === 401 && !path.startsWith('/admin/api/')) {
    clearToken();
    window.location.href = '/admin/login';
    throw new RequestError(401, { code: 'unauthorized', message: 'Session expired', details: null });
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new RequestError(res.status, json?.error ?? { code: 'error', message: `HTTP ${res.status}`, details: null });
  }
  return json as T;
}

export const get = <T = any>(path: string) => api<T>('GET', path);
export const post = <T = any>(path: string, body?: unknown) => api<T>('POST', path, body);
export const patch = <T = any>(path: string, body?: unknown) => api<T>('PATCH', path, body);
export const del = <T = any>(path: string) => api<T>('DELETE', path);

// ---- schema cache -----------------------------------------------------------

export interface FieldDef {
  type: string;
  required?: boolean;
  private?: boolean;
  unique?: boolean;
  immutable?: boolean;
  default?: unknown;
  description?: string;
  values?: string[];
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  of?: FieldDef;
  fields?: Record<string, FieldDef>;
  to?: string;
  many?: boolean;
  variants?: Record<string, Record<string, FieldDef>>;
}

export interface CollectionInfo {
  key: string;
  description: string | null;
  fields: Record<string, FieldDef> | null; // null = not writable by this user
}

let collectionsCache: CollectionInfo[] | null = null;

export async function loadCollections(force = false): Promise<CollectionInfo[]> {
  if (collectionsCache && !force) return collectionsCache;
  const list = await get<{ data: Array<{ key: string; description: string | null }> }>('/v1/collections');
  const out: CollectionInfo[] = [];
  for (const col of list.data) {
    try {
      const schema = await get<{ data: { fields?: Record<string, FieldDef> } }>(`/v1/collections/${col.key}/schema`);
      out.push({ key: col.key, description: col.description, fields: schema.data.fields ?? null });
    } catch {
      out.push({ key: col.key, description: col.description, fields: null });
    }
  }
  collectionsCache = out;
  return out;
}

export function invalidateCollections(): void {
  collectionsCache = null;
}

/** First human-friendly text field of a collection (for titles/labels). */
export function labelField(fields: Record<string, FieldDef> | null): string | null {
  if (!fields) return null;
  for (const [key, def] of Object.entries(fields)) {
    if (def.type === 'text' && !def.private) return key;
  }
  return null;
}

export function docLabel(fields: Record<string, FieldDef> | null, doc: { docId: string; data: Record<string, unknown> }): string {
  const field = labelField(fields);
  const value = field ? doc.data[field] : null;
  return typeof value === 'string' && value.trim() ? value : doc.docId.slice(0, 8);
}

// ---- session ------------------------------------------------------------------

export interface Me {
  docId: string;
  email: string;
  name: string;
  role: 'admin' | 'editor' | 'viewer';
}

export async function fetchMe(): Promise<Me | null> {
  if (!getToken()) return null;
  try {
    const res = await get<{ data: Me }>('/admin/api/me');
    return res.data;
  } catch {
    return null;
  }
}

export interface AdminStatus {
  needsSetup: boolean;
  site: { title: string };
  adminNav: Array<{ label: string; href: string }>;
  version: string;
}

export function fetchStatus(): Promise<AdminStatus> {
  return get<AdminStatus>('/admin/api/status');
}
