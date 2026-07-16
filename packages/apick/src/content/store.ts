import { createHash } from 'node:crypto';
import type { Db, Queryable } from '../kernel/db.js';
import { errors } from '../kernel/errors.js';
import { appendEvent, type EventActor, type EventRow } from '../kernel/events.js';
import { isUuid, uuidv7 } from '../kernel/ids.js';
import { sql } from '../kernel/sql.js';
import { extractRefs, getAtPath, redactPrivate, type CompiledCollection } from '../schema/compile.js';

/**
 * The write path. Every mutation is:
 *   append-only version row → head update on apick_docs → derived indexes
 *   (uniques, edges) → event, all in ONE transaction (transactional outbox).
 *
 * Publish is a pointer/data copy on the head row — never a clone of the
 * document identity, so unique stays enforceable per logical document and
 * writes stay O(1) rows (Strapi clones rows on publish; that decision is the
 * root of its unique-crash class and its ×5 write amplification).
 */

export interface DocRow {
  tenant_id: string;
  collection: string;
  doc_id: string;
  locale: string;
  draft_version: number;
  published_version: number | null;
  draft_data: Record<string, unknown>;
  published_data: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
  published_at: Date | null;
  created_by: string | null;
}

export interface DocEnvelope {
  docId: string;
  locale: string;
  version: number;
  status: 'draft' | 'published';
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  data: Record<string, unknown>;
}

export type OnEventHook = (tx: Queryable, event: EventRow) => Promise<void>;

export interface StoreContext {
  tenantId: string;
  actor: EventActor;
  /** Runs inside the write transaction after the event is appended (webhook fan-out). */
  onEvent?: OnEventHook;
}

export const DEFAULT_LOCALE = 'default';

// -- helpers -----------------------------------------------------------------

/** RFC 7386 merge-patch: null removes a key, objects merge deep, arrays replace. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const base =
    target !== null && typeof target === 'object' && !Array.isArray(target) ? { ...(target as Record<string, unknown>) } : {};
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === null) {
      delete base[key];
    } else {
      base[key] = mergePatch(base[key], value);
    }
  }
  return base;
}

function hashValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function toEnvelope(col: CompiledCollection, row: DocRow, status: 'draft' | 'published'): DocEnvelope {
  const data = status === 'published' ? row.published_data! : row.draft_data;
  return {
    docId: row.doc_id,
    locale: row.locale,
    version: status === 'published' ? row.published_version! : row.draft_version,
    status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    publishedAt: row.published_at ? row.published_at.toISOString() : null,
    data: redactPrivate(col, data),
  };
}

async function loadHead(tx: Queryable, tenantId: string, collection: string, docId: string, locale: string, forUpdate = false): Promise<DocRow | null> {
  const { rows } = await tx.query<DocRow>(sql`
    select * from apick_docs
    where tenant_id = ${tenantId} and collection = ${collection} and doc_id = ${docId} and locale = ${locale}
    ${forUpdate ? sql.raw('for update') : sql.raw('')}
  `);
  return rows[0] ?? null;
}

async function rewriteUniques(tx: Queryable, col: CompiledCollection, tenantId: string, docId: string, locale: string, data: Record<string, unknown>): Promise<void> {
  await tx.query(sql`
    delete from apick_uniques
    where tenant_id = ${tenantId} and collection = ${col.key} and doc_id = ${docId} and locale = ${locale}
  `);
  for (const { path } of col.uniquePaths) {
    const value = getAtPath(data, path);
    if (value === undefined || value === null) continue;
    const { rows } = await tx.query<{ doc_id: string }>(sql`
      insert into apick_uniques (tenant_id, collection, field, locale, value_hash, doc_id)
      values (${tenantId}, ${col.key}, ${path}, ${locale}, ${hashValue(value)}, ${docId})
      on conflict (tenant_id, collection, field, locale, value_hash) do nothing
      returning doc_id
    `);
    if (rows.length === 0) {
      throw errors.conflict(`Value for unique field "${path}" already exists in "${col.key}"`, { field: path });
    }
  }
}

async function rewriteEdges(tx: Queryable, col: CompiledCollection, tenantId: string, docId: string, locale: string, head: 'draft' | 'published', data: Record<string, unknown>): Promise<void> {
  await tx.query(sql`
    delete from apick_edges
    where tenant_id = ${tenantId} and collection = ${col.key} and doc_id = ${docId} and locale = ${locale} and head = ${head}
  `);
  const refs = extractRefs(col, data);
  const counters = new Map<string, number>();
  for (const ref of refs) {
    const position = counters.get(ref.field) ?? 0;
    counters.set(ref.field, position + 1);
    await tx.query(sql`
      insert into apick_edges (tenant_id, collection, doc_id, locale, head, field, position, to_collection, to_doc_id)
      values (${tenantId}, ${col.key}, ${docId}, ${locale}, ${head}, ${ref.field}, ${position}, ${ref.to}, ${ref.docId})
    `);
  }
}

async function assertRefTargetsExist(tx: Queryable, col: CompiledCollection, tenantId: string, data: Record<string, unknown>): Promise<void> {
  const refs = extractRefs(col, data);
  for (const ref of refs) {
    if (!isUuid(ref.docId)) {
      throw errors.validation(`Relation "${ref.field}" has an invalid docId`, { field: ref.field });
    }
    const { rows } = await tx.query(sql`
      select 1 from apick_docs where tenant_id = ${tenantId} and collection = ${ref.to} and doc_id = ${ref.docId} limit 1
    `);
    if (rows.length === 0) {
      throw errors.validation(`Relation "${ref.field}" points to a missing ${ref.to} document`, {
        field: ref.field,
        docId: ref.docId,
      });
    }
  }
}

function assertValid(col: CompiledCollection, data: unknown): asserts data is Record<string, unknown> {
  const issues = col.validate(data);
  if (issues.length > 0) {
    throw errors.validation(`Document does not match the "${col.key}" schema`, { issues });
  }
}

async function emit(tx: Queryable, ctx: StoreContext, type: string, subject: Record<string, unknown>, payload: Record<string, unknown>): Promise<EventRow> {
  const event = await appendEvent(tx, { tenantId: ctx.tenantId, type, actor: ctx.actor, subject, payload });
  if (ctx.onEvent) await ctx.onEvent(tx, event);
  return event;
}

// -- operations ---------------------------------------------------------------

export interface CreateDocInput {
  data: Record<string, unknown>;
  locale?: string;
  docId?: string;
  /** Create and publish atomically. */
  publish?: boolean;
  /** Import escape hatch: skip relation-target existence checks. */
  validateRefs?: boolean;
}

export async function createDoc(db: Db, col: CompiledCollection, ctx: StoreContext, input: CreateDocInput): Promise<DocEnvelope> {
  const locale = input.locale ?? DEFAULT_LOCALE;
  const docId = input.docId ?? uuidv7();
  if (!isUuid(docId)) throw errors.badRequest('docId must be a uuid');

  const data: Record<string, unknown> = { ...input.data };
  for (const { field, value } of (col.defaults ?? [])) {
    if (data[field] === undefined) data[field] = value;
  }
  assertValid(col, data);

  return db.transaction(async (tx) => {
    const existing = await loadHead(tx, ctx.tenantId, col.key, docId, locale);
    if (existing) throw errors.conflict(`Document already exists`, { docId, locale });

    if (input.validateRefs !== false) await assertRefTargetsExist(tx, col, ctx.tenantId, data);

    const versionId = uuidv7();
    await tx.query(sql`
      insert into apick_doc_versions (id, tenant_id, collection, doc_id, locale, version, op, data, patch, actor)
      values (${versionId}, ${ctx.tenantId}, ${col.key}, ${docId}, ${locale}, ${1}, ${'create'}, ${JSON.stringify(data)}, ${JSON.stringify(input.data)}, ${ctx.actor.principalId})
    `);
    await tx.query(sql`
      insert into apick_docs (tenant_id, collection, doc_id, locale, draft_version_id, draft_version, draft_data, created_by)
      values (${ctx.tenantId}, ${col.key}, ${docId}, ${locale}, ${versionId}, ${1}, ${JSON.stringify(data)}, ${ctx.actor.principalId})
    `);
    await rewriteUniques(tx, col, ctx.tenantId, docId, locale, data);
    await rewriteEdges(tx, col, ctx.tenantId, docId, locale, 'draft', data);

    await emit(tx, ctx, 'doc.created', { collection: col.key, docId, locale }, { version: 1, data: redactPrivate(col, data) });

    if (input.publish) {
      await publishInTx(tx, col, ctx, docId, locale);
    }
    const row = (await loadHead(tx, ctx.tenantId, col.key, docId, locale))!;
    return toEnvelope(col, row, input.publish ? 'published' : 'draft');
  });
}

export interface PatchDocInput {
  docId: string;
  locale?: string;
  patch: Record<string, unknown>;
  /** Optimistic concurrency: reject if the current draft version differs. */
  ifVersion?: number;
  /** Create the locale variant if it does not exist yet. */
  upsertLocale?: boolean;
  /** Import escape hatch: skip relation-target existence checks. */
  validateRefs?: boolean;
}

export async function patchDoc(db: Db, col: CompiledCollection, ctx: StoreContext, input: PatchDocInput): Promise<DocEnvelope> {
  const locale = input.locale ?? DEFAULT_LOCALE;
  return db.transaction(async (tx) => {
    let row = await loadHead(tx, ctx.tenantId, col.key, input.docId, locale, true);
    if (!row) {
      if (input.upsertLocale) {
        // The document must exist in some locale; then a patch may open a new variant.
        const { rows } = await tx.query(sql`
          select 1 from apick_docs where tenant_id = ${ctx.tenantId} and collection = ${col.key} and doc_id = ${input.docId} limit 1
        `);
        if (rows.length === 0) throw errors.notFound(`Document not found`);
        const data: Record<string, unknown> = {};
        for (const { field, value } of (col.defaults ?? [])) data[field] = value;
        const merged = mergePatch(data, input.patch) as Record<string, unknown>;
        assertValid(col, merged);
        if (input.validateRefs !== false) await assertRefTargetsExist(tx, col, ctx.tenantId, merged);
        const versionId = uuidv7();
        await tx.query(sql`
          insert into apick_doc_versions (id, tenant_id, collection, doc_id, locale, version, op, data, patch, actor)
          values (${versionId}, ${ctx.tenantId}, ${col.key}, ${input.docId}, ${locale}, ${1}, ${'create'}, ${JSON.stringify(merged)}, ${JSON.stringify(input.patch)}, ${ctx.actor.principalId})
        `);
        await tx.query(sql`
          insert into apick_docs (tenant_id, collection, doc_id, locale, draft_version_id, draft_version, draft_data, created_by)
          values (${ctx.tenantId}, ${col.key}, ${input.docId}, ${locale}, ${versionId}, ${1}, ${JSON.stringify(merged)}, ${ctx.actor.principalId})
        `);
        await rewriteUniques(tx, col, ctx.tenantId, input.docId, locale, merged);
        await rewriteEdges(tx, col, ctx.tenantId, input.docId, locale, 'draft', merged);
        await emit(tx, ctx, 'doc.created', { collection: col.key, docId: input.docId, locale }, { version: 1, data: redactPrivate(col, merged) });
        row = (await loadHead(tx, ctx.tenantId, col.key, input.docId, locale))!;
        return toEnvelope(col, row, 'draft');
      }
      throw errors.notFound(`Document not found`);
    }

    if (input.ifVersion !== undefined && row.draft_version !== input.ifVersion) {
      throw errors.conflict(`Version mismatch: draft is at v${row.draft_version}`, { currentVersion: row.draft_version });
    }

    const merged = mergePatch(row.draft_data, input.patch) as Record<string, unknown>;
    for (const path of col.immutablePaths) {
      const before = getAtPath(row.draft_data, path);
      const after = getAtPath(merged, path);
      if (before !== undefined && JSON.stringify(before) !== JSON.stringify(after)) {
        throw errors.validation(`Field "${path}" is immutable`, { field: path });
      }
    }
    assertValid(col, merged);
    if (input.validateRefs !== false) await assertRefTargetsExist(tx, col, ctx.tenantId, merged);

    const version = row.draft_version + 1;
    const versionId = uuidv7();
    await tx.query(sql`
      insert into apick_doc_versions (id, tenant_id, collection, doc_id, locale, version, op, data, patch, actor)
      values (${versionId}, ${ctx.tenantId}, ${col.key}, ${input.docId}, ${locale}, ${version}, ${'patch'}, ${JSON.stringify(merged)}, ${JSON.stringify(input.patch)}, ${ctx.actor.principalId})
    `);
    await tx.query(sql`
      update apick_docs
      set draft_version_id = ${versionId}, draft_version = ${version}, draft_data = ${JSON.stringify(merged)}, updated_at = now()
      where tenant_id = ${ctx.tenantId} and collection = ${col.key} and doc_id = ${input.docId} and locale = ${locale}
    `);
    await rewriteUniques(tx, col, ctx.tenantId, input.docId, locale, merged);
    await rewriteEdges(tx, col, ctx.tenantId, input.docId, locale, 'draft', merged);

    await emit(tx, ctx, 'doc.updated', { collection: col.key, docId: input.docId, locale }, {
      version,
      patch: redactPrivate(col, input.patch),
      data: redactPrivate(col, merged),
    });

    const updated = (await loadHead(tx, ctx.tenantId, col.key, input.docId, locale))!;
    return toEnvelope(col, updated, 'draft');
  });
}

async function publishInTx(tx: Queryable, col: CompiledCollection, ctx: StoreContext, docId: string, locale: string): Promise<DocRow> {
  const row = await loadHead(tx, ctx.tenantId, col.key, docId, locale, true);
  if (!row) throw errors.notFound(`Document not found`);
  await tx.query(sql`
    update apick_docs
    set published_version_id = draft_version_id, published_version = draft_version,
        published_data = draft_data, published_at = now(), updated_at = now()
    where tenant_id = ${ctx.tenantId} and collection = ${col.key} and doc_id = ${docId} and locale = ${locale}
  `);
  await rewriteEdges(tx, col, ctx.tenantId, docId, locale, 'published', row.draft_data);
  await emit(tx, ctx, 'doc.published', { collection: col.key, docId, locale }, {
    version: row.draft_version,
    data: redactPrivate(col, row.draft_data),
  });
  return (await loadHead(tx, ctx.tenantId, col.key, docId, locale))!;
}

export async function publishDoc(db: Db, col: CompiledCollection, ctx: StoreContext, docId: string, locale = DEFAULT_LOCALE): Promise<DocEnvelope> {
  return db.transaction(async (tx) => {
    const row = await publishInTx(tx, col, ctx, docId, locale);
    return toEnvelope(col, row, 'published');
  });
}

export async function unpublishDoc(db: Db, col: CompiledCollection, ctx: StoreContext, docId: string, locale = DEFAULT_LOCALE): Promise<DocEnvelope> {
  return db.transaction(async (tx) => {
    const row = await loadHead(tx, ctx.tenantId, col.key, docId, locale, true);
    if (!row) throw errors.notFound(`Document not found`);
    await tx.query(sql`
      update apick_docs
      set published_version_id = null, published_version = null, published_data = null, published_at = null, updated_at = now()
      where tenant_id = ${ctx.tenantId} and collection = ${col.key} and doc_id = ${docId} and locale = ${locale}
    `);
    await tx.query(sql`
      delete from apick_edges
      where tenant_id = ${ctx.tenantId} and collection = ${col.key} and doc_id = ${docId} and locale = ${locale} and head = 'published'
    `);
    await emit(tx, ctx, 'doc.unpublished', { collection: col.key, docId, locale }, { version: row.draft_version });
    const updated = (await loadHead(tx, ctx.tenantId, col.key, docId, locale))!;
    return toEnvelope(col, updated, 'draft');
  });
}

export async function deleteDoc(db: Db, col: CompiledCollection, ctx: StoreContext, docId: string, locale?: string): Promise<{ deletedLocales: string[] }> {
  return db.transaction(async (tx) => {
    const conds = [sql`tenant_id = ${ctx.tenantId}`, sql`collection = ${col.key}`, sql`doc_id = ${docId}`];
    if (locale !== undefined) conds.push(sql`locale = ${locale}`);
    const where = sql.join(conds, ' and ');
    const { rows } = await tx.query<{ locale: string }>(sql`
      delete from apick_docs where ${where} returning locale
    `);
    if (rows.length === 0) throw errors.notFound(`Document not found`);
    await tx.query(sql`delete from apick_edges where ${where}`);
    await tx.query(sql`delete from apick_uniques where ${where}`);
    // Versions are retained: history and audit survive deletion.
    for (const r of rows) {
      await emit(tx, ctx, 'doc.deleted', { collection: col.key, docId, locale: r.locale }, {});
    }
    return { deletedLocales: rows.map((r) => r.locale) };
  });
}

export interface VersionSummary {
  version: number;
  op: string;
  actor: string | null;
  createdAt: string;
}

export async function listVersions(db: Queryable, col: CompiledCollection, tenantId: string, docId: string, locale = DEFAULT_LOCALE): Promise<VersionSummary[]> {
  const { rows } = await db.query<{ version: number; op: string; actor: string | null; created_at: Date }>(sql`
    select version, op, actor, created_at from apick_doc_versions
    where tenant_id = ${tenantId} and collection = ${col.key} and doc_id = ${docId} and locale = ${locale}
    order by version desc
    limit 200
  `);
  return rows.map((r) => ({ version: r.version, op: r.op, actor: r.actor, createdAt: r.created_at.toISOString() }));
}

export async function getVersion(db: Queryable, col: CompiledCollection, tenantId: string, docId: string, version: number, locale = DEFAULT_LOCALE): Promise<{ version: number; op: string; data: Record<string, unknown>; createdAt: string } | null> {
  const { rows } = await db.query<{ version: number; op: string; data: Record<string, unknown>; created_at: Date }>(sql`
    select version, op, data, created_at from apick_doc_versions
    where tenant_id = ${tenantId} and collection = ${col.key} and doc_id = ${docId} and locale = ${locale} and version = ${version}
  `);
  const row = rows[0];
  if (!row) return null;
  return { version: row.version, op: row.op, data: redactPrivate(col, row.data), createdAt: row.created_at.toISOString() };
}

/** Roll the draft back to a prior version's data (as a NEW version — history is never rewritten). */
export async function restoreVersion(db: Db, col: CompiledCollection, ctx: StoreContext, docId: string, version: number, locale = DEFAULT_LOCALE): Promise<DocEnvelope> {
  return db.transaction(async (tx) => {
    const row = await loadHead(tx, ctx.tenantId, col.key, docId, locale, true);
    if (!row) throw errors.notFound(`Document not found`);
    const { rows } = await tx.query<{ data: Record<string, unknown> }>(sql`
      select data from apick_doc_versions
      where tenant_id = ${ctx.tenantId} and collection = ${col.key} and doc_id = ${docId} and locale = ${locale} and version = ${version}
    `);
    const target = rows[0];
    if (!target) throw errors.notFound(`Version ${version} not found`);
    assertValid(col, target.data);

    const newVersion = row.draft_version + 1;
    const versionId = uuidv7();
    await tx.query(sql`
      insert into apick_doc_versions (id, tenant_id, collection, doc_id, locale, version, op, data, patch, actor)
      values (${versionId}, ${ctx.tenantId}, ${col.key}, ${docId}, ${locale}, ${newVersion}, ${'restore'}, ${JSON.stringify(target.data)}, ${JSON.stringify({ restoredFrom: version })}, ${ctx.actor.principalId})
    `);
    await tx.query(sql`
      update apick_docs
      set draft_version_id = ${versionId}, draft_version = ${newVersion}, draft_data = ${JSON.stringify(target.data)}, updated_at = now()
      where tenant_id = ${ctx.tenantId} and collection = ${col.key} and doc_id = ${docId} and locale = ${locale}
    `);
    await rewriteUniques(tx, col, ctx.tenantId, docId, locale, target.data);
    await rewriteEdges(tx, col, ctx.tenantId, docId, locale, 'draft', target.data);
    await emit(tx, ctx, 'doc.restored', { collection: col.key, docId, locale }, { version: newVersion, restoredFrom: version });
    const updated = (await loadHead(tx, ctx.tenantId, col.key, docId, locale))!;
    return toEnvelope(col, updated, 'draft');
  });
}
