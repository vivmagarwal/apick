# Changelog

All notable changes to the APIck packages. Semver applies pre-1.0 as:
breaking API changes bump the minor.

## @apick/core 0.6.0 — 2026-07-16

- **Query planner: list membership filtering.** Lists of text/enum scalars now
  accept `$contains` (exact item match — `{"tags":{"$contains":"borders"}}`)
  and `$null`, via the same `jsonb_exists` mechanism as to-many relations.
  Lists of objects, `json`, `object` and `blocks` fields remain non-filterable;
  scalar lists remain unsortable. Every other operator on a scalar list is
  still rejected at plan time.

## @apick/cms 0.2.4 — 2026-07-16

- Rebuilt against @apick/core 0.6.0 (list membership filtering — the admin
  and site inherit it through the API). No CMS code changes.

## @apick/cms 0.2.3 — unreleased

- Same "APIck in one page" cheatsheet at the top of the llms docs; README links
  the CDN-hosted llms files. Docs-only.

## @apick/cms 0.2.2 — unreleased

- Ships per-package `llms.txt` + `llms-full.txt` (CMS guide + full core API),
  generated deterministically and version-stamped. Docs-only.

## @apick/cms 0.2.1 — unreleased

- Docs/scaffolder fixes: `apick-cms init` scaffold pins the CLI's own version
  (was `^0.1.0`, which never resolved); README/guide use
  `npx --package=@apick/cms apick-cms init`. No runtime changes.

## @apick/cms 0.2.0 — unreleased

- **Media library**: drag-and-drop upload UI, browse grid, and a picker built
  into every `f.image()` field; public serving at `/media/:id/:filename` with
  nosniff + sandbox-CSP hardening; a `media` collection so listings/permissions/
  webhooks/MCP all apply; pluggable storage driver (default: core blob store).
- **edodo-write** as the markdown editor (Notion/Medium WYSIWYG, Markdown as the
  value, images upload to the media library); a flush registry guarantees no
  keystroke is lost across the editor's change debounce, even on block reorder.
- **Editor niceties**: slug auto-generation from the title (until edited),
  draft autosave with a status indicator, and an unsaved-changes guard.
- **Content security**: the public site sanitizes markdown→HTML by default at
  the server-side render boundary (raw HTML dropped, link/image URL protocols
  allow-listed) — covers editor, REST API and MCP writes alike; `content:
  { sanitize: false }` opts out. (edodo-write already sanitizes the editor's
  own rendering, so no editor change was needed.)
- **Fix**: the login rate limiter is now per-CMS-instance (was module-global,
  so multiple `createCms` in one process could rate-limit each other).

## @apick/cms 0.1.0 — unreleased

Initial release: a full, themable CMS on @apick/core.

- Schema-driven admin SPA (pre-bundled Preact): listings, editor for every
  field type incl. blocks with reordering, draft/modified/published workflow,
  version history + restore, users/keys/webhooks management.
- Users & sessions: scrypt passwords in a `private` field, HMAC session
  tokens over core's BYO-IdP hook, password-change session invalidation,
  admin/editor/viewer roles with structural escalation closure.
- Themable server-rendered site: pages + posts model, code-as-theme with
  child-theme merging, escaped-by-default `html` tag, markdown via marked.
- Plugins: collections/queries/jobs/crons/routes/adminNav/theme in one unit.
- `apick-cms init` scaffolder: conventional collections/ theme/ plugins/
  layout with the framework only in node_modules.
- Tested by 9 black-box API tests + 11 real-browser Playwright tests.

## @apick/core 0.5.3 — unreleased

- llms docs now open with an "APIck in one page" cheatsheet (DSL, endpoints,
  filter grammar, invariants) so an LLM gets full working context up front.
- README links the CDN-hosted llms files (jsDelivr/unpkg) for agents. Fixed the
  package title (`# @apick/core`). Docs-only.

## @apick/core 0.5.2 — unreleased

- Ships per-package `llms.txt` + `llms-full.txt` — machine-readable API docs
  generated deterministically from the guides, version-stamped, regenerated on
  every build (drift-guarded by `pnpm llms:check`). Docs-only.

## @apick/core 0.5.1 — unreleased

- Docs/scaffolder fixes: README examples import from `@apick/core` (not the
  stale `apick`); `apick init` scaffold pins the CLI's own version so
  `npm install` resolves. No runtime changes.

## @apick/core 0.5.0 — unreleased

- `f.image()` field (image-URL text with a media-picker hint).
- A minimal blob store (`putBlob`/`getBlob`/`deleteBlob`, migration 003) —
  server-side binary storage primitive used by @apick/cms media; no HTTP
  surface in core. Tenant-scoped, zero-config, replica-safe.
- Exported `can`/`assertCan` for extension routes.

## @apick/core 0.4.0 — unreleased

Renamed from `apick` to `@apick/core` (supersedes the unrelated experimental
0.3.x kernel previously published under this name). Additions for consumers
like @apick/cms: code-defined `roles` config, `rootIndex: false`, FieldDef
introspection on /schema (writers), `publishedVersion` in document envelopes.

## apick 0.1.0 (now @apick/core)

Initial release.

- Schema DSL (`defineCollection`, `f.*`): text/markdown/email/uri/slug/integer/
  number/boolean/datetime/date/enum/json/object/list/relation/relations/blocks;
  `required`, `unique` (incl. nested objects), `private`, `indexed`,
  `immutable`, `default`, `renamedFields` (lossless renames).
- Documents: append-only versions, RFC 7386 merge-patch writes, optimistic
  concurrency, pointer-publish, history + restore, locales in identity.
- Query planner: JSON filter grammar, sort, pagination, one-hop populate,
  field projection — authorization and tenancy enforced structurally, reads
  bounded by hard caps.
- RBAC: one model with operator + tenant scopes; built-in and custom roles;
  read AND write field whitelists; row conditions with `$me`.
- Auth: hashed API keys; bring-your-own-IdP via `auth.verifyToken`; TTL'd
  auth caches with same-instance invalidation.
- Multi-tenancy: row-level isolation in the planner; `x-apick-tenant` /
  `resolveTenant`; operator provisioning APIs; tenant suspension.
- Webhooks: transactional-outbox fan-out, HMAC signatures, retries/backoff,
  dead-letter + replay, SSRF guard (public-only targets in production).
- Jobs & cron: SKIP-LOCKED durable queue, configurable concurrency,
  idempotency keys, crash rescue, cluster-single-fire cron.
- Retention: built-in pruning for events/finished jobs/version history.
- HTTP: Hono app + zero-dep Node adapter, CORS, request ids, liveness +
  readiness, graceful shutdown, OpenAPI 3.1, llms.txt/llms-full.txt.
- MCP: stateless streamable-HTTP server, schema-derived tools, saved-query
  tools, audited + least-privilege.
- Observability: structured logs, interaction event log, OpenTelemetry spans
  and metrics via @opentelemetry/api (no-op without a host SDK).
- Portability: lossless export/import; UUIDv7 ids; plain-SQL escape hatch.
- CLI: `apick init | migrate | status`.
