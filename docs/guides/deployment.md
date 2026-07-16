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

## Observability

- Structured JSON logs (pino-shaped) on stdout; inject your own with `logger`.
- The event log doubles as the interaction/audit trail (`/v1/events`) —
  `http.request` and `mcp.call` events carry status + latency, with request
  *bodies* deliberately excluded and private fields redacted from doc events.
- `interactionLog: 'all' | 'mutations' | 'off'` (default `mutations`).
