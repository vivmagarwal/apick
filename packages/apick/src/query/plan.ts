import type { Db } from '../kernel/db.js';
import { errors } from '../kernel/errors.js';
import { isUuid } from '../kernel/ids.js';
import { sql, SqlFragment } from '../kernel/sql.js';
import type { AccessContext } from '../auth/rbac.js';
import { assertCan, can, conditionsFor, readableFields } from '../auth/rbac.js';
import type { Registry } from '../content/registry.js';
import { DEFAULT_LOCALE, toEnvelope, type DocEnvelope, type DocRow } from '../content/store.js';
import type { CompiledCollection } from '../schema/compile.js';
import type { FieldDef } from '../schema/fields.js';

/**
 * The query planner — the ONLY read path, and the place authorization is
 * enforced. Nothing reaches SQL unless the planner compiled it:
 *
 * - tenant scoping is a structural `tenant_id = $x` on every node
 * - a filter/sort/populate may reference only fields that exist in the schema
 *   AND are readable by the caller; private fields are rejected at plan time,
 *   which closes the filter-as-oracle CVE class Strapi reintroduced 5 times
 * - RBAC row conditions are AND-ed into the plan, including populate hops,
 *   and populated documents are rendered under the TARGET collection's policy
 * - reads are bounded: filter size, sort keys, page size and populate breadth
 *   have hard caps, so the API cannot be coerced into a pathological query
 */

const MAX_FILTER_NODES = 50;
const MAX_SORT_KEYS = 3;
const MAX_PAGE_SIZE = 100;
const MAX_POPULATE = 8;
const MAX_IN_VALUES = 100;
const POPULATE_MANY_CAP = 50;

export interface ListParams {
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
  data: Array<DocEnvelope & { populated?: Record<string, unknown> }>;
  meta: { page: number; pageSize: number; total?: number };
}

interface PlanContext {
  col: CompiledCollection;
  status: 'draft' | 'published';
  dataColumn: 'draft_data' | 'published_data';
  readable: string[] | null; // null = all non-private
}

// -- field access validation ---------------------------------------------------

function resolveFilterField(plan: PlanContext, path: string, opts: { allowPrivate?: boolean } = {}): FieldDef {
  const def = plan.col.fieldAt(path);
  if (!def || (def.private && !opts.allowPrivate)) {
    // One error shape for unknown and private: existence is not an oracle.
    throw errors.planRejected(`Cannot filter or sort on unknown field "${path}"`, { field: path });
  }
  if (!opts.allowPrivate && plan.readable !== null) {
    const top = path.split('.')[0]!;
    if (!plan.readable.includes(top)) {
      throw errors.planRejected(`Cannot filter or sort on unknown field "${path}"`, { field: path });
    }
  }
  return def;
}

function jsonPathLiteral(path: string): string {
  // Segments already validated by fieldAt (FIELD_KEY_RE per segment).
  return `'{${path.split('.').join(',')}}'`;
}

function fieldExpr(plan: PlanContext, path: string, def: FieldDef): SqlFragment {
  const extract = `${plan.dataColumn} #>> ${jsonPathLiteral(path)}`;
  switch (def.type) {
    case 'integer':
    case 'number':
      return sql.raw(`((${extract})::numeric)`);
    case 'boolean':
      return sql.raw(`((${extract})::boolean)`);
    case 'datetime':
      return sql.raw(`((${extract})::timestamptz)`);
    case 'date':
      return sql.raw(`((${extract})::date)`);
    default:
      return sql.raw(`(${extract})`);
  }
}

const SYSTEM_SORTS: Record<string, string> = {
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  publishedAt: 'published_at',
  docId: 'doc_id',
};

// -- filter compilation ----------------------------------------------------------

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function castValue(def: FieldDef, value: unknown, path: string): unknown {
  const fail = (): never => {
    throw errors.planRejected(`Invalid value for "${path}"`, { field: path });
  };
  switch (def.type) {
    case 'integer':
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? value : fail();
    case 'boolean':
      return typeof value === 'boolean' ? value : fail();
    default:
      return typeof value === 'string' ? value : fail();
  }
}

interface FilterState {
  nodes: number;
  allowPrivate: boolean;
}

function compilePredicate(plan: PlanContext, state: FilterState, path: string, predicate: unknown): SqlFragment {
  const def = resolveFilterField(plan, path, { allowPrivate: state.allowPrivate });
  // Lists of text/enum scalars support membership ($contains/$null) below,
  // exactly like to-many relations; other composite types are not filterable.
  const isScalarList = def.type === 'list' && def.of !== undefined && ['text', 'enum'].includes(def.of.type);
  if (['json', 'object', 'blocks'].includes(def.type) || (def.type === 'list' && !isScalarList)) {
    throw errors.planRejected(`Field "${path}" is not filterable`, { field: path });
  }
  const isManyRelation = def.type === 'relation' && def.many === true;

  // Shorthand: { field: value } means $eq.
  const ops =
    predicate !== null && typeof predicate === 'object' && !Array.isArray(predicate)
      ? Object.entries(predicate as Record<string, unknown>)
      : [['$eq', predicate] as [string, unknown]];

  const frags: SqlFragment[] = [];
  for (const [op, raw] of ops) {
    state.nodes++;
    if (state.nodes > MAX_FILTER_NODES) throw errors.planRejected('Filter too large');

    if (isManyRelation || isScalarList) {
      if (op === '$contains') {
        if (typeof raw !== 'string') throw errors.planRejected(`Invalid value for "${path}"`);
        frags.push(sql`jsonb_exists(${sql.raw(`${plan.dataColumn} #> ${jsonPathLiteral(path)}`)}, ${raw})`);
        continue;
      }
      if (op === '$null') {
        frags.push(sql.raw(`(${plan.dataColumn} #>> ${jsonPathLiteral(path)}) is ${raw === false ? 'not ' : ''}null`));
        continue;
      }
      throw errors.planRejected(
        `Operator ${op} is not supported on ${isManyRelation ? 'to-many relation' : 'list field'} "${path}"`,
      );
    }

    const expr = fieldExpr(plan, path, def);
    const textOnly = ['text', 'enum'].includes(def.type);
    switch (op) {
      case '$eq':
        frags.push(sql`${expr} = ${castValue(def, raw, path)}`);
        break;
      case '$ne':
        frags.push(sql`(${expr} is distinct from ${castValue(def, raw, path)})`);
        break;
      case '$gt':
      case '$gte':
      case '$lt':
      case '$lte': {
        const cmp = { $gt: '>', $gte: '>=', $lt: '<', $lte: '<=' }[op];
        frags.push(sql`${expr} ${sql.raw(cmp!)} ${castValue(def, raw, path)}`);
        break;
      }
      case '$in':
      case '$nin': {
        if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_IN_VALUES) {
          throw errors.planRejected(`$in/$nin needs 1..${MAX_IN_VALUES} values ("${path}")`);
        }
        const values = raw.map((v) => castValue(def, v, path));
        // Cast to text for the ANY comparison on text-extracted expressions.
        if (def.type === 'integer' || def.type === 'number') {
          frags.push(sql`${op === '$nin' ? sql.raw('not ') : sql.raw('')}(${expr} = any(${values}::numeric[]))`);
        } else {
          frags.push(sql`${op === '$nin' ? sql.raw('not ') : sql.raw('')}(${expr} = any(${values}))`);
        }
        break;
      }
      case '$contains':
      case '$icontains': {
        if (!textOnly || typeof raw !== 'string') throw errors.planRejected(`${op} requires a text field and string value ("${path}")`);
        frags.push(sql`${expr} ${sql.raw(op === '$icontains' ? 'ilike' : 'like')} ${'%' + escapeLike(raw) + '%'}`);
        break;
      }
      case '$startsWith': {
        if (!textOnly || typeof raw !== 'string') throw errors.planRejected(`$startsWith requires a text field ("${path}")`);
        frags.push(sql`${expr} like ${escapeLike(raw) + '%'}`);
        break;
      }
      case '$endsWith': {
        if (!textOnly || typeof raw !== 'string') throw errors.planRejected(`$endsWith requires a text field ("${path}")`);
        frags.push(sql`${expr} like ${'%' + escapeLike(raw)}`);
        break;
      }
      case '$null':
        frags.push(sql.raw(`(${plan.dataColumn} #>> ${jsonPathLiteral(path)}) is ${raw === false ? 'not ' : ''}null`));
        break;
      default:
        throw errors.planRejected(`Unknown filter operator "${op}"`);
    }
  }
  return frags.length === 1 ? frags[0]! : sql`(${sql.join(frags, ' and ')})`;
}

export function compileFilter(plan: PlanContext, filter: unknown, state: FilterState): SqlFragment {
  if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) {
    throw errors.planRejected('Filter must be an object');
  }
  const frags: SqlFragment[] = [];
  for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
    state.nodes++;
    if (state.nodes > MAX_FILTER_NODES) throw errors.planRejected('Filter too large');
    if (key === '$and' || key === '$or') {
      if (!Array.isArray(value) || value.length === 0) throw errors.planRejected(`${key} requires a non-empty array`);
      const parts = value.map((v) => compileFilter(plan, v, state));
      frags.push(sql`(${sql.join(parts, key === '$and' ? ' and ' : ' or ')})`);
    } else if (key === '$not') {
      frags.push(sql`(not ${compileFilter(plan, value, state)})`);
    } else if (key.startsWith('$')) {
      throw errors.planRejected(`Unknown filter combinator "${key}"`);
    } else {
      frags.push(compilePredicate(plan, state, key, value));
    }
  }
  if (frags.length === 0) return sql.raw('true');
  return frags.length === 1 ? frags[0]! : sql`(${sql.join(frags, ' and ')})`;
}

// -- sorting ---------------------------------------------------------------------

function compileSort(plan: PlanContext, sort: string | undefined): SqlFragment {
  if (!sort) return sql.raw('updated_at desc, doc_id asc');
  const keys = sort.split(',').map((s) => s.trim()).filter(Boolean);
  if (keys.length === 0 || keys.length > MAX_SORT_KEYS) {
    throw errors.planRejected(`Sort supports 1..${MAX_SORT_KEYS} keys`);
  }
  const parts: string[] = [];
  for (const key of keys) {
    const desc = key.startsWith('-');
    const path = desc ? key.slice(1) : key;
    if (SYSTEM_SORTS[path]) {
      parts.push(`${SYSTEM_SORTS[path]} ${desc ? 'desc' : 'asc'}`);
      continue;
    }
    const def = resolveFilterField(plan, path);
    if (['json', 'object', 'list', 'blocks', 'relation'].includes(def.type)) {
      throw errors.planRejected(`Field "${path}" is not sortable`, { field: path });
    }
    const { text } = fieldExpr(plan, path, def).compile();
    parts.push(`${text} ${desc ? 'desc' : 'asc'} nulls last`);
  }
  parts.push('doc_id asc');
  return sql.raw(parts.join(', '));
}

// -- shared plan assembly ----------------------------------------------------------

function buildPlanContext(ctx: AccessContext, col: CompiledCollection, status: 'draft' | 'published'): PlanContext {
  assertCan(ctx, status === 'draft' ? 'readDraft' : 'read', `doc:${col.key}`);
  return {
    col,
    status,
    dataColumn: status === 'draft' ? 'draft_data' : 'published_data',
    readable: readableFields(ctx, col.key),
  };
}

function rbacCondition(plan: PlanContext, ctx: AccessContext): SqlFragment {
  const conditions = conditionsFor(ctx, plan.status === 'draft' ? 'readDraft' : 'read', plan.col.key);
  if (conditions === 'unconditional') return sql.raw('true');
  // Conditions are authored by role admins: they may reference private fields.
  const state: FilterState = { nodes: 0, allowPrivate: true };
  const parts = conditions.map((c) => compileFilter(plan, c, state));
  return sql`(${sql.join(parts, ' or ')})`;
}

function projectFields(plan: PlanContext, envelope: DocEnvelope, fields: string[] | undefined): DocEnvelope {
  let data = envelope.data;
  const allowed = plan.readable;
  if (allowed !== null) {
    data = Object.fromEntries(Object.entries(data).filter(([k]) => allowed.includes(k)));
  }
  if (fields && fields.length > 0) {
    for (const f of fields) {
      if (!plan.col.fieldAt(f.split('.')[0]!)) throw errors.planRejected(`Unknown field "${f}" in fields param`);
    }
    data = Object.fromEntries(Object.entries(data).filter(([k]) => fields.some((f) => f === k || f.startsWith(`${k}.`))));
  }
  return { ...envelope, data };
}

// -- populate ------------------------------------------------------------------------

async function populateDocs(
  db: Db,
  registry: Registry,
  ctx: AccessContext,
  plan: PlanContext,
  rows: DocRow[],
  populate: string[],
  locale: string,
): Promise<Map<string, Record<string, unknown>>> {
  if (populate.length > MAX_POPULATE) throw errors.planRejected(`populate supports at most ${MAX_POPULATE} fields`);
  const out = new Map<string, Record<string, unknown>>();
  for (const row of rows) out.set(row.doc_id, {});

  for (const fieldKey of populate) {
    const def = plan.col.fieldAt(fieldKey);
    if (!def || def.type !== 'relation' || def.private) {
      throw errors.planRejected(`Cannot populate unknown relation "${fieldKey}"`, { field: fieldKey });
    }
    if (plan.readable !== null && !plan.readable.includes(fieldKey)) {
      throw errors.planRejected(`Cannot populate unknown relation "${fieldKey}"`, { field: fieldKey });
    }
    const targetCol = registry.get(def.to!).compiled;
    // The caller must be allowed to read the TARGET collection — policy at every hop.
    const targetAction = plan.status === 'draft' ? 'readDraft' : 'read';
    if (!can(ctx, targetAction, `doc:${targetCol.key}`)) {
      throw errors.forbidden(`Missing permission: ${targetAction} on doc:${targetCol.key}`);
    }
    const targetPlan = buildPlanContext(ctx, targetCol, plan.status);

    const wanted = new Set<string>();
    for (const row of rows) {
      const value = (plan.status === 'draft' ? row.draft_data : row.published_data)?.[fieldKey];
      if (def.many && Array.isArray(value)) {
        for (const id of value.slice(0, POPULATE_MANY_CAP)) if (typeof id === 'string' && isUuid(id)) wanted.add(id);
      } else if (typeof value === 'string' && isUuid(value)) {
        wanted.add(value);
      }
    }

    const found = new Map<string, DocEnvelope>();
    if (wanted.size > 0) {
      const statusCond = plan.status === 'published' ? sql.raw('published_version is not null') : sql.raw('true');
      const { rows: targets } = await db.query<DocRow>(sql`
        select * from apick_docs
        where tenant_id = ${ctx.tenantId} and collection = ${targetCol.key}
          and doc_id = any(${[...wanted]}) and locale = ${locale}
          and ${statusCond} and ${rbacCondition(targetPlan, ctx)}
      `);
      for (const t of targets) {
        found.set(t.doc_id, projectFields(targetPlan, toEnvelope(targetCol, t, plan.status), undefined));
      }
    }

    for (const row of rows) {
      const value = (plan.status === 'draft' ? row.draft_data : row.published_data)?.[fieldKey];
      const slot = out.get(row.doc_id)!;
      if (def.many) {
        const ids = Array.isArray(value) ? value.slice(0, POPULATE_MANY_CAP) : [];
        slot[fieldKey] = ids.map((id) => (typeof id === 'string' ? (found.get(id) ?? null) : null));
      } else {
        slot[fieldKey] = typeof value === 'string' ? (found.get(value) ?? null) : null;
      }
    }
  }
  return out;
}

// -- public API -----------------------------------------------------------------------

export async function listDocs(db: Db, registry: Registry, ctx: AccessContext, collectionKey: string, params: ListParams): Promise<ListResult> {
  const col = registry.get(collectionKey).compiled;
  const status = params.status ?? 'published';
  const plan = buildPlanContext(ctx, col, status);
  const locale = params.locale ?? DEFAULT_LOCALE;

  const pageSize = Math.min(Math.max(params.pageSize ?? 25, 1), MAX_PAGE_SIZE);
  const page = Math.max(params.page ?? 1, 1);

  const state: FilterState = { nodes: 0, allowPrivate: false };
  const conds: SqlFragment[] = [
    sql`tenant_id = ${ctx.tenantId}`,
    sql`collection = ${collectionKey}`,
    sql`locale = ${locale}`,
    status === 'published' ? sql.raw('published_version is not null') : sql.raw('true'),
    rbacCondition(plan, ctx),
  ];
  if (params.filter !== undefined) conds.push(compileFilter(plan, params.filter, state));
  const where = sql.join(conds, ' and ');

  const { rows } = await db.query<DocRow>(sql`
    select * from apick_docs
    where ${where}
    order by ${compileSort(plan, params.sort)}
    limit ${pageSize} offset ${(page - 1) * pageSize}
  `);

  const populated =
    params.populate && params.populate.length > 0
      ? await populateDocs(db, registry, ctx, plan, rows, params.populate, locale)
      : null;

  const data = rows.map((row) => {
    const envelope = projectFields(plan, toEnvelope(col, row, status), params.fields);
    const pop = populated?.get(row.doc_id);
    return pop && Object.keys(pop).length > 0 ? { ...envelope, populated: pop } : envelope;
  });

  const meta: ListResult['meta'] = { page, pageSize };
  if (params.count) {
    const { rows: countRows } = await db.query<{ n: string }>(sql`select count(*)::text as n from apick_docs where ${where}`);
    meta.total = Number(countRows[0]!.n);
  }
  return { data, meta };
}

export async function getDoc(
  db: Db,
  registry: Registry,
  ctx: AccessContext,
  collectionKey: string,
  docId: string,
  params: Pick<ListParams, 'status' | 'locale' | 'populate' | 'fields'>,
): Promise<(DocEnvelope & { populated?: Record<string, unknown> }) | null> {
  const col = registry.get(collectionKey).compiled;
  const status = params.status ?? 'published';
  const plan = buildPlanContext(ctx, col, status);
  const locale = params.locale ?? DEFAULT_LOCALE;
  if (!isUuid(docId)) throw errors.badRequest('docId must be a uuid');

  const { rows } = await db.query<DocRow>(sql`
    select * from apick_docs
    where tenant_id = ${ctx.tenantId} and collection = ${collectionKey} and doc_id = ${docId} and locale = ${locale}
      and ${status === 'published' ? sql.raw('published_version is not null') : sql.raw('true')}
      and ${rbacCondition(plan, ctx)}
  `);
  const row = rows[0];
  if (!row) return null;

  const populated =
    params.populate && params.populate.length > 0
      ? await populateDocs(db, registry, ctx, plan, [row], params.populate, locale)
      : null;

  const envelope = projectFields(plan, toEnvelope(col, row, status), params.fields);
  const pop = populated?.get(row.doc_id);
  return pop && Object.keys(pop).length > 0 ? { ...envelope, populated: pop } : envelope;
}
