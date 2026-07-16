# Extending APIck

APIck's power comes from composable primitives plus a small, stable surface —
deliberately **not** from letting extensions override internals (the pattern
that makes Drupal/Strapi upgrades break). Everything below is public API.

## Custom endpoints

You own `main()`; APIck is a library. Add routes to the same Hono app:

```ts
const app = await createApp({
  collections,
  extend: (hono, core) => {
    hono.get('/stats', async (c) => {
      const ctx = c.get('access');            // the SAME access context as core routes
      // use core.db (tagged-template sql) or the HTTP API for reads that must
      // respect RBAC. Raw SQL bypasses the planner — treat it as trusted code.
      return c.json({ ok: true, principal: ctx.principalId });
    });
  },
});
```

Or mount `app.fetch` inside any fetch-native server (Next.js route handlers,
Bun, an existing Hono/Express-with-adapter app) and keep your routes beside it.

## Background work & automation

The automation substrate is: **events → jobs**. Subscribe to the event log and
do work durably:

- register job handlers (`jobs: { queue: handler }`) with retries/dead-letter;
- schedule them (`crons: [...]`) — single-fire across replicas;
- react to data changes by polling `/v1/events?afterSeq=` or receiving your own
  webhooks (a webhook pointed at your own endpoint is a perfectly good trigger);
- enqueue follow-up work with `app.enqueue` (idempotency keys make it safe).

## Server-side building blocks

The `apick` package exports the kernel pieces extensions actually need —
`sql` (safe tagged templates), `openDb`, `uuidv7`, `ApickError`/`errors`,
`createLogger`, `verifyWebhookSignature`, plus all schema/type helpers. These
are semver-stable; internals under `src/` are not part of the contract.

## What deliberately does NOT exist

- No hook that rewrites another collection's queries or bypasses the planner.
- No plugin-provided DDL.
- No middleware injection *between* the planner and the database.

If you need behavior the primitives can't express, open an issue — the answer
will be a new capability with a test, not an override point.
