/**
 * APIck's schema DSL. One field definition feeds five consumers:
 * TypeScript types, runtime validation, OpenAPI, MCP tool schemas, and
 * index hints. Definitions are plain serializable JSON (FieldDef), so the
 * registry can snapshot them for drift detection and introspection.
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
  /** Unique per logical document within (tenant, collection, locale). Scalars only, nested objects allowed. */
  unique?: boolean;
  /** Opt-in expression index; created only by explicit `apick migrate`. */
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

/** Phantom-typed wrapper so collections infer TS shapes from definitions. */
export interface Field<T = unknown, Required extends boolean = boolean> {
  readonly def: FieldDef;
  readonly __t?: T;
  readonly __required?: Required;
}

function make<T, O extends Partial<FieldDef>>(def: FieldDef, _opts?: O): Field<T, O extends { required: true } ? true : false> {
  return { def } as Field<T, O extends { required: true } ? true : false>;
}

type TextOpts = Partial<Pick<FieldDef, 'required' | 'private' | 'unique' | 'indexed' | 'immutable' | 'default' | 'description' | 'minLength' | 'maxLength' | 'pattern' | 'format'>>;
type NumOpts = Partial<Pick<FieldDef, 'required' | 'private' | 'unique' | 'indexed' | 'immutable' | 'default' | 'description' | 'min' | 'max'>>;
type BaseOpts = Partial<Pick<FieldDef, 'required' | 'private' | 'indexed' | 'immutable' | 'default' | 'description'>>;
type RelationOpts = Partial<Pick<FieldDef, 'required' | 'private' | 'description'>>;

export const f = {
  text: <O extends TextOpts>(opts?: O) => make<string, O>({ type: 'text', ...opts }),
  /** Text with markdown format hint (flows into docs + MCP schemas). */
  markdown: <O extends TextOpts>(opts?: O) => make<string, O>({ type: 'text', format: 'markdown', ...opts }),
  email: <O extends TextOpts>(opts?: O) => make<string, O>({ type: 'text', format: 'email', ...opts }),
  uri: <O extends TextOpts>(opts?: O) => make<string, O>({ type: 'text', format: 'uri', ...opts }),
  /** An image URL (absolute or app-relative like /media/…). UIs render a media picker. */
  image: <O extends TextOpts>(opts?: O) => make<string, O>({ type: 'text', format: 'image', ...opts }),
  slug: <O extends TextOpts>(opts?: O) =>
    make<string, O>({ type: 'text', format: 'slug', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', ...opts }),
  integer: <O extends NumOpts>(opts?: O) => make<number, O>({ type: 'integer', ...opts }),
  number: <O extends NumOpts>(opts?: O) => make<number, O>({ type: 'number', ...opts }),
  boolean: <O extends BaseOpts>(opts?: O) => make<boolean, O>({ type: 'boolean', ...opts }),
  /** ISO-8601 timestamp string. */
  datetime: <O extends BaseOpts & Pick<FieldDef, 'unique'>>(opts?: O) => make<string, O>({ type: 'datetime', ...opts }),
  /** ISO date (YYYY-MM-DD). */
  date: <O extends BaseOpts & Pick<FieldDef, 'unique'>>(opts?: O) => make<string, O>({ type: 'date', ...opts }),
  enum: <const V extends readonly string[], O extends BaseOpts & Pick<FieldDef, 'unique'>>(values: V, opts?: O) =>
    make<V[number], O>({ type: 'enum', values: [...values], ...opts }),
  /** Arbitrary JSON. Opaque to filtering/sorting. */
  json: <O extends BaseOpts>(opts?: O) => make<unknown, O>({ type: 'json', ...opts }),
  object: <S extends Record<string, Field>, O extends BaseOpts>(fields: S, opts?: O) =>
    make<InferShape<S>, O>({ type: 'object', fields: defsOf(fields), ...opts }),
  list: <F extends Field, O extends BaseOpts>(of: F, opts?: O) =>
    make<Array<FieldValueOf<F>>, O>({ type: 'list', of: of.def, ...opts }),
  /** To-one relation: value is the target's docId (uuid string) or null. */
  relation: <O extends RelationOpts>(to: string, opts?: O) => make<string, O>({ type: 'relation', to, many: false, ...opts }),
  /** To-many ordered relation: value is an array of target docIds. */
  relations: <O extends RelationOpts>(to: string, opts?: O) => make<string[], O>({ type: 'relation', to, many: true, ...opts }),
  /**
   * Composable content (dynamic zone): an ordered list of typed blocks.
   * Each item carries a `__type` discriminator naming its variant.
   */
  blocks: <V extends Record<string, Record<string, Field>>, O extends BaseOpts>(variants: V, opts?: O) =>
    make<Array<BlockValueOf<V>>, O>(
      {
        type: 'blocks',
        variants: Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, defsOf(v)])),
        ...opts,
      },
    ),
};

function defsOf(fields: Record<string, Field>): Record<string, FieldDef> {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.def]));
}

export type FieldValueOf<F> = F extends Field<infer T, boolean> ? T : never;

type RequiredKeys<S extends Record<string, Field>> = { [K in keyof S]: S[K] extends Field<unknown, true> ? K : never }[keyof S];
type OptionalKeys<S extends Record<string, Field>> = Exclude<keyof S, RequiredKeys<S>>;

export type InferShape<S extends Record<string, Field>> = { [K in RequiredKeys<S>]: FieldValueOf<S[K]> } & {
  [K in OptionalKeys<S>]?: FieldValueOf<S[K]> | null;
};

type BlockValueOf<V extends Record<string, Record<string, Field>>> = {
  [K in keyof V]: { __type: K } & InferShape<V[K]>;
}[keyof V];
