# Build log

Running plan-of-record + progress. Newest state at top of each phase. Keep this
accurate — it is the re-orientation point for long sessions.

## Phase plan

- [x] **P0 scaffold** — pnpm workspace, tsconfig, vitest, package `apick`, blackbox test pkg
- [x] **P1 kernel** — db layer (pg + PGlite), internal migrations, uuidv7, event log, job runner (SKIP LOCKED), cron single-fire
- [x] **P2 identity** — tenants, operator scope, principals, API keys, roles/permissions, resolveTenant
- [x] **P3 content** — schema DSL (fields → TypeBox/JSON Schema/TS types), collections registry, document CRUD as patches, versions, publish-pointer, uniques, edges
- [x] **P4 planner** — filter/sort/paginate/populate compiler with structural authz + tenant scoping, cost budget, saved queries
- [x] **P5 http** — Hono app, REST routes, error contract, OpenAPI, llms.txt endpoints
- [x] **P6 webhooks** — subscriptions, HMAC signing, retries/backoff, dead-letter, replay
- [x] **P7 mcp** — MCP server (streamable HTTP) with schema-derived tools, scoped tokens, audited mutations
- [x] **P8 dx** — hello-world + blog examples, CLI (`apick init/migrate/status`), export/import
- [x] **P9 docs** — README, 11 guides, llms.txt + llms-full.txt (generated via scripts/build-llms.mjs), promise→test matrix

## P10 — @apick/cms (decided 2026-07-16)

Naming pivot: the npm scope is `@apick/*`; the library package renames
`apick` → `@apick/core` (bin stays `apick`; version 0.4.0 — supersedes the old
experimental 0.3.x kernel already on npm). New package `@apick/cms`: a full
WordPress/Drupal-class CMS ON TOP of core. The original "no admin UI" rule is
resolved as: core = headless forever; the CMS ships the UI as a separate
package whose admin is a pure consumer of core's REST API (dogfood).

- [x] rename apick → @apick/core everywhere (tests/examples/docs/CLI templates)
- [x] core additions: code-defined `roles` config; `rootIndex: false`;
      FieldDef introspection on /schema; `publishedVersion` in envelopes
- [x] cms auth: cms-users collection (scrypt passwordHash PRIVATE), HMAC
      session tokens via core's BYO-IdP hook, role mapping admin/editor/viewer,
      first-run setup, deterministic internal service key
- [x] cms admin SPA: Preact+htm bundled at build (consumer never builds);
      schema-driven editor for EVERY field type incl. blocks/relations;
      publish flow, versions/restore, users/keys/webhooks pages
- [x] cms site: themable server-rendered frontend (Theme = code: templates +
      block renderers, html-escaped by default), default theme, pages+posts
      default model, markdown via marked
- [x] plugins: CmsPlugin = collections + queries + jobs/crons + routes +
      adminNav + theme overrides (thin composition over core config)
- [x] tests: blackbox API suite (auth/escalation/setup) + REAL BROWSER
      Playwright suite (tests/browser) covering the full editor journeys
- [x] docs: cms guides (cms.md), ADR-0002, READMEs, llms regen; examples/
      cms-demo restructured to the conventional layout; `apick-cms init`
      scaffolder (Drupal conventions, npm distribution). Suites at completion:
      19 blackbox files / 102 tests + 11 Playwright browser tests + visual
      screenshot QA of admin and site. Vivek's mid-build architecture check
      (2026-07-16) confirmed the built shape: core = headless soul, cms =
      consumer; his cloned-repo idea became the scaffolder convention.

## P11 — media, editor niceties, edodo-write (done 2026-07-16)

- [x] core 0.5.0: `f.image()`; blob store (migration 003, put/get/deleteBlob);
      export can/assertCan
- [x] cms 0.2.0 media library: upload UI (drag-drop + click), browse grid,
      picker per f.image() field; `/media/:id/:filename` hardened serving
      (nosniff + sandbox CSP + immutable/ETag); `media` collection; pluggable
      storage driver (default = core blob store); size + mime limits
- [x] edodo-write (vivmagarwal/edodo-write, MIT) as the markdown editor:
      bundled with the admin SPA; images upload to media; **flush registry**
      (src/admin/ui/flush.ts) pulls each editor's synchronous getMarkdown() at
      save/autosave/reorder → no keystroke lost across edodo's ~120ms change
      debounce; also fixed a latent data-loss bug (typing in one block wiping
      another mid-debounce)
- [x] editor niceties: slug auto-gen from title (until hand-edited), draft
      autosave + status indicator, unsaved-changes guard
- [x] ROOT-CAUSE FIX (not masked with retries): login rate limiter was
      module-global → multiple createCms in one process rate-limited each other
      (surfaced as browser-suite flakiness). Now per-instance. Browser harness
      made deterministic (worker:false, serial, 0 retries).
- [x] tests: +media.test.ts (blackbox, 5) → 107 total; +media.spec.ts,
      editor-niceties.spec.ts (browser) → 17 total; screenshot QA updated.
      Everything green with 0 retries.

## Promise → black-box test matrix (every wishlist promise gets a failing-if-broken test)

| Promise | Test |
|---|---|
| private field unfilterable/unsortable/unpopulatable | `authz-private-fields.test.ts` |
| tenant isolation structural | `tenant-isolation.test.ts` |
| N replicas: cron fires once | `replica-single-fire.test.ts` (real PG) |
| webhook: signed, retried, dead-letter, replay, idempotency | `webhooks-reliable.test.ts` |
| field rename preserves data | `rename-preserves-data.test.ts` |
| publish is pointer; history+rollback free | `versions-publish.test.ts` |
| bounded reads (depth/cost caps) | `bounded-reads.test.ts` |
| zero-to-api under a minute | `hello-world.test.ts` (times the real flow) |
| MCP least-privilege + attributable mutations | `mcp.test.ts` |
| export/import lossless | `portability.test.ts` |
| unique in nested data works (Strapi can't) | `uniques.test.ts` |
| one auth model operator+tenant | `rbac-scopes.test.ts` |

## Progress

- 2026-07-16: repo initialized, ADR-0001 written, scaffold starting.
- 2026-07-16: core platform built end-to-end and committed (kernel → planner →
  HTTP → webhooks → MCP), first e2e smoke green on the first full run.
- 2026-07-16: full black-box promise suite passing — 14 files / 72 tests,
  including two-live-replica single-fire on real Postgres (Docker), rename
  persistence across restarts, MCP via the real SDK client.
- 2026-07-16: CLI (`init/migrate/status`), examples (hello-world, blog),
  README, 11 guides, generated llms.txt/llms-full.txt. v0.1.0 feature-complete
  per ADR-0001 scope.
- 2026-07-16 (publish-readiness pass, requested by Vivek): CORS (default-open,
  restrictable), bring-your-own-IdP auth (`auth.verifyToken` + migration 002
  external_id + ephemeral claim roles that can never confer operator), webhook
  SSRF guard (create/patch/delivery-time, redirects refused; default follows
  db kind), built-in retention pruning (events/jobs/versions via internal
  cron), job concurrency (default 5) + graceful stop draining, auth TTL caches
  with same-instance invalidation, write-field whitelists, OpenTelemetry
  spans/metrics via @opentelemetry/api, request ids, /health/ready, graceful
  HTTP shutdown, PGlite single-process lockfile, LICENSE/SECURITY/CONTRIBUTING/
  CHANGELOG, scripts/bench.mjs. Suite now 18 files / 93 tests, all passing.
  Deliberately skipped per Vivek: npm-name check (his), GitHub/CI (deferred).

## Notable semantics decided during build (documented in guides)

- RBAC is additive/union — publicRead floors everyone on that collection;
  restrictions are meaningful on non-public collections (auth-rbac.md).
- Published-view populate resolves only published heads: an unpublished
  relation target populates as null (schema.md).
- Deleting a relation target leaves dangling refs that populate as null;
  doc.deleted events are the cleanup hook (schema.md).
- Export covers heads (draft+published), not version history (portability.md).
- `private` fields are write-only even for operator-admin over the API; the
  values exist only for server-side code and SQL (auth-rbac.md).
