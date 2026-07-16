# Changelog

All notable changes to the `apick` package. Semver applies from 0.1.0:
breaking API changes bump the minor pre-1.0.

## 0.1.0 — unreleased

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
