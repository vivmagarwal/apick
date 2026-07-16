# Data portability

No lock-in is a behavioural guarantee, tested end-to-end
(`portability.test.ts`).

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
