# Deployment

## Database

APIck is Postgres-generic (Postgres ≥ 14): AWS RDS, Neon, **Supabase**
(first-class target — it *is* Postgres; APIck deliberately doesn't build on
PostgREST or GoTrue so there's no lock-in), Cloud SQL, or self-hosted.

```bash
APICK_DATABASE_URL=postgres://user:pass@host:5432/db node server.js
```

Local dev needs nothing: the embedded PGlite database (`pglite://./.apick-data`)
is real Postgres (v17 WASM) with identical SQL semantics, so dev/prod parity
holds. `pglite://memory` is ideal for tests. **No Docker anywhere** — PGlite
gives the SQLite experience (a directory in your project, in-process, zero
install) without SQLite's dialect drift: it IS Postgres, so what works in dev
works in prod. APIck deliberately supports exactly one SQL dialect — Strapi's
multi-dialect support (SQLite/MySQL/Postgres) is a recurring source of its
subtle bugs, and we refuse the whole class.

## Several apps in one database — schema isolation

One Postgres (or one Supabase project) can host **many APIck apps, plus your
existing tables, without touching each other**. Give each app its own schema —
created automatically at boot, everything APIck does stays inside it:

```ts
await createApp({ databaseSchema: 'apick_my_blog' });   // app 1
await createApp({ databaseSchema: 'apick_my_shop' });   // app 2 — same DB, zero contact
```

Equivalently: `APICK_DATABASE_URL=postgres://…/db?schema=apick_my_blog` or the
`APICK_DATABASE_SCHEMA` env var. Schema names must match `[a-z_][a-z0-9_]*`.

- **Existing databases are safe**: APIck creates and uses only its own schema;
  tables in `public` (or anywhere else) are never read or written. Booting
  against a database that has other tables *without* a schema logs a warning
  suggesting one — it works, but isolation is better.
- **Supabase note**: a custom schema is also a hard safety boundary — PostgREST
  serves only the schemas you explicitly expose, so APIck's tables (which rely
  on APIck's planner, not RLS) are unreachable through the Supabase REST API.
- **Pooler note**: a per-connection `search_path` needs a **direct connection
  or a session-mode pooler** (e.g. Supavisor on port 5432). Transaction-mode
  poolers share server sessions and cannot hold it — APIck verifies at boot
  and fails fast with a clear error instead of writing to the wrong schema.
- Migration advisory locks are keyed per schema, so co-hosted apps never
  serialize each other's deploys.

## Migrations are explicit — the server never runs DDL at boot

- Against **PGlite** (dev), `createApp` applies APIck's internal migrations
  automatically (`migrate: 'apply'` is the default there).
- Against **Postgres**, the default is `migrate: 'check'`: the server *refuses
  to start* if migrations are pending, with instructions. Apply them as a
  deploy step:

```bash
npx apick migrate --database $APICK_DATABASE_URL          # kernel tables
npx apick migrate --database $APICK_DATABASE_URL --app ./dist/schema.js
# --app also creates the opt-in `indexed` field indexes (the only user-model DDL)
npx apick status  --database $APICK_DATABASE_URL
```

(Or opt in with `migrate: 'apply'` if boot-time migration fits your platform.)

Content-model changes never need migrations — models are data. Declared
`renamedFields` are applied at startup as lossless transactional JSONB key
migrations (see [schema.md](schema.md)).

## Horizontal scaling

APIck is stateless: no writable filesystem, no sticky sessions, no
leader election. Run N replicas against one Postgres:

- every replica serves HTTP;
- every replica runs the job worker + cron ticker by default — jobs are claimed
  with `SKIP LOCKED`, cron instants are idempotency-keyed, webhooks deliver
  once (all verified by the two-replica test suite);
- to separate concerns, run web processes with `worker: false` and dedicated
  worker processes that never `listen()`.

## Mounting inside your own server

`createApp` returns a fetch handler — mount it under Next.js, an existing Hono
app, Bun, or anything fetch-native; or add routes to `app.hono` directly via
`extend`. TLS, custom domains and per-tenant routing belong to your proxy
(Caddy on-demand TLS / Cloudflare for SaaS) — give APIck a `resolveTenant`
hook and it scopes everything.

## Secrets & keys

- Set `rootKey` from your secret manager for reproducible installs (otherwise
  it's generated and printed once on first boot).
- **Lost or leaked root key**: `apick key rotate-root --database $URL` mints a
  new one and revokes the old (direct-DB, works without any valid key);
  `apick key list` shows active keys (labels + timestamps, never tokens).
- **PaaS note**: `app.listen()` with no arguments honors an injected `PORT`
  env and binds `0.0.0.0` when it does (HOST overrides; explicit args win) —
  DigitalOcean/Railway/Fly/Render work with zero configuration.
- API keys are stored hashed (SHA-256); webhook secrets are stored to sign
  payloads. Use scoped keys with `expiresAt` for CI and agents.

## CORS

Enabled for all origins by default — safe because auth is bearer-token based
(no cookies, so no CSRF surface). Restrict or disable per install:

```ts
await createApp({ cors: { origins: ['https://app.example.com'] } }); // or cors: false
```

## Probes & shutdown

- `GET /health` — liveness (no dependencies)
- `GET /health/ready` — readiness (database reachable); returns 503 otherwise
- `app.stop({ gracefulMs })` — stops accepting connections, drains in-flight
  HTTP (default 10s), finishes in-flight jobs, then closes the database. Wire
  it to SIGTERM:

```ts
process.on('SIGTERM', () => app.stop().then(() => process.exit(0)));
```

## Retention

Events and finished jobs are pruned automatically (90/7/30-day defaults);
version history only if you opt in. See [jobs-cron.md](jobs-cron.md#retention-built-in-pruning).

## Performance notes

- Auth lookups are cached per instance (`authCacheTtlMs`, default 5s; see
  [auth-rbac.md](auth-rbac.md#caching--revocation) for revocation semantics).
- `scripts/bench.mjs` measures the full HTTP stack; embedded PGlite is a
  single connection (fine for dev), real Postgres with the pool is what
  production numbers should be taken on.

## Observability

- Structured JSON logs (pino-shaped) on stdout; inject your own with `logger`.
- Every response carries `x-request-id` (yours is propagated if well-formed).
- **OpenTelemetry out of the box**: APIck instruments against
  `@opentelemetry/api` — register any OTel SDK in your process (NodeSDK, a
  tracer provider) and you get `apick.http.request`, `apick.job.run`,
  `apick.mcp.tool_call` spans plus request-duration histograms and
  job/webhook/MCP counters. Without an SDK it's all zero-cost no-ops.
- The event log doubles as the interaction/audit trail (`/v1/events`) —
  `http.request` and `mcp.call` events carry status + latency, with request
  *bodies* deliberately excluded and private fields redacted from doc events.
- `interactionLog: 'all' | 'mutations' | 'off'` (default `mutations`).
