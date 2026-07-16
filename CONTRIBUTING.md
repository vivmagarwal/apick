# Contributing to APIck

## Setup

```bash
pnpm install
pnpm build          # builds packages/apick (tsc)
pnpm test           # black-box suite; Docker enables the real-Postgres tests
```

Node ≥ 22 and pnpm ≥ 9 required. Docker is optional but recommended (the
replica-safety suite runs against a real Postgres container).

## The rules that keep APIck small and safe

1. **Tests are black-box.** Every test boots a real app and talks HTTP/MCP like
   a consumer. No unit tests for coverage; no imports of `src/` internals from
   tests. If you add a behavior, add the test that fails when the behavior
   breaks.
2. **Authorization lives in the query planner.** Never filter fields in a
   route handler or "hide" data in a serializer — reject at plan time.
3. **Content models are data.** No feature may generate DDL from user schemas
   (the sole exception: `indexed` fields at explicit migrate time).
4. **No override points.** Extensions compose primitives; they don't rewrite
   internals. If a primitive is missing, propose the primitive.
5. **Migrations are append-only** (`packages/apick/src/kernel/migrate.ts`) —
   never edit a shipped migration; add a new version.
6. **Every dependency must earn its place.** The runtime dep list is
   deliberately short; PRs adding dependencies need a reason a stdlib/50-line
   solution can't cover.

## Working on docs

Guides live in `docs/guides/`. After editing, regenerate the machine-readable
bundles: `node scripts/build-llms.mjs` (checked in, so diffs stay reviewable).

## Decision records

Architectural decisions go in `docs/decisions/` (ADR style); running context
lives in `docs/BUILDLOG.md`.
