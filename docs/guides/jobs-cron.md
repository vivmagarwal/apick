# Background jobs & cron

One durable, Postgres-native job runner powers webhooks, your background work,
and scheduled tasks. No Redis, no extra infrastructure — jobs are rows claimed
with `FOR UPDATE SKIP LOCKED`, so any number of replicas can work the same
queue without double-processing.

## Define handlers, enqueue work

```ts
const app = await createApp({
  collections,
  jobs: {
    'send-welcome': async (payload, { tenantId, attempts, db }) => {
      await emailProvider.send(payload.email);   // throw to retry
    },
  },
});

// enqueue (server-side; commits atomically if you're inside your own tx flow)
await app.enqueue({
  queue: 'send-welcome',
  payload: { email: 'a@b.c' },
  tenantId: app.defaultTenant.id,
  runAt: new Date(Date.now() + 60_000),   // optional delay
  maxAttempts: 5, backoffMs: 1000,        // exponential: 1s, 2s, 4s, …
  idempotencyKey: 'welcome:a@b.c',        // duplicate enqueues are dropped
});
```

Semantics:

- **Retries with backoff** — a throwing handler reschedules the job until
  `maxAttempts`, then it's **dead-lettered** (state `dead`), never lost.
- **Dead-letter over HTTP** — `GET /v1/jobs?state=dead`, `POST /v1/jobs/:id/replay`
  (requires `manage system:jobs`).
- **Idempotent enqueues** — `(queue, idempotencyKey)` is unique.
- **Crash rescue** — jobs stuck in `running` past the lock timeout (default 60s)
  are returned to `pending` by any live worker.
- Queue names starting with `apick.` are reserved for internals.

## Cron — fires once per cluster

```ts
await createApp({
  jobs: { 'nightly-digest': async () => { /* … */ } },
  crons: [
    { key: 'digest', schedule: '0 2 * * *', queue: 'nightly-digest' },   // 5-field cron, UTC
    { key: 'poll',   schedule: '@every:30000', queue: 'poll-upstream' }, // every 30s
  ],
});
```

- Schedules are code-defined and synced at boot; removing one from code removes it.
- The tick claims due schedules with `SKIP LOCKED` **and** enqueues with an
  idempotency key of `(cron key, scheduled instant)` — belt and braces, so a
  schedule fires exactly once cluster-wide no matter how many replicas run.
  This is verified by a test running two full app instances against one
  Postgres (`replica-single-fire.test.ts`).
- Handlers receive `{ cronKey, scheduledFor }` in the payload.

## Running workers

Every `createApp` process runs a worker + cron ticker by default. For a
dedicated worker fleet, serve HTTP with `worker: false` and run worker-only
processes (`createApp({ worker: true })` without calling `listen`). Tune with
`pollIntervalMs` (default 500), `tickIntervalMs` (default 1000) and
`jobConcurrency` (parallel handlers per process, default 5). `app.stop()`
finishes in-flight jobs before returning.

## Retention (built-in pruning)

Events, finished jobs and (optionally) version history are pruned by a
built-in daily job — cluster-single-fire like any cron:

```ts
await createApp({
  retention: {
    events:   { days: 90 },                 // default; false disables
    jobs:     { doneDays: 7, deadDays: 30 },// default; false disables
    versions: { keepLast: 50 },             // DEFAULT: keep everything
    schedule: '47 3 * * *',
  },
});
```

Guarantees: document heads and the versions they point at always survive;
events still awaiting a webhook delivery are never pruned; version history is
untouched unless you explicitly set `keepLast`.
