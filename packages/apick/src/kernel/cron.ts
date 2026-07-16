import type { Db } from './db.js';
import { uuidv7 } from './ids.js';
import { enqueueJob } from './jobs.js';
import type { Logger } from './log.js';
import { silentLogger } from './log.js';
import { sql } from './sql.js';

/**
 * Cluster-safe scheduler. Any number of replicas may run the tick loop:
 * due rows are claimed with FOR UPDATE SKIP LOCKED and the enqueued job
 * carries an idempotency key of (cron key, scheduled time), so a schedule
 * fires exactly once cluster-wide — the structural fix for Strapi's
 * once-per-replica cron double-fire.
 *
 * Schedules: standard 5-field cron (UTC) or `@every:<ms>` for intervals.
 */

interface CronField {
  values: Set<number> | null; // null = any
}

interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
}

function parseField(spec: string, min: number, max: number): CronField {
  if (spec === '*') return { values: null };
  const values = new Set<number>();
  for (const part of spec.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? Number.parseInt(stepPart, 10) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step: ${part}`);
    let lo: number;
    let hi: number;
    if (rangePart === '*' || rangePart === '') {
      lo = min;
      hi = max;
    } else if (rangePart!.includes('-')) {
      const [a, b] = rangePart!.split('-');
      lo = Number.parseInt(a!, 10);
      hi = Number.parseInt(b!, 10);
    } else {
      lo = hi = Number.parseInt(rangePart!, 10);
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`Invalid cron field: ${part} (allowed ${min}-${max})`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values };
}

export function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Cron expression must have 5 fields, got: "${expr}"`);
  return {
    minute: parseField(parts[0]!, 0, 59),
    hour: parseField(parts[1]!, 0, 23),
    dom: parseField(parts[2]!, 1, 31),
    month: parseField(parts[3]!, 1, 12),
    dow: parseField(parts[4]!, 0, 6), // 0 = Sunday
  };
}

function fieldMatches(field: CronField, value: number): boolean {
  return field.values === null || field.values.has(value);
}

/** Next fire time strictly after `from`, in UTC. */
export function nextCronTime(schedule: string, from: Date): Date {
  if (schedule.startsWith('@every:')) {
    const ms = Number.parseInt(schedule.slice('@every:'.length), 10);
    if (!Number.isInteger(ms) || ms < 100) throw new Error(`Invalid @every schedule: ${schedule}`);
    return new Date(from.getTime() + ms);
  }
  const cron = parseCron(schedule);
  const t = new Date(from.getTime());
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(t.getUTCMinutes() + 1);
  // Standard cron: when both dom and dow are restricted, either may match.
  const domRestricted = cron.dom.values !== null;
  const dowRestricted = cron.dow.values !== null;
  for (let i = 0; i < 5 * 366 * 24 * 60; i++) {
    const dayOk =
      domRestricted && dowRestricted
        ? fieldMatches(cron.dom, t.getUTCDate()) || fieldMatches(cron.dow, t.getUTCDay())
        : fieldMatches(cron.dom, t.getUTCDate()) && fieldMatches(cron.dow, t.getUTCDay());
    if (
      fieldMatches(cron.month, t.getUTCMonth() + 1) &&
      dayOk &&
      fieldMatches(cron.hour, t.getUTCHours()) &&
      fieldMatches(cron.minute, t.getUTCMinutes())
    ) {
      return t;
    }
    t.setUTCMinutes(t.getUTCMinutes() + 1);
  }
  throw new Error(`Cron expression never fires: ${schedule}`);
}

export interface CronDefinition {
  key: string;
  schedule: string;
  queue: string;
  payload?: Record<string, unknown>;
  tenantId?: string | null;
  enabled?: boolean;
}

export class CronScheduler {
  #db: Db;
  #defs: CronDefinition[];
  #tickIntervalMs: number;
  #log: Logger;
  #running = false;
  #timer: NodeJS.Timeout | null = null;
  #activeTick: Promise<void> | null = null;

  constructor(db: Db, defs: CronDefinition[], options: { tickIntervalMs?: number; logger?: Logger } = {}) {
    this.#db = db;
    this.#defs = defs;
    this.#tickIntervalMs = options.tickIntervalMs ?? 1000;
    this.#log = (options.logger ?? silentLogger).child({ component: 'cron' });
  }

  /** Upsert code-defined schedules; remove rows whose definition is gone. */
  async sync(): Promise<void> {
    for (const def of this.#defs) {
      nextCronTime(def.schedule, new Date()); // validate early
      await this.#db.transaction(async (tx) => {
        const { rows } = await tx.query<{ id: string; schedule: string }>(sql`
          select id, schedule from apick_crons
          where key = ${def.key}
            and tenant_id is not distinct from ${def.tenantId ?? null}
          for update
        `);
        const existing = rows[0];
        if (!existing) {
          await tx.query(sql`
            insert into apick_crons (id, tenant_id, key, schedule, queue, payload, enabled, next_run_at)
            values (${uuidv7()}, ${def.tenantId ?? null}, ${def.key}, ${def.schedule}, ${def.queue},
                    ${JSON.stringify(def.payload ?? {})}, ${def.enabled ?? true}, ${nextCronTime(def.schedule, new Date())})
          `);
        } else {
          const scheduleChanged = existing.schedule !== def.schedule;
          await tx.query(sql`
            update apick_crons
            set schedule = ${def.schedule}, queue = ${def.queue}, payload = ${JSON.stringify(def.payload ?? {})},
                enabled = ${def.enabled ?? true},
                next_run_at = ${scheduleChanged ? nextCronTime(def.schedule, new Date()) : sql.raw('next_run_at')}
            where id = ${existing.id}
          `);
        }
      });
    }
    // Drop schedules no longer defined in code (they cannot fire correctly anymore).
    const keys = this.#defs.map((d) => d.key);
    await this.#db.query(
      keys.length > 0 ? sql`delete from apick_crons where not (key = any(${keys}))` : sql`delete from apick_crons`,
    );
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    const tick = async (): Promise<void> => {
      if (!this.#running) return;
      try {
        await this.tickOnce();
      } catch (err) {
        this.#log.error('cron tick error', { error: String(err) });
      }
      if (!this.#running) return;
      this.#timer = setTimeout(() => {
        this.#activeTick = tick();
      }, this.#tickIntervalMs);
    };
    this.#activeTick = tick();
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    await this.#activeTick?.catch(() => {});
  }

  /** Claim + enqueue everything due. Safe to run on every replica concurrently. */
  async tickOnce(): Promise<number> {
    return this.#db.transaction(async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        tenant_id: string | null;
        key: string;
        schedule: string;
        queue: string;
        payload: Record<string, unknown>;
        next_run_at: Date;
      }>(sql`
        select id, tenant_id, key, schedule, queue, payload, next_run_at
        from apick_crons
        where enabled and next_run_at <= now()
        order by next_run_at
        limit 50
        for update skip locked
      `);
      for (const cron of rows) {
        const scheduledFor = cron.next_run_at.toISOString();
        await enqueueJob(tx, {
          queue: cron.queue,
          tenantId: cron.tenant_id,
          payload: { ...cron.payload, cronKey: cron.key, scheduledFor },
          idempotencyKey: `cron:${cron.tenant_id ?? 'operator'}:${cron.key}:${scheduledFor}`,
        });
        await tx.query(sql`
          update apick_crons
          set last_run_at = now(), next_run_at = ${nextCronTime(cron.schedule, new Date())}
          where id = ${cron.id}
        `);
      }
      if (rows.length > 0) this.#log.debug('cron fired', { count: rows.length });
      return rows.length;
    });
  }
}
