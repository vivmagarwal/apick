import type { Queryable } from './db.js';
import { uuidv7 } from './ids.js';
import { sql } from './sql.js';

/**
 * The append-only event log — APIck's keystone. Everything that happens is an
 * event; webhooks, audit, history, the change feed and interaction logging are
 * all readers of this one table. Events are written in the SAME transaction as
 * the state change they describe (transactional outbox), so an event exists
 * if and only if the change committed.
 */
export interface EventActor {
  principalId: string | null;
  via: 'api' | 'mcp' | 'system' | 'cli';
  keyId?: string;
}

export interface AppendEventInput {
  tenantId: string | null;
  type: string;
  actor: EventActor;
  subject: Record<string, unknown>;
  payload?: Record<string, unknown>;
}

export interface EventRow {
  id: string;
  seq: string;
  tenant_id: string | null;
  type: string;
  actor: EventActor;
  subject: Record<string, unknown>;
  payload: Record<string, unknown>;
  created_at: Date;
}

export async function appendEvent(tx: Queryable, input: AppendEventInput): Promise<EventRow> {
  const id = uuidv7();
  const { rows } = await tx.query<EventRow>(sql`
    insert into apick_events (id, tenant_id, type, actor, subject, payload)
    values (${id}, ${input.tenantId}, ${input.type}, ${JSON.stringify(input.actor)}, ${JSON.stringify(input.subject)}, ${JSON.stringify(input.payload ?? {})})
    returning id, seq::text as seq, tenant_id, type, actor, subject, payload, created_at
  `);
  return rows[0]!;
}

export interface ReadEventsOptions {
  tenantId?: string | null;
  types?: string[];
  afterSeq?: string;
  limit?: number;
}

export async function readEvents(tx: Queryable, opts: ReadEventsOptions = {}): Promise<EventRow[]> {
  const conds = [sql.raw('true')];
  if (opts.tenantId !== undefined) {
    conds.push(opts.tenantId === null ? sql.raw('tenant_id is null') : sql`tenant_id = ${opts.tenantId}`);
  }
  if (opts.types && opts.types.length > 0) {
    conds.push(sql`type = any(${opts.types})`);
  }
  if (opts.afterSeq !== undefined) {
    conds.push(sql`seq > ${opts.afterSeq}::bigint`);
  }
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  const { rows } = await tx.query<EventRow>(sql`
    select id, seq::text as seq, tenant_id, type, actor, subject, payload, created_at
    from apick_events
    where ${sql.join(conds, ' and ')}
    order by seq asc
    limit ${limit}
  `);
  return rows;
}
