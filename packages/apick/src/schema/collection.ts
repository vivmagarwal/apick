import type { Field, InferShape } from './fields.js';
import { compileCollection, type CompiledCollection } from './compile.js';

/**
 * Presentation hints for schema-driven UIs (the admin, MCP clients). Pure
 * data — no behavior — carried through schema introspection.
 */
export interface AdminHints {
  /** Human name, e.g. "Site pages" (falls back to the collection key). */
  label?: string;
  /** An emoji or icon name shown next to the label. */
  icon?: string;
  /** The field that names a document in listings/pickers (defaults to a heuristic: title/name/first required text). */
  titleField?: string;
  /** An integer field used for manual ordering in related-content panels. */
  orderField?: string;
}

export interface CollectionOptions<S extends Record<string, Field>> {
  fields: S;
  description?: string;
  /**
   * Convenience access defaults applied at bootstrap:
   * - publicRead: the built-in `public` role may read published documents.
   */
  access?: { publicRead?: boolean };
  /**
   * Top-level fields renamed from a previous key. Applied as a LOSSLESS jsonb
   * key migration during schema sync — never drop+recreate.
   * Example: { title: 'headline' } means "title used to be called headline".
   */
  renamedFields?: Record<string, string>;
  /** Presentation hints for schema-driven UIs (labels, icons, title/order fields). */
  admin?: AdminHints;
}

export interface Collection<S extends Record<string, Field> = Record<string, Field>> {
  key: string;
  description: string | undefined;
  access: { publicRead: boolean };
  renamedFields: Record<string, string>;
  admin: AdminHints;
  compiled: CompiledCollection;
  /** Phantom: the inferred TS document shape. */
  __shape?: InferShape<S>;
}

export function defineCollection<S extends Record<string, Field>>(key: string, options: CollectionOptions<S>): Collection<S> {
  const compiled = compileCollection(key, {
    fields: Object.fromEntries(Object.entries(options.fields).map(([k, v]) => [k, v.def])),
    ...(options.description !== undefined ? { description: options.description } : {}),
  });
  const admin = options.admin ?? {};
  for (const [hint, field] of [['titleField', admin.titleField], ['orderField', admin.orderField]] as const) {
    if (field !== undefined && !(field in options.fields)) {
      throw new Error(`Collection "${key}": admin.${hint} "${field}" is not a field`);
    }
  }
  return {
    key,
    description: options.description,
    access: { publicRead: options.access?.publicRead ?? false },
    renamedFields: options.renamedFields ?? {},
    admin,
    compiled,
  };
}

export type InferDoc<C> = C extends Collection<infer S> ? InferShape<S> : never;
