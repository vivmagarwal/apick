# Webhooks

Reliable, not fire-and-forget. Fan-out happens in the **same transaction** as
the write (transactional outbox), deliveries ride the durable job runner, and
every delivery is recorded, inspectable, and replayable.

## Subscribe

```bash
POST /v1/webhooks
{
  "name": "search-indexer",
  "url": "https://indexer.example.com/hooks/apick",
  "events": ["doc.published:articles", "doc.deleted:articles"]
}
# → includes "secret": "whsec_…"   (shown once — verify signatures with it)
```

Patterns: `*` · `doc.*` · `doc.published` · `doc.published:articles`
(`:collection` suffix filters by subject collection).

Event types today: `doc.created` `doc.updated` `doc.published` `doc.unpublished`
`doc.deleted` `doc.restored` `schema.changed` `schema.fieldRenamed`
`http.request` `mcp.call`.

## Payload

```json
{
  "id": "<eventId>", "deliveryId": "<deliveryId>", "type": "doc.published",
  "tenantId": "…", "subject": { "collection": "articles", "docId": "…", "locale": "default" },
  "payload": { "version": 3, "data": { "…": "private fields are already redacted" } },
  "createdAt": "…", "attempt": 1
}
```

Headers: `apick-signature`, `apick-event-id`, `apick-delivery-id`,
`apick-event-type`.

## Verify the signature

`apick-signature: t=<unix-ms>,v1=<hex hmac-sha256(secret, t + "." + rawBody)>`

```ts
import { verifyWebhookSignature } from '@apick/core';
if (!verifyWebhookSignature(secret, rawBody, req.headers['apick-signature'])) {
  return res.status(401).end();
}
```

Constant-time compare + 5-minute timestamp tolerance built in.

## Delivery semantics

- **At-least-once.** Deduplicate on `apick-delivery-id` (retries of the same
  delivery keep the same id).
- Non-2xx or a timeout (10s) → retry with exponential backoff. Default policy:
  6 attempts, base 1s (configurable: `webhookRetry: { maxAttempts, backoffMs }`).
- Exhausted → the delivery is **dead-lettered**, never lost:

```bash
GET  /v1/webhooks/:id/deliveries?state=dead     # inspect (attempts, last_status, last_error)
POST /v1/deliveries/:id/replay                  # re-deliver after you fix the receiver
```

- Replica-safe: with N app instances polling the same database, each delivery
  is claimed by exactly one worker (`replica-single-fire.test.ts` proves it with
  two live instances).
- Disable/enable without losing config: `PATCH /v1/webhooks/:id {"enabled": false}`.

## SSRF protection

Webhook URLs are tenant-controlled input, so the delivery worker refuses
private targets by default in production: loopback, RFC1918, link-local
(cloud metadata!), CGNAT, `.local`/`.internal` hostnames — checked when a
webhook is created or its URL changed, and re-checked at every delivery (DNS
answers change). Redirects are never followed (a 3xx counts as a failed
attempt). The default follows your database: embedded PGlite (local dev)
allows private targets so localhost receivers just work; Postgres blocks them.
Override explicitly with `webhooks: { allowPrivateTargets: true | false }`.

## Change feed without webhooks

The same event log is pollable with a cursor — useful for agents and batch
consumers:

```
GET /v1/events?types=doc.*&afterSeq=<cursor>&limit=100
→ { "data": [...], "meta": { "cursor": "1042" } }
```
