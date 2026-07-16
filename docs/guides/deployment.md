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
holds. `pglite://memory` is ideal for tests.

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
