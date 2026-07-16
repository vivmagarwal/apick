# APIck — API Construction Kit

Two packages, one idea: **the platform is headless; everything else is a
consumer of its API.**

- **[`@apick/core`](packages/apick)** — a pure-headless, AI-first application
  platform. Define your content model in TypeScript; get a validated REST API,
  RBAC, multi-tenancy, versioned documents, reliable webhooks, durable
  background jobs, OpenAPI, `llms.txt` and a first-class MCP server — from one
  definition, in one process, on Postgres. No UI, by design.
- **[`@apick/cms`](packages/cms)** — a full, themable, WordPress-class CMS
  built ON core: a schema-driven admin UI, users & sessions, and a
  server-rendered themable site. Its admin is a pure REST client — everything
  a human does in it, an agent can do over `/v1` or `/mcp` with the same
  token. `npx --package=@apick/cms apick-cms init my-site` scaffolds a site with Drupal's
  conventions (your `collections/`, `theme/`, `plugins/`) and npm's
  distribution (the framework never lives in your repo).

## @apick/core in 30 seconds

```ts
import { createApp, defineCollection, f } from '@apick/core';

const todos = defineCollection('todos', {
  fields: {
    title: f.text({ required: true }),
    done: f.boolean({ default: false }),
  },
});

const app = await createApp({ collections: [todos] });
await app.listen(3000);
```

That is a complete, working backend: authenticated CRUD with validation at
`/v1/collections/todos/docs`, draft→publish workflow, version history and
rollback, OpenAPI 3.1 at `/openapi.json`, an agent guide at `/llms-full.txt`,
and an MCP endpoint at `/mcp` — with an embedded Postgres (PGlite), so there is
nothing to install. Point `database` at `postgres://…` when you deploy.

```bash
npx --package=@apick/core apick init my-app && cd my-app && npm i && npm start   # or copy the snippet above
```

## Why APIck exists

APIck is a from-scratch answer to the architectural problems that headless
CMSes (studied in depth: Strapi) cannot fix without breaking their ecosystems:

| Their architecture | What goes wrong | APIck's structure |
|---|---|---|
| Content model = DDL, auto-synced at boot | Renames silently drop columns; replicas race on DDL | Fixed 12-table schema owned by the library. Content models are **data**. A rename is a lossless JSONB key migration — declared in code, applied transactionally |
| Authorization in controllers, query engine beneath | Private-field filter leaks: 7 advisories in 4 years, same root cause | Authorization lives **in the query planner**. Unknown and unreadable fields are rejected at plan time — filters can't become a boolean oracle, and populate applies the *target's* policy at every hop |
| Publish = deep row cloning | Unique constraints crash in components; 5× write amplification | **Publish is a pointer move.** Versions are append-only; drafts and published are two heads of one document. Unique works everywhere, history/rollback are free |
| Cron/webhooks fire per replica; writable FS required | Double sends, no horizontal scaling | Stateless replicas. `FOR UPDATE SKIP LOCKED` job runner + claimed cron ticks: everything fires **once per cluster**, verified by test with two live instances |
| Fire-and-forget webhooks | Lost events | Transactional-outbox fan-out, HMAC-signed payloads, retries with backoff, dead-letter + replay over HTTP |
| Admin auth ≠ API auth | Two parallel permission systems | **One RBAC model.** Operator (control plane) and tenants are scopes of the same system. Keys, roles, grants, field whitelists, row conditions — all planner-enforced |

## What's in the box

- **Schema DSL** — `f.text/integer/number/boolean/datetime/date/enum/json/object/list/relation/relations/blocks`,
  with `required`, `unique` (works in nested objects), `private` (structurally
  invisible), `indexed` (opt-in DDL at migrate time), `immutable`, `default`,
  validation constraints. One definition feeds TS types, runtime validation,
  OpenAPI, MCP tools and index hints.
- **Documents** — identity is `(docId uuid7, locale, version)`. Writes are RFC 7386
  merge patches with optimistic concurrency (`ifVersion`). Append-only history,
  restore-as-new-version, publish/unpublish pointers.
- **Query language** — JSON filters (`$eq $ne $gt $gte $lt $lte $in $nin $contains
  $icontains $startsWith $endsWith $null`, `$and/$or/$not`), sort, pagination,
  one-hop populate, field projection — all **bounded** (node/sort/populate/page
  caps) so the API can't be coerced into a pathological query.
- **Saved queries** — Drupal Views, headless: parameterized, typed, cached-able,
  permission-scoped; exposed as REST endpoints *and* MCP tools.
- **Multi-tenancy** — native. Row-level isolation enforced structurally in the
  planner; `x-apick-tenant` header or a `resolveTenant(request)` hook; operator
  scope provisions and oversees tenants. Single-tenant = N=1, invisible.
- **RBAC** — built-in roles (`operator-admin`, `tenant-admin`, `content-editor`,
  `content-reader`, `public`) plus custom roles with per-field read AND write
  whitelists and row conditions (`"$me"` = caller). Additive/union semantics.
- **Auth** — hashed API keys for services/agents, plus bring-your-own-IdP:
  a `verifyToken` hook maps your JWTs (Auth0/Supabase/Clerk/…) into the same
  principal + RBAC model. One auth system, cached, revocation-safe.
- **Webhooks** — signed (`apick-signature`), at-least-once, exponential backoff,
  dead-letter, replay endpoint, per-event patterns (`doc.published:articles`).
- **Jobs & cron** — durable Postgres-native queue with retries/backoff/dead-letter/
  idempotency keys; code-defined cron (5-field or `@every:ms`), single-fire
  across replicas.
- **Event log** — one append-only stream powering webhooks, audit, history,
  interaction logging (`http.request`, `mcp.call`), and a pollable change-feed
  cursor (`GET /v1/events?afterSeq=`).
- **MCP** — stateless streamable-HTTP server at `/mcp`; schema-derived tools;
  least-privilege via the same keys; every mutation attributed in the audit log.
- **Production posture** — CORS (default-safe for bearer auth), SSRF-guarded
  webhook targets, built-in retention/pruning, graceful shutdown, liveness +
  readiness probes, request ids, OpenTelemetry spans/metrics via
  `@opentelemetry/api` (no-op until you register an SDK).
- **Portability** — `GET /v1/export` / `POST /v1/import` round-trip losslessly
  (uuid7 ids are portable); plain-SQL escape hatch — it's just Postgres.
- **Self-description** — live `/openapi.json`, `/llms.txt`, `/llms-full.txt`
  generated from the running schema.

## Tested like a consumer

There are no unit-coverage tests. Every promise above has a black-box test that
boots real instances and talks HTTP/MCP — and fails if the promise breaks:
private fields stay unfilterable, two replicas never double-fire a cron (real
Postgres, two live apps), a rename preserves data across restarts, export→import
is byte-identical, a real MCP SDK client round-trips, webhook workers refuse to
reach the private network, retention prunes on schedule. See
[`tests/blackbox/`](tests/blackbox/src) — 19 suites, 102 tests — plus 11 real-browser Playwright journeys for the CMS in [`tests/browser/`](tests/browser/src).

```bash
pnpm install && pnpm test        # Docker enables the real-Postgres suites
```

## Documentation

- [Getting started](docs/guides/getting-started.md) · [**@apick/cms** — the full CMS](docs/guides/cms.md)
- [Schema & fields](docs/guides/schema.md) · [Queries & saved queries](docs/guides/queries.md)
- [Auth & RBAC](docs/guides/auth-rbac.md) · [Multi-tenancy](docs/guides/tenancy.md)
- [Webhooks](docs/guides/webhooks.md) · [Jobs & cron](docs/guides/jobs-cron.md)
- [MCP](docs/guides/mcp.md) · [Deployment](docs/guides/deployment.md) · [Portability](docs/guides/portability.md)
- [Extending](docs/guides/extending.md) · [Architecture decisions](docs/decisions/0001-architecture.md)
- Machine-readable: [llms.txt](docs/llms.txt) · [llms-full.txt](docs/llms-full.txt)

## Repository layout

- `packages/apick` — `@apick/core`: kernel, schema, planner, HTTP, MCP, CLI
- `packages/cms` — `@apick/cms`: admin SPA, users/sessions, themes, site, plugins
- `tests/blackbox` — the outside-in promise suite (102 tests, real Postgres via Docker)
- `tests/browser` — real-browser Playwright suite for the CMS (11 journeys)
- `examples/hello-world`, `examples/blog`, `examples/cms-demo` — runnable apps
- `docs/` — guides, ADRs, llms files

## Status & non-goals (v1)

v1 focuses on a small, stable core. Explicitly out (see
[ADR-0001](docs/decisions/0001-architecture.md)): GraphQL, media pipeline, the
OAuth-connector framework, deep multi-step durable automations,
schema-per-tenant isolation, SSE change-feed transport, i18n fallback chains.
The primitives they need (event log, durable jobs, planner-scoped tokens,
pluggable auth) are already here.

MIT licensed.
