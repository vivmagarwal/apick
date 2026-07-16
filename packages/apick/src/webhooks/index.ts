import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db, Queryable } from '../kernel/db.js';
import { errors } from '../kernel/errors.js';
import type { EventRow } from '../kernel/events.js';
import { uuidv7 } from '../kernel/ids.js';
import { enqueueJob, type JobRow } from '../kernel/jobs.js';
import { sql } from '../kernel/sql.js';

/**
 * Reliable webhooks, not fire-and-forget:
 * - fan-out happens IN the same transaction as the event (transactional outbox)
 * - deliveries ride the durable job runner: retries with exponential backoff,
 *   then dead-letter; a delivery record survives for inspection and replay
 * - payloads are HMAC-SHA256 signed (`apick-signature: t=…,v1=…`) and carry a
 *   delivery id consumers can use as an idempotency key (delivery is
 *   at-least-once by design)
 */

export const WEBHOOK_QUEUE = 'apick.webhook';

export interface WebhookRow {
  id: string;
  tenant_id: string;
  name: string;
  url: string;
  secret: string;
  events: string[];
  headers: Record<string, string>;
  enabled: boolean;
  created_at: Date;
}

export interface DeliveryRow {
  id: string;
  webhook_id: string;
  tenant_id: string;
  event_id: string;
  state: 'pending' | 'success' | 'dead';
  attempts: number;
  last_status: number | null;
  last_error: string | null;
  created_at: Date;
  delivered_at: Date | null;
}

/** Does an event type match a subscription pattern? Patterns: '*', 'doc.*', 'doc.created', 'doc.created:articles'. */
export function eventMatches(pattern: string, eventType: string, collection: string | null): boolean {
  const [typePattern, collectionPattern] = pattern.split(':');
  if (collectionPattern && collectionPattern !== collection) return false;
  if (typePattern === '*') return true;
  if (typePattern!.endsWith('.*')) return eventType.startsWith(typePattern!.slice(0, -1));
  return typePattern === eventType;
}

export interface WebhookRetryPolicy {
  maxAttempts: number;
  backoffMs: number;
}

export const DEFAULT_WEBHOOK_RETRY: WebhookRetryPolicy = { maxAttempts: 6, backoffMs: 1000 };

/** Runs inside the write transaction (StoreContext.onEvent). */
export async function fanoutEvent(tx: Queryable, event: EventRow, retry: WebhookRetryPolicy = DEFAULT_WEBHOOK_RETRY): Promise<void> {
  if (!event.tenant_id) return;
  const { rows: hooks } = await tx.query<WebhookRow>(sql`
    select * from apick_webhooks where tenant_id = ${event.tenant_id} and enabled
  `);
  const collection = typeof event.subject['collection'] === 'string' ? (event.subject['collection'] as string) : null;
  for (const hook of hooks) {
    if (!hook.events.some((p) => eventMatches(p, event.type, collection))) continue;
    const deliveryId = uuidv7();
    const { rows } = await tx.query<{ id: string }>(sql`
      insert into apick_deliveries (id, webhook_id, tenant_id, event_id)
      values (${deliveryId}, ${hook.id}, ${event.tenant_id}, ${event.id})
      on conflict (webhook_id, event_id) do nothing
      returning id
    `);
    if (rows.length === 0) continue; // already fanned out
    await enqueueJob(tx, {
      queue: WEBHOOK_QUEUE,
      tenantId: event.tenant_id,
      payload: { deliveryId },
      idempotencyKey: `wh:${deliveryId}`,
      maxAttempts: retry.maxAttempts,
      backoffMs: retry.backoffMs,
    });
  }
}

export function signPayload(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/** For webhook consumers: verify the `apick-signature` header. */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  signatureHeader: string,
  options: { toleranceMs?: number; now?: number } = {},
): boolean {
  const parts = Object.fromEntries(signatureHeader.split(',').map((p) => p.split('=') as [string, string]));
  const t = parts['t'];
  const v1 = parts['v1'];
  if (!t || !v1) return false;
  const tolerance = options.toleranceMs ?? 5 * 60_000;
  const now = options.now ?? Date.now();
  if (Math.abs(now - Number.parseInt(t, 10)) > tolerance) return false;
  const expected = signPayload(secret, t, body);
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface DeliveryHandlerOptions {
  timeoutMs?: number;
  /** Test seam: swap the HTTP transport. */
  fetchImpl?: typeof fetch;
}

/** The job handler for WEBHOOK_QUEUE. Throwing triggers the runner's retry/backoff/dead-letter path. */
export function createDeliveryHandler(db: Db, options: DeliveryHandlerOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return async (job: JobRow): Promise<void> => {
    const deliveryId = job.payload['deliveryId'] as string;
    const { rows } = await db.query<DeliveryRow & { url: string; secret: string; headers: Record<string, string>; enabled: boolean; event_type: string; subject: Record<string, unknown>; event_payload: Record<string, unknown>; event_created_at: Date }>(sql`
      select d.*, w.url, w.secret, w.headers, w.enabled,
             e.type as event_type, e.subject, e.payload as event_payload, e.created_at as event_created_at
      from apick_deliveries d
      join apick_webhooks w on w.id = d.webhook_id
      join apick_events e on e.id = d.event_id
      where d.id = ${deliveryId}
    `);
    const delivery = rows[0];
    if (!delivery || delivery.state === 'success') return;
    if (!delivery.enabled) {
      await db.query(sql`update apick_deliveries set state = 'dead', last_error = 'webhook disabled' where id = ${deliveryId}`);
      return;
    }

    const body = JSON.stringify({
      id: delivery.event_id,
      deliveryId,
      type: delivery.event_type,
      tenantId: delivery.tenant_id,
      subject: delivery.subject,
      payload: delivery.event_payload,
      createdAt: delivery.event_created_at.toISOString(),
      attempt: job.attempts,
    });
    const timestamp = String(Date.now());
    const signature = `t=${timestamp},v1=${signPayload(delivery.secret, timestamp, body)}`;

    let status: number | null = null;
    let error: string | null = null;
    try {
      const res = await fetchImpl(delivery.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'apick-webhooks/1',
          'apick-signature': signature,
          'apick-event-id': delivery.event_id,
          'apick-delivery-id': deliveryId,
          'apick-event-type': delivery.event_type,
          ...delivery.headers,
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = res.status;
      if (res.ok) {
        await db.query(sql`
          update apick_deliveries
          set state = 'success', attempts = ${job.attempts}, last_status = ${status}, last_error = null, delivered_at = now()
          where id = ${deliveryId}
        `);
        return;
      }
      error = `HTTP ${status}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const finalAttempt = job.attempts >= job.max_attempts;
    await db.query(sql`
      update apick_deliveries
      set state = ${finalAttempt ? 'dead' : 'pending'}, attempts = ${job.attempts}, last_status = ${status}, last_error = ${error},
          next_attempt_at = ${finalAttempt ? null : new Date(Date.now() + job.backoff_ms * 2 ** (job.attempts - 1))}
      where id = ${deliveryId}
    `);
    throw new Error(`Webhook delivery failed: ${error}`);
  };
}

// -- management ----------------------------------------------------------------

export async function createWebhook(
  db: Queryable,
  input: { tenantId: string; name: string; url: string; events?: string[]; headers?: Record<string, string>; secret?: string },
): Promise<WebhookRow & { secret: string }> {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    throw errors.validation('Webhook url is not a valid URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw errors.validation('Webhook url must be http(s)');
  const id = uuidv7();
  const secret = input.secret ?? `whsec_${randomBytes(24).toString('base64url')}`;
  const { rows } = await db.query<WebhookRow>(sql`
    insert into apick_webhooks (id, tenant_id, name, url, secret, events, headers)
    values (${id}, ${input.tenantId}, ${input.name}, ${input.url}, ${secret}, ${JSON.stringify(input.events ?? ['*'])}, ${JSON.stringify(input.headers ?? {})})
    returning *
  `);
  return { ...rows[0]!, secret };
}

export async function replayDelivery(db: Db, tenantId: string, deliveryId: string, retry: WebhookRetryPolicy = DEFAULT_WEBHOOK_RETRY): Promise<boolean> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: string; attempts: number }>(sql`
      update apick_deliveries set state = 'pending', last_error = null
      where id = ${deliveryId} and tenant_id = ${tenantId} and state = 'dead'
      returning id, attempts
    `);
    const row = rows[0];
    if (!row) return false;
    await enqueueJob(tx, {
      queue: WEBHOOK_QUEUE,
      tenantId,
      payload: { deliveryId },
      idempotencyKey: `wh:${deliveryId}:replay:${row.attempts}`,
      maxAttempts: retry.maxAttempts,
      backoffMs: retry.backoffMs,
    });
    return true;
  });
}
