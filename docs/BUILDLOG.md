# Build log

Running plan-of-record + progress. Newest state at top of each phase. Keep this
accurate — it is the re-orientation point for long sessions.

## Phase plan

- [ ] **P0 scaffold** — pnpm workspace, tsconfig, vitest, package `apick`, blackbox test pkg
- [ ] **P1 kernel** — db layer (pg + PGlite), internal migrations, uuidv7, event log, job runner (SKIP LOCKED), cron single-fire
- [ ] **P2 identity** — tenants, operator scope, principals, API keys, roles/permissions, resolveTenant
- [ ] **P3 content** — schema DSL (fields → TypeBox/JSON Schema/TS types), collections registry, document CRUD as patches, versions, publish-pointer, uniques, edges
- [ ] **P4 planner** — filter/sort/paginate/populate compiler with structural authz + tenant scoping, cost budget, saved queries
- [ ] **P5 http** — Hono app, REST routes, error contract, OpenAPI, llms.txt endpoints
- [ ] **P6 webhooks** — subscriptions, HMAC signing, retries/backoff, dead-letter, replay
- [ ] **P7 mcp** — MCP server (streamable HTTP) with schema-derived tools, scoped tokens, audited mutations
- [ ] **P8 dx** — hello-world example (<1 min, zero Docker), CLI (`apick migrate`, `apick keys`, …), export/import
- [ ] **P9 docs** — README, guides, llms.txt + llms-full.txt, promise→test matrix

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
