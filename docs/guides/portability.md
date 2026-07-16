# Data portability

No lock-in is a behavioural guarantee, tested end-to-end
(`portability.test.ts`, `content-cli.test.ts`).

## Export / import

```bash
GET  /v1/export?collections=articles,authors     # requires manage system:export
POST /v1/import      { "docs": [...], "mode": "skip" | "overwrite" }
```

- The export is a **backup**: draft + published heads for every document in the
  tenant, **including private fields** (that's why it's permission-gated).
- Document ids are UUIDv7 — globally portable, so imports preserve identity and
  relations exactly (the incremental-id transfer problem is designed out).
- Round-trip fidelity: export → import into a fresh install → export again
  produces identical content; unique indexes and relation edges are rebuilt on
  import; divergent draft/published heads survive.
- `skip` (default) leaves existing docs untouched; `overwrite` replaces heads.
- Version *history* is not exported in v1 (heads are); history remains in the
  source database.

## The escape hatch is SQL

Your data is 12 well-documented Postgres tables (`apick_*`), with document
bodies as human-readable JSONB in `apick_docs.draft_data` /
`published_data` and full history in `apick_doc_versions.data`:

```sql
select doc_id, draft_data->>'title' as title
from apick_docs where collection = 'articles';
```

`pg_dump` is always a complete, restorable backup. Nothing is encoded in
proprietary blobs; deleting APIck leaves you with clean relational data.

## Content as files (`apick content`)

Keep authored content in git as markdown + json and sync it with the CLI:

```bash
npx apick content push  ./content --app ./schema.js [--database url] [--schema name]
npx apick content pull  ./content --app ./schema.js [--database url] [--schema name]
npx apick content check ./content --app ./schema.js        # validate only, exit 1 on problems
```

Layout inside the directory (`--app` is a module exporting `collections`):

- `<collection-key>/*.md` — frontmatter (a strict YAML subset: `key: value`
  scalars and `- item` string lists) holds the fields; the markdown body fills
  the collection's first `f.markdown()` field.
- `<collection-key>.json` — an array of data objects, for collections without
  a markdown field.

Semantics, all covered by `content-cli.test.ts`:

- **Upsert identity** is the collection's first `unique: true` field — a
  collection needs one to take part.
- **Idempotent**: unchanged documents are untouched; a changed file becomes a
  new draft version (+ re-publish if published). `publish: false` in
  frontmatter keeps a doc as draft; documents are **never auto-unpublished** —
  an admin's unpublish decision beats the files.
- **Relations by human key**: a relation value that isn't a UUID is resolved
  through the target collection's unique field (`author: Ada`), in two passes
  so in-directory references work regardless of file order.
- **Round-trip stable**: `pull` writes the same conventions back (sorted
  frontmatter keys, relations as human keys), so `pull` → `push` reports
  everything unchanged.
