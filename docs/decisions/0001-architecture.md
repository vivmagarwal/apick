# ADR-0001: APIck v1 architecture

Status: accepted · Date: 2026-07-16

APIck (API Construction Kit) is a pure-headless, AI-first application platform — a
library you mount, not a framework that owns `main()`. Strapi is a read-only
reference (`_strapi_reference/`, gitignored); nothing is forked. Every decision
below traces to a verified Strapi pain point or a wishlist promise.

## Stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript, ESM-only, Node ≥ 22 | one schema feeds types+validation+OpenAPI+MCP; no CJS baggage |
| HTTP | Hono | fetch-native, mounts inside any server (Node/Bun/Next/etc.), tiny |
| Database | Postgres-generic: `pg` driver for prod, embedded PGlite for dev/tests | zero-Docker hello-world; Supabase is a deploy target, not a dependency |
| Schema DSL | own field builder compiling to TypeBox/JSON Schema | CMS semantics (relations, unique, private, indexed, localized) first-class; JSON Schema falls out for OpenAPI + MCP; `Static<>`-style TS types |
| Validation | TypeBox TypeCompiler | fast, dependency-light, JSON-Schema-native |
| Jobs | own durable runner on `SELECT … FOR UPDATE SKIP LOCKED` | replica-safe by construction; identical semantics on pg and PGlite; no heavyweight dep |
| IDs | UUIDv7 (own ~20-line impl) | sortable + globally portable (fixes Strapi's incremental-id transfer bug, RFC #52) |
| Tests | vitest, black-box only (HTTP + MCP clients) | tests are consumers; real Postgres via Docker for replica tests, PGlite otherwise |
| Logging | structured JSON (pino-compatible shape), per-request query trace | observability built in |

## Physical data model — fixed schema, content model is data

The library owns ~12 `apick_*` tables. **User content models never create tables.**
The only DDL a user's model can ever cause is `CREATE INDEX` (opt-in `indexed`
fields, applied via explicit `apick migrate`, never at boot). This kills the
Strapi auto-migration/data-loss class outright: a field rename is a JSONB key
migration (explicit, reviewable, reversible), never DROP+ADD.

- `apick_meta` — internal schema version (library migrations are versioned, explicit, forward-only).
- `apick_tenants` — first-class tenant scope. Row-level isolation, enforced in the query planner.
- `apick_principals`, `apick_api_keys`, `apick_roles`, `apick_role_grants`, `apick_permissions` — ONE auth/RBAC model. Scope = `operator` (tenant_id NULL) or a tenant. No parallel auth systems.
- `apick_collections` — registry snapshot of code-defined schemas (drift detection, introspection); code is authoritative.
- `apick_doc_versions` — append-only. Every write is a patch producing a new version row. History/audit/rollback are structural, free, not an upsell.
- `apick_docs` — head pointers per (tenant, collection, doc_id, locale): `draft_version_id`, `published_version_id`. **Publish is a pointer move, never a row clone** (kills Strapi's clone-on-publish write amplification and the unique-crash class).
- `apick_edges` — derived index of relation refs in head versions (reverse lookups, join planning). Relations live IN document data, so versions capture them.
- `apick_uniques` — derived unique index per logical document (unique works in nested components, unlike Strapi).
- `apick_events` — append-only event log. Seven faces: webhooks, audit, history, change feed, automations, cron bookkeeping, interaction/eval logging.
- `apick_jobs` — durable queue (attempts, backoff, dead-letter, idempotency keys).
- `apick_crons` — schedules; a claim-based tick guarantees single-fire cluster-wide.
- `apick_webhooks` + `apick_deliveries` — subscriptions and delivery records (signed, retried, replayable).

## Authorization: in the query planner, structurally

The planner compiles requests (filter/sort/populate/fields) **only over fields the
principal can read**. An unknown or unreadable field in a filter is a 400/403 at
plan time — it never reaches SQL. Row conditions (tenant + RBAC conditions) are
ANDed into every node of the plan, including populate traversals. This is the
structural fix for Strapi's 7-advisories-in-4-years private-field-oracle class.
Reads are bounded: populate depth, page size, and total plan cost are budgeted.

## Scopes: operator above tenants, one model

`operator` is its own scope (not tenant-0). Bootstrap creates the operator, a
root API key, and a default tenant, so hello-world never thinks about tenancy.
`resolveTenant(request)` hook maps host/header/token → tenant; TLS/domains are
the deployer's job.

## The UI decision (settled)

**(a) developers/agents only.** No admin UI ships — not in core, not v1. Humans
use apps built on APIck; agents use MCP. A reference UI, if ever, is a separate
repo on the public API. This stops resurfacing per-feature.

## v1 non-goals (explicit, so simple wins)

GraphQL; media/upload pipeline (bring object storage; a media collection pattern
is documented); the OAuth-broker integration framework + connectors; deep
multi-step durable automations (v1 ships: event triggers → job handlers with
retries — the substrate, not the DSL); i18n fallback chains (locale IS in the
identity from day one; matrix semantics beyond that are post-v1); schema-per-
tenant isolation; realtime change-feed transport (the log is there; SSE later).
