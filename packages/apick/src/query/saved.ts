import type { Db } from '../kernel/db.js';
import { errors } from '../kernel/errors.js';
import type { AccessContext } from '../auth/rbac.js';
import type { Registry } from '../content/registry.js';
import { listDocs, type ListResult } from './plan.js';

/**
 * Saved queries — "views", headless. A query is defined once in code (typed,
 * bounded, tenant- and permission-scoped by the same planner as everything
 * else) and exposed over REST and MCP. It is a convenience, never a privilege
 * escalation: the caller still needs read access to the collection.
 */

export interface SavedQueryParam {
  type: 'text' | 'integer' | 'number' | 'boolean';
  required?: boolean;
  default?: unknown;
  description?: string;
}

export interface SavedQuery {
  key: string;
  collection: string;
  description?: string;
  /** Filter AST; `{ "$param": "name" }` nodes substitute caller arguments. */
  filter?: unknown;
  sort?: string;
  status?: 'draft' | 'published';
  populate?: string[];
  fields?: string[];
  pageSize?: number;
  params?: Record<string, SavedQueryParam>;
}

export function defineQuery(key: string, def: Omit<SavedQuery, 'key'>): SavedQuery {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(key)) throw errors.badRequest(`Invalid query key "${key}"`);
  return { key, ...def };
}

function coerceParam(spec: SavedQueryParam, raw: unknown, name: string): unknown {
  const fail = (): never => {
    throw errors.validation(`Invalid value for query param "${name}" (expected ${spec.type})`);
  };
  switch (spec.type) {
    case 'text':
      return typeof raw === 'string' ? raw : fail();
    case 'integer': {
      const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
      return Number.isInteger(n) ? n : fail();
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
      return Number.isFinite(n) ? n : fail();
    }
    case 'boolean':
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      return fail();
  }
}

function substituteParams(node: unknown, values: Record<string, unknown>): unknown {
  if (Array.isArray(node)) return node.map((n) => substituteParams(n, values));
  if (node !== null && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (typeof obj['$param'] === 'string' && Object.keys(obj).length === 1) {
      const name = obj['$param'];
      if (!(name in values)) throw errors.validation(`Missing query param "${name}"`);
      return values[name];
    }
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, substituteParams(v, values)]));
  }
  return node;
}

export async function executeSavedQuery(
  db: Db,
  registry: Registry,
  ctx: AccessContext,
  query: SavedQuery,
  args: Record<string, unknown>,
  paging: { page?: number; pageSize?: number; count?: boolean; locale?: string } = {},
): Promise<ListResult> {
  const values: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(query.params ?? {})) {
    const raw = args[name];
    if (raw === undefined || raw === '') {
      if (spec.default !== undefined) values[name] = spec.default;
      else if (spec.required) throw errors.validation(`Missing required query param "${name}"`);
      continue;
    }
    values[name] = coerceParam(spec, raw, name);
  }

  const filter = query.filter !== undefined ? substituteParams(query.filter, values) : undefined;
  return listDocs(db, registry, ctx, query.collection, {
    ...(filter !== undefined ? { filter } : {}),
    ...(query.sort !== undefined ? { sort: query.sort } : {}),
    ...(query.populate !== undefined ? { populate: query.populate } : {}),
    ...(query.fields !== undefined ? { fields: query.fields } : {}),
    status: query.status ?? 'published',
    page: paging.page ?? 1,
    pageSize: paging.pageSize ?? query.pageSize ?? 25,
    ...(paging.count !== undefined ? { count: paging.count } : {}),
    ...(paging.locale !== undefined ? { locale: paging.locale } : {}),
  });
}
