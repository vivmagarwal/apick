import type { Field, InferShape } from './fields.js';
import { compileCollection, type CompiledCollection } from './compile.js';

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
}

export interface Collection<S extends Record<string, Field> = Record<string, Field>> {
  key: string;
  description: string | undefined;
  access: { publicRead: boolean };
  renamedFields: Record<string, string>;
  compiled: CompiledCollection;
  /** Phantom: the inferred TS document shape. */
  __shape?: InferShape<S>;
}

export function defineCollection<S extends Record<string, Field>>(key: string, options: CollectionOptions<S>): Collection<S> {
  const compiled = compileCollection(key, {
    fields: Object.fromEntries(Object.entries(options.fields).map(([k, v]) => [k, v.def])),
    ...(options.description !== undefined ? { description: options.description } : {}),
  });
  return {
    key,
    description: options.description,
    access: { publicRead: options.access?.publicRead ?? false },
    renamedFields: options.renamedFields ?? {},
    compiled,
  };
}

export type InferDoc<C> = C extends Collection<infer S> ? InferShape<S> : never;
