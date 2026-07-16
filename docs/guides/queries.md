# Queries & saved queries

## Listing

```
GET /v1/collections/articles/docs
  ?filter={"$or":[{"views":{"$gt":100}},{"title":{"$startsWith":"Hello"}}]}
  &sort=-createdAt,title
  &page=1&pageSize=25&count=true
  &status=published|draft
  &locale=default
  &populate=author,related
  &fields=title,slug
```

`filter` is JSON. Operators:

| Operator | Types | Notes |
|---|---|---|
| `$eq` `$ne` | scalars, to-one relations | `{"title":"x"}` is shorthand for `$eq` |
| `$gt` `$gte` `$lt` `$lte` | text, numbers, datetime, date | |
| `$in` `$nin` | scalars | 1–100 values |
| `$contains` `$icontains` `$startsWith` `$endsWith` | text, enum | LIKE metacharacters are escaped — always literal |
| `$null` | any filterable | `{"$null": true|false}` |
| `$contains` | to-many relations | membership: `{"related":{"$contains":"<docId>"}}` |
| `$contains` | lists of text/enum | membership: `{"tags":{"$contains":"borders"}}` — exact item match, not substring |
| `$and` `$or` `$not` | combinators | nest freely within the node budget |

Nested object fields use dotted paths: `{"seo.metaTitle": {"$eq": "x"}}` — that
includes lists nested in objects (`{"meta.keywords":{"$contains":"x"}}`).
`json`, `blocks`, `object` fields and lists of objects are not filterable as a
whole; scalar lists accept only `$contains` and `$null`.
System sorts: `createdAt`, `updatedAt`, `publishedAt`, `docId`.

## The planner is the security boundary

A filter/sort/populate may reference only fields that (a) exist in the schema
and (b) the caller may read. Anything else — including **private** fields — is
rejected at plan time with `400 plan_rejected`, using the same message for
"private" and "nonexistent" so field existence can't be probed. RBAC row
conditions and the tenant id are compiled into every query and every populate
hop.

## Bounded by default

pageSize ≤ 100 · filter ≤ 50 nodes · sort ≤ 3 keys · populate ≤ 8 relations ·
`$in` ≤ 100 values · populate of a to-many caps at 50 targets. `count=true` is
opt-in (counting is a real cost). These are hard caps, not suggestions — there
is no query a client can send that produces unbounded work.

## Populate

`populate=author` adds a `populated` object beside `data` (raw refs stay
intact):

```json
{ "docId": "…", "data": { "author": "<docId>" },
  "populated": { "author": { "docId": "…", "data": { "name": "Ada" } } } }
```

One hop deep in v1 — deep populate is the classic unbounded-read footgun; use a
second request or a saved query per hop.

## Saved queries — views, headless

Define once in code; expose over REST **and** MCP; the caller still needs read
permission on the collection (a saved query is a convenience, never an
escalation):

```ts
import { defineQuery } from '@apick/core';

const latest = defineQuery('latest', {
  collection: 'articles',
  description: 'Latest published articles in a category',
  filter: { category: { $eq: { $param: 'category' } } },
  sort: '-createdAt',
  pageSize: 10,
  populate: ['author'],
  params: { category: { type: 'text', required: true } },
});

await createApp({ collections, queries: [latest] });
```

```
GET /v1/queries/latest?category=tech&page=2&count=true
MCP tool: query_latest { "category": "tech" }
```

Params are typed (`text` | `integer` | `number` | `boolean`) with optional
`default`; missing required params → `422`.
