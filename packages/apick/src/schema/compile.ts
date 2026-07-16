import { FormatRegistry, Type, type TSchema } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { errors } from '../kernel/errors.js';
import type { FieldDef, FieldType } from './fields.js';

// -- formats used by the DSL ------------------------------------------------

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

if (!FormatRegistry.Has('date-time')) FormatRegistry.Set('date-time', (v) => ISO_DATETIME.test(v));
if (!FormatRegistry.Has('date')) FormatRegistry.Set('date', (v) => ISO_DATE.test(v));
if (!FormatRegistry.Has('email')) FormatRegistry.Set('email', (v) => EMAIL.test(v));
if (!FormatRegistry.Has('uuid')) FormatRegistry.Set('uuid', (v) => UUID.test(v));
if (!FormatRegistry.Has('uri')) {
  FormatRegistry.Set('uri', (v) => {
    try {
      new URL(v);
      return true;
    } catch {
      return false;
    }
  });
}
if (!FormatRegistry.Has('slug')) FormatRegistry.Set('slug', (v) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v));
if (!FormatRegistry.Has('markdown')) FormatRegistry.Set('markdown', () => true);

// -- naming rules -----------------------------------------------------------

export const FIELD_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
export const COLLECTION_KEY_RE = /^[a-z][a-z0-9_-]{0,63}$/;

const RESERVED_FIELDS = new Set([
  'docId', 'id', 'locale', 'version', 'status', 'createdAt', 'updatedAt', 'publishedAt', 'createdBy', '__type',
]);

// -- compiled output --------------------------------------------------------

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface RelationSpec {
  /** Dotted path; '[]' marks list/blocks hops, e.g. 'blocks[].author'. */
  path: string;
  to: string;
  many: boolean;
}

export interface CompiledCollection {
  key: string;
  description: string | null;
  fields: Record<string, FieldDef>;
  /** Validate a full (merged) document body, private fields included. */
  validate: (data: unknown) => ValidationIssue[];
  /** JSON Schema of the data body on writes (includes private fields). */
  writeSchema: Record<string, unknown>;
  /** JSON Schema of a returned document (system fields + non-private data). */
  readSchema: Record<string, unknown>;
  privatePaths: string[];
  uniquePaths: { path: string; type: FieldType }[];
  indexedPaths: string[];
  relations: RelationSpec[];
  defaults: { field: string; value: unknown }[];
  immutablePaths: string[];
  /** Resolve a dotted path (object nesting only) to its definition. */
  fieldAt: (path: string) => FieldDef | null;
}

function fieldToSchema(def: FieldDef, opts: { forRead: boolean }): TSchema | null {
  if (opts.forRead && def.private) return null;
  const meta: Record<string, unknown> = {};
  if (def.description) meta['description'] = def.description;

  switch (def.type) {
    case 'text': {
      const o: Record<string, unknown> = { ...meta };
      if (def.minLength !== undefined) o['minLength'] = def.minLength;
      if (def.maxLength !== undefined) o['maxLength'] = def.maxLength;
      if (def.pattern !== undefined) o['pattern'] = def.pattern;
      if (def.format !== undefined && def.format !== 'markdown') o['format'] = def.format;
      return Type.String(o);
    }
    case 'integer': {
      const o: Record<string, unknown> = { ...meta };
      if (def.min !== undefined) o['minimum'] = def.min;
      if (def.max !== undefined) o['maximum'] = def.max;
      return Type.Integer(o);
    }
    case 'number': {
      const o: Record<string, unknown> = { ...meta };
      if (def.min !== undefined) o['minimum'] = def.min;
      if (def.max !== undefined) o['maximum'] = def.max;
      return Type.Number(o);
    }
    case 'boolean':
      return Type.Boolean(meta);
    case 'datetime':
      return Type.String({ ...meta, format: 'date-time' });
    case 'date':
      return Type.String({ ...meta, format: 'date' });
    case 'enum':
      return Type.Union((def.values ?? []).map((v) => Type.Literal(v)), meta);
    case 'json':
      return Type.Unknown(meta);
    case 'object':
      return objectSchema(def.fields ?? {}, opts, meta);
    case 'list': {
      const item = fieldToSchema(def.of!, opts);
      return Type.Array(item ?? Type.Unknown(), meta);
    }
    case 'relation':
      return def.many
        ? Type.Array(Type.String({ format: 'uuid' }), meta)
        : Type.String({ ...meta, format: 'uuid' });
    case 'blocks': {
      const variants = Object.entries(def.variants ?? {}).map(([name, shape]) => {
        const inner = objectSchema(shape, opts, {});
        return Type.Object(
          { __type: Type.Literal(name), ...(inner as unknown as { properties: Record<string, TSchema> }).properties },
          { additionalProperties: false, required: (inner as unknown as { required?: string[] }).required?.concat('__type') ?? ['__type'] },
        );
      });
      return Type.Array(Type.Union(variants), meta);
    }
  }
}

function objectSchema(fields: Record<string, FieldDef>, opts: { forRead: boolean }, meta: Record<string, unknown>): TSchema {
  const props: Record<string, TSchema> = {};
  const required: string[] = [];
  for (const [key, def] of Object.entries(fields)) {
    const schema = fieldToSchema(def, opts);
    if (!schema) continue;
    if (def.required) {
      props[key] = schema;
      required.push(key);
    } else {
      props[key] = Type.Optional(Type.Union([schema, Type.Null()]));
    }
  }
  const o: Record<string, unknown> = { ...meta, additionalProperties: false };
  return Type.Object(props, required.length > 0 ? { ...o, required } : o) as TSchema;
}

interface WalkEntry {
  path: string;
  def: FieldDef;
  underArray: boolean;
}

function* walkFields(fields: Record<string, FieldDef>, prefix = '', underArray = false): Generator<WalkEntry> {
  for (const [key, def] of Object.entries(fields)) {
    const path = prefix ? `${prefix}.${key}` : key;
    yield { path, def, underArray };
    if (def.type === 'object' && def.fields) {
      yield* walkFields(def.fields, path, underArray);
    } else if (def.type === 'list' && def.of) {
      if (def.of.type === 'object' && def.of.fields) yield* walkFields(def.of.fields, `${path}[]`, true);
      else yield { path: `${path}[]`, def: def.of, underArray: true };
    } else if (def.type === 'blocks' && def.variants) {
      for (const shape of Object.values(def.variants)) {
        yield* walkFields(shape, `${path}[]`, true);
      }
    }
  }
}

const SCALAR_TYPES: FieldType[] = ['text', 'integer', 'number', 'boolean', 'datetime', 'date', 'enum'];

export function compileCollection(key: string, options: { description?: string; fields: Record<string, FieldDef> }): CompiledCollection {
  if (!COLLECTION_KEY_RE.test(key)) {
    throw errors.badRequest(`Invalid collection key "${key}" (must match ${COLLECTION_KEY_RE})`);
  }

  const fields = options.fields;
  const privatePaths: string[] = [];
  const uniquePaths: { path: string; type: FieldType }[] = [];
  const indexedPaths: string[] = [];
  const relations: RelationSpec[] = [];
  const immutablePaths: string[] = [];
  const defaults: { field: string; value: unknown }[] = [];

  for (const { path, def, underArray } of walkFields(fields)) {
    const leaf = path.split('.').pop()!.replace('[]', '');
    if (leaf && !FIELD_KEY_RE.test(leaf)) {
      throw errors.badRequest(`Invalid field key "${leaf}" in collection "${key}"`);
    }
    if (RESERVED_FIELDS.has(leaf)) {
      throw errors.badRequest(`Field name "${leaf}" is reserved (collection "${key}")`);
    }
    if (def.private) privatePaths.push(path);
    if (def.unique) {
      if (!SCALAR_TYPES.includes(def.type)) {
        throw errors.badRequest(`unique is only supported on scalar fields ("${path}" in "${key}")`);
      }
      if (underArray || path.includes('[]')) {
        throw errors.badRequest(`unique inside lists/blocks is not supported ("${path}" in "${key}")`);
      }
      uniquePaths.push({ path, type: def.type });
    }
    if (def.indexed) {
      if (!SCALAR_TYPES.includes(def.type) || underArray || path.includes('[]')) {
        throw errors.badRequest(`indexed is only supported on scalar fields outside lists ("${path}" in "${key}")`);
      }
      indexedPaths.push(path);
    }
    if (def.immutable) immutablePaths.push(path);
    if (def.type === 'relation') {
      if (!def.to || !COLLECTION_KEY_RE.test(def.to)) {
        throw errors.badRequest(`relation "${path}" in "${key}" has invalid target "${def.to}"`);
      }
      relations.push({ path, to: def.to, many: def.many ?? false });
    }
    if (def.type === 'list' && def.of?.type === 'relation') {
      throw errors.badRequest(`Use f.relations() instead of f.list(f.relation()) ("${path}" in "${key}")`);
    }
    if (path.split('.').length > 8) {
      throw errors.badRequest(`Field nesting too deep at "${path}" in "${key}" (max 8)`);
    }
  }

  for (const [fieldKey, def] of Object.entries(fields)) {
    if (def.default !== undefined) defaults.push({ field: fieldKey, value: def.default });
  }

  const writeTb = objectSchema(fields, { forRead: false }, {});
  const readDataTb = objectSchema(fields, { forRead: true }, {});
  const compiled = TypeCompiler.Compile(writeTb);

  const readSchema: Record<string, unknown> = {
    type: 'object',
    description: options.description,
    properties: {
      docId: { type: 'string', format: 'uuid' },
      locale: { type: 'string' },
      version: { type: 'integer' },
      status: { type: 'string', enum: ['draft', 'published'] },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
      publishedAt: { type: 'string', format: 'date-time' },
      data: JSON.parse(JSON.stringify(readDataTb)),
    },
    required: ['docId', 'locale', 'version', 'status', 'createdAt', 'updatedAt', 'data'],
  };

  const fieldAt = (path: string): FieldDef | null => {
    const segments = path.split('.');
    let current: Record<string, FieldDef> | undefined = fields;
    let def: FieldDef | null = null;
    for (const seg of segments) {
      if (!current || !FIELD_KEY_RE.test(seg)) return null;
      def = current[seg] ?? null;
      if (!def) return null;
      current = def.type === 'object' ? def.fields : undefined;
    }
    return def;
  };

  return {
    key,
    description: options.description ?? null,
    fields,
    validate: (data: unknown): ValidationIssue[] => {
      if (compiled.Check(data)) return [];
      const issues: ValidationIssue[] = [];
      const seen = new Set<string>();
      // Optional fields compile to Union([T, Null]); drill into union sub-errors
      // so issues point at the failing leaf (seo.metaTitle), not the wrapper.
      const collect = (errs: Iterable<{ path: string; message: string; errors?: Array<Iterable<{ path: string; message: string }>> }>): void => {
        for (const err of errs) {
          if (issues.length >= 20) return;
          let drilled = false;
          for (const sub of err.errors ?? []) {
            const subErrors = [...sub].filter((s) => s.message !== 'Expected null');
            if (subErrors.length > 0) {
              collect(subErrors as never);
              drilled = true;
            }
          }
          if (!drilled) {
            const path = err.path.replaceAll('/', '.').replace(/^\./, '');
            if (!seen.has(path)) {
              seen.add(path);
              issues.push({ path, message: err.message });
            }
          }
        }
      };
      collect(compiled.Errors(data) as never);
      return issues;
    },
    writeSchema: JSON.parse(JSON.stringify(writeTb)),
    readSchema,
    privatePaths,
    uniquePaths,
    indexedPaths,
    relations,
    defaults,
    immutablePaths,
    fieldAt,
  };
}

// -- data helpers used by the store & planner -------------------------------

export function getAtPath(data: unknown, path: string): unknown {
  let cur: unknown = data;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export interface ExtractedRef {
  field: string; // the relation's declared path (with [] markers)
  to: string;
  docId: string;
}

/** Pull every relation reference out of a document body (edges maintenance). */
export function extractRefs(col: CompiledCollection, data: Record<string, unknown>): ExtractedRef[] {
  const refs: ExtractedRef[] = [];
  const visit = (fields: Record<string, FieldDef>, value: unknown, pathPrefix: string): void => {
    if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return;
    const obj = value as Record<string, unknown>;
    for (const [key, def] of Object.entries(fields)) {
      const v = obj[key];
      if (v === null || v === undefined) continue;
      const path = pathPrefix ? `${pathPrefix}.${key}` : key;
      if (def.type === 'relation') {
        const ids = def.many ? (Array.isArray(v) ? v : []) : [v];
        for (const id of ids) {
          if (typeof id === 'string') refs.push({ field: path, to: def.to!, docId: id });
        }
      } else if (def.type === 'object' && def.fields) {
        visit(def.fields, v, path);
      } else if (def.type === 'list' && def.of?.type === 'object' && def.of.fields && Array.isArray(v)) {
        for (const item of v) visit(def.of.fields!, item, `${path}[]`);
      } else if (def.type === 'blocks' && def.variants && Array.isArray(v)) {
        for (const item of v) {
          const variant = (item as Record<string, unknown>)?.['__type'];
          const shape = typeof variant === 'string' ? def.variants[variant] : undefined;
          if (shape) visit(shape, item, `${path}[]`);
        }
      }
    }
  };
  visit(col.fields, data, '');
  return refs;
}

/** Strip private fields from a document body for API responses. */
export function redactPrivate(col: CompiledCollection, data: Record<string, unknown>): Record<string, unknown> {
  const strip = (fields: Record<string, FieldDef>, value: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, def] of Object.entries(fields)) {
      if (def.private) continue;
      const v = value[key];
      if (v === undefined) continue;
      if (v === null) {
        out[key] = null;
      } else if (def.type === 'object' && def.fields && typeof v === 'object' && !Array.isArray(v)) {
        out[key] = strip(def.fields, v as Record<string, unknown>);
      } else if (def.type === 'list' && def.of?.type === 'object' && def.of.fields && Array.isArray(v)) {
        out[key] = v.map((item) =>
          item && typeof item === 'object' && !Array.isArray(item) ? strip(def.of!.fields!, item as Record<string, unknown>) : item,
        );
      } else if (def.type === 'blocks' && def.variants && Array.isArray(v)) {
        out[key] = v.map((item) => {
          const variant = (item as Record<string, unknown>)?.['__type'];
          const shape = typeof variant === 'string' ? def.variants![variant] : undefined;
          if (!shape || !item || typeof item !== 'object') return item;
          return { __type: variant, ...strip(shape, item as Record<string, unknown>) };
        });
      } else {
        out[key] = v;
      }
    }
    return out;
  };
  return strip(col.fields, data);
}
