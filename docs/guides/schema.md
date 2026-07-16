# Schema & fields

Content models are **code** (TypeScript is the source of truth) and **data**
(rows in a fixed registry table) — never DDL. Defining a collection creates no
tables; the only DDL your model can ever cause is an opt-in `CREATE INDEX` at
migrate time.

```ts
import { defineCollection, f } from '@apick/core';

const articles = defineCollection('articles', {
  description: 'Blog articles',
  access: { publicRead: true }, // anonymous may read PUBLISHED docs
  fields: {
    title: f.text({ required: true, maxLength: 200, indexed: true }),
    slug: f.slug({ unique: true }),
    category: f.enum(['tech', 'life']),
    views: f.integer({ min: 0, default: 0 }),
    publishAt: f.datetime(),
    internalNotes: f.text({ private: true }),
    seo: f.object({ metaTitle: f.text(), canonical: f.uri() }),
    tags: f.list(f.text()),
    author: f.relation('authors'),        // to-one: value is a docId string
    related: f.relations('articles'),     // to-many: ordered docId array
    body: f.blocks({                      // composable content (dynamic zone)
      prose: { markdown: f.markdown({ required: true }) },
      quote: { text: f.text({ required: true }), attribution: f.text() },
    }),
  },
});
```

## Field types

`f.text` `f.markdown` `f.email` `f.uri` `f.image` `f.slug` `f.integer` `f.number`
`f.boolean` `f.datetime` (ISO-8601) `f.date` (YYYY-MM-DD) `f.enum` `f.json`
`f.object` `f.list` `f.relation` `f.relations` `f.blocks`

## Field options

| Option | Meaning |
|---|---|
| `required` | must be present and non-null in the (merged) document |
| `unique` | unique per (tenant, collection, locale) across logical documents — scalars only, **works inside nested objects**, and never conflicts between a doc's own draft and published heads |
| `private` | write-only: never returned, never filterable/sortable/populatable, absent from read schemas, events and webhooks. Perfect for tokens, emails, internal notes |
| `indexed` | expression index on the JSONB path — created only by `apick migrate` / `migrate: 'apply'`, never at serve time |
| `immutable` | set at create; later patches that change it are rejected |
| `default` | applied at create when the field is absent (top-level fields) |
| `description` | flows into OpenAPI, MCP tool schemas and llms-full.txt |
| constraints | `minLength`/`maxLength`/`pattern` (text), `min`/`max` (numbers) |

## Validation

Writes are validated against the **merged** document — a patch that would leave
the document invalid is rejected with `422` and per-path issues:

```json
{ "error": { "code": "validation", "details": { "issues": [
  { "path": "seo.metaTitle", "message": "Expected string" }
] } } }
```

Unknown keys are rejected (`additionalProperties: false` everywhere).

## Renaming a field (lossless, always)

Declare the rename; APIck migrates the JSONB keys — heads, full version
history, unique and edge indexes — in one transaction at startup/migrate. Data
is never dropped:

```ts
defineCollection('posts', {
  fields: { title: f.text({ required: true }) },  // was "headline"
  renamedFields: { title: 'headline' },           // newKey: oldKey (top-level fields)
});
```

Removing a field from code never deletes stored data — the values stop being
validated/returned, and reappear if you restore the field. There is no
destructive schema operation in APIck.

## Relations

- Values are docId strings (uuid v7). Targets must exist at write time (same tenant).
- Reads resolve relations with `?populate=author` — one hop, rendered under the
  **target collection's** permissions and the same draft/published status as the
  parent request. A published article pointing at a never-published author
  populates as `null` — publish the author.
- Deleting a target leaves dangling refs that populate as `null` (documented
  trade-off; subscribe to `doc.deleted` events to clean up if you care).
- Reverse lookups are indexed internally (`apick_edges`) for future traversal
  features; v1 filters only apply to a collection's own fields.

## TypeScript inference

```ts
import type { InferDoc } from '@apick/core';
type Article = InferDoc<typeof articles>; // { title: string; views?: number | null; … }
```
