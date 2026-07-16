# APIck in one page

Everything needed to build the APIck way, compactly. Depth follows in the
sections after this one.

## Two packages

- **`@apick/core`** — the headless platform (API + RBAC + webhooks + jobs + MCP).
- **`@apick/cms`** — a full CMS on core (admin UI, users, media, themes, site).

`npm i @apick/core` · Node ≥ 22 · embedded Postgres (PGlite) in dev, any
Postgres ≥ 14 in prod.

## Hello world (core)

```ts
import { createApp, defineCollection, f } from '@apick/core';

const todos = defineCollection('todos', {
  access: { publicRead: true },              // anonymous may read PUBLISHED docs
  fields: { title: f.text({ required: true }), done: f.boolean({ default: false }) },
});

const app = await createApp({ collections: [todos] });
console.log('root key:', app.rootKey);       // printed once on first boot
await app.listen(3000);
```

## The field DSL (one definition drives types + validation + OpenAPI + MCP)

`f.text` `f.markdown` `f.email` `f.uri` `f.image` `f.slug` `f.integer` `f.number`
`f.boolean` `f.datetime` `f.date` `f.enum(['a','b'])` `f.json`
`f.object({...})` `f.list(f.text())` `f.relation('other')` `f.relations('other')`
`f.blocks({ variantName: { ...fields } })`

Collection options: `access.publicRead`, `renamedFields`, and `admin` hints
(`label`, `icon`, `titleField`, `orderField`) that drive schema-driven UIs —
introspection also returns `referencedBy` (who points at this collection).
Field options (per field): `required`, `unique` (works in nested objects), `private`
(write-only — never readable/filterable/sortable/populatable via ANY API),
`indexed` (opt-in index at migrate time), `immutable`, `default`, `description`,
`minLength`/`maxLength`/`pattern` (text), `min`/`max` (numbers).

## Documents

Identity = `(docId: uuidv7, locale, version)`. A document has a **draft head**
and optionally a **published head** — publishing moves a pointer, never copies.
Writes are **RFC 7386 merge patches** (send only what changes; `null` removes a
key; arrays replace), producing a new append-only version.

Envelope returned by reads:
```json
{ "docId":"…","locale":"default","version":3,"status":"published",
  "publishedVersion":3,"createdAt":"…","updatedAt":"…","publishedAt":"…","data":{…} }
```

## REST API

Auth: `Authorization: Bearer <api key>`. Tenant: `x-apick-tenant: <slug>`
(optional; defaults to the install's tenant). Errors are always
`{ "error": { "code","message","details" } }` (codes: bad_request/plan_rejected
400, unauthorized 401, forbidden 403, not_found 404, conflict 409, validation
422, internal 500).

```
GET    /v1/collections/:c/docs        ?filter=…&sort=-createdAt&page=1&pageSize=25
                                       &status=draft|published&locale=…&populate=rel&fields=a,b&count=true
POST   /v1/collections/:c/docs         {"data":{…},"publish":true,"locale":"…","docId":"…"}
GET    /v1/collections/:c/docs/:id      ?status=…&populate=…&fields=…
PATCH  /v1/collections/:c/docs/:id      {"patch":{…},"ifVersion":n}          (merge patch)
DELETE /v1/collections/:c/docs/:id      ?locale=…
POST   /v1/collections/:c/docs/:id/publish  |  /unpublish
GET    /v1/collections/:c/docs/:id/versions | /versions/:n | POST /versions/:n/restore
GET    /v1/collections                  (introspection)   GET /v1/collections/:c/schema
GET    /v1/queries  |  GET /v1/queries/:key?param=…        (saved queries)
GET    /v1/search?q=…&collections=a,b   ranked FTS across collections (websearch syntax)
POST   …/docs/:id/publish {"at":"<iso>"}  schedules; DELETE …/publish-schedule cancels
system (permission-gated): /v1/tenants /v1/keys /v1/roles /v1/grants /v1/principals
       /v1/webhooks /v1/webhooks/:id/deliveries /v1/deliveries/:id/replay
       /v1/events /v1/jobs /v1/export /v1/import
meta: /health /health/ready /openapi.json /llms.txt /llms-full.txt /mcp
```

## Filter grammar (JSON)

Operators: `$eq $ne $gt $gte $lt $lte $in $nin $contains $icontains $startsWith
$endsWith $null`. Combinators: `$and $or $not`. Shorthand: `{"title":"x"}` = `$eq`.
`$contains` on a list of text/enum (or a to-many relation) is exact membership:
`{"tags":{"$contains":"borders"}}`. Only fields that exist AND that you may read
are accepted — anything else is rejected at plan time (private fields are
indistinguishable from unknown ones).

```
?filter={"$or":[{"views":{"$gt":100}},{"title":{"$startsWith":"Hello"}}]}&sort=-views
```

Reads are **bounded**: pageSize ≤ 100, filter ≤ 50 nodes, sort ≤ 3 keys,
populate ≤ 8 (one hop), `$in` ≤ 100 values.

## Auth & RBAC

Built-in roles: `operator-admin` (everything), `tenant-admin`, `content-editor`,
`content-reader`, `public` (anonymous). Custom roles carry a field whitelist
(`fields`) and a row condition (`condition`, a filter AST; `"$me"` = caller).
**Authorization is enforced in the query planner**, not the controller. Mint
scoped keys: `POST /v1/keys {"role":"content-editor","name":"…"}`. Bring your
own IdP with `createApp({ auth: { verifyToken } })`.

## MCP (agents)

`POST /mcp` (stateless streamable HTTP, same bearer key). Tools:
`list_collections` (call first), `search_content`, `list_documents`, `get_document`,
`create_document`, `update_document`, `delete_document`, `publish_document`,
`unpublish_document`, `list_versions`, `get_version`, `restore_version`, and one
`query_<key>` per saved query. Least-privilege via the key; every mutation
audited.

## The APIck way — invariants to rely on

- **Content model is data, never DDL.** Defining a collection creates no tables;
  a field rename (`renamedFields`) is a lossless migration, never a drop.
- **Migrations are explicit** — applied via `apick migrate` / `migrate:'apply'`,
  never silently at boot on Postgres.
- **Publish is a pointer; writes are patches** (not whole-document PUT).
- **Private fields are structurally invisible** (the anti-oracle guarantee).
- **Reads are bounded**; the API can't be coerced into a pathological query.
- **Multi-tenant + stateless by construction**: N replicas safe, cron fires once
  cluster-wide, webhooks deliver once, no writable filesystem needed.
- **Many apps, one database**: `databaseSchema: 'apick_myapp'` (or `?schema=`
  on the URL) isolates each APIck app in its own Postgres schema — existing
  tables untouched, no collisions, session-mode pooler required.
- **No Docker, no SQLite dialect drift**: dev runs embedded PGlite (real
  Postgres in-process, SQLite-like ergonomics); prod is any Postgres ≥ 14.
- **Webhooks are reliable**: signed, retried, dead-lettered, replayable.
- **History/audit/rollback are free** (append-only versions + event log).

## CMS (`@apick/cms`) in a nutshell

```ts
import { createCms, defineCollection, f } from '@apick/cms';
const app = await createCms({ site: { title: 'My Site' }, collections: [/* yours */] });
await app.listen(3000);   // site at /, admin at /admin (first visit = setup)
```

Ships `pages` + `posts` by default; admin UI at `/admin` (schema-driven editor
for every field type, draft/publish, versions, users/keys/webhooks); media
library at `/admin/media` + served at `/media/:id/:file`; `f.image()` fields get
a picker; markdown fields use the edodo-write WYSIWYG (Markdown stays the value).
Themes are code (`theme: { templates, blocks, css }`, child-theme merge; `html`
tag escapes by default, `md()` sanitizes). Plugins bundle collections + queries
+ jobs + crons + routes + adminNav + theme. Users map to core RBAC
(admin/editor/viewer); the same session token drives `/v1` and `/mcp`. Scaffold:
`npx --package=@apick/cms apick-cms init my-site`.
