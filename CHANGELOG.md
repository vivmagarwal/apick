# Changelog

All notable changes to the APIck packages. Semver applies pre-1.0 as:
breaking API changes bump the minor.

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
