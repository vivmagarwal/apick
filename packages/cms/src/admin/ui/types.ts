/**
 * Domain types for the admin SPA — mirrors of what @apick/core's REST API
 * returns. FieldDef mirrors packages/apick/src/schema/fields.ts (plain
 * serializable JSON, delivered by /v1/collections/:key/schema for writers).
 */

export type FieldType =
  | 'text'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'datetime'
  | 'date'
  | 'enum'
  | 'json'
  | 'object'
  | 'list'
  | 'relation'
  | 'blocks';

export interface FieldDef {
  type: FieldType;
  required?: boolean;
  /** Never readable, filterable, sortable or populatable via any API. */
  private?: boolean;
  unique?: boolean;
  indexed?: boolean;
  /** Set at create, rejected on later patches. */
  immutable?: boolean;
  default?: unknown;
  description?: string;
  // text
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: 'markdown' | 'email' | 'uri' | 'slug' | 'image';
  // enum
  values?: string[];
  // numbers
  min?: number;
  max?: number;
  // list
  of?: FieldDef;
  // object
  fields?: Record<string, FieldDef>;
  // relation
  to?: string;
  many?: boolean;
  // blocks (dynamic zone): named variants, each an object shape
  variants?: Record<string, Record<string, FieldDef>>;
}

/** Presentation hints for schema-driven UIs (collection `admin` option). */
export interface AdminHints {
  label?: string;
  icon?: string;
  titleField?: string;
  orderField?: string;
}

/** A document envelope as returned by /v1/collections/:c/docs*. */
export interface Envelope {
  docId: string;
  locale: string;
  version: number;
  status: 'draft' | 'published';
  /** Version currently published, or null — drives draft/modified/published. */
  publishedVersion: number | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  /** When a future publish is scheduled, else null. */
  scheduledPublishAt: string | null;
  data: Record<string, unknown>;
  /** Present when ?populate= was requested: fieldKey → envelope(s). */
  populated?: Record<string, unknown>;
}

/** One row of GET /v1/collections. */
export interface CollectionInfo {
  key: string;
  description: string | null;
  publicRead: boolean;
  admin: AdminHints;
}

/** An inverse relation: who points AT this collection. */
export interface ReferencedBy {
  collection: string;
  field: string;
  many: boolean;
  admin: AdminHints;
}

/** GET /v1/collections/:key/schema. `fields` present only for writers. */
export interface SchemaInfo {
  key: string;
  description: string | null;
  admin: AdminHints;
  referencedBy: ReferencedBy[];
  readSchema?: unknown;
  writeSchema?: unknown;
  fields?: Record<string, FieldDef>;
}

// ---- session / system ---------------------------------------------------------

export interface Me {
  docId: string;
  email: string;
  name: string;
  role: 'admin' | 'editor' | 'viewer';
}

export interface AdminStatus {
  needsSetup: boolean;
  site: { title: string };
  adminNav: Array<{ label: string; href: string }>;
  version: string;
}

export interface EventRow {
  id: string;
  seq: string;
  tenant_id: string | null;
  type: string;
  actor: Record<string, unknown> | null;
  subject: Record<string, unknown>;
  payload: Record<string, unknown> | null;
  created_at: string;
}

export interface VersionSummary {
  version: number;
  op: string;
  actor: string | null;
  createdAt: string;
}

export interface VersionDetail {
  version: number;
  op: string;
  data: Record<string, unknown>;
  createdAt: string;
}

/** One collection's hits from GET /v1/search. */
export interface SearchGroup {
  collection: string;
  admin: AdminHints;
  hits: Envelope[];
}

export interface CmsUser {
  docId: string;
  email: string;
  name: string;
  role: string;
  createdAt: string;
}

export interface ApiKeyRow {
  id: string;
  prefix: string;
  label: string;
  principal_name: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface WebhookRow {
  id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
}

export interface DeliveryRow {
  id: string;
  state: string;
  attempts: number;
  last_status: number | null;
  created_at: string;
}

export interface MediaItem {
  docId: string;
  url: string;
  filename: string;
  mime: string;
  size: number;
  alt: string;
}
