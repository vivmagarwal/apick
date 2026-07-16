import type { Db, Queryable } from './db.js';
import { uuidv7 } from './ids.js';
import type { Logger } from './log.js';
import { silentLogger } from './log.js';
import { sql } from './sql.js';
import { metricsBundle, withSpan } from './telemetry.js';

/**
 * Durable, replica-safe job runner on plain Postgres.
 *
 * - Claims use `FOR UPDATE SKIP LOCKED` inside a single UPDATE, so N workers
 *   on N replicas never run the same job twice.
 * - Failures retry with exponential backoff up to max_attempts, then land in
 *   the dead-letter state (`dead`) — inspectable and replayable, never lost.
 * - `idempotency_key` dedupes enqueues (unique per queue), so producers can
 *   safely enqueue "at least once".
 * - Workers that crash mid-job are rescued: `running` rows whose lock has
 *   expired are returned to `pending` by any live worker.
 */
export interface JobRow {
  id: string;
  tenant_id: string | null;
  queue: string;
  payload: Record<string, unknown>;
  state: 'pending' | 'running' | 'done' | 'dead';
  run_at: Date;
  attempts: number;
  max_attempts: number;
  backoff_ms: number;
  idempotency_key: string | null;
  last_error: string | null;
}

export interface EnqueueJobInput {
  queue: string;
  payload?: Record<string, unknown>;
  tenantId?: string | null;
  runAt?: Date;
  maxAttempts?: number;
  backoffMs?: number;
  idempotencyKey?: string;
}

/** Enqueue inside any transaction — jobs commit atomically with the change that caused them. */
export async function enqueueJob(tx: Queryable, input: EnqueueJobInput): Promise<{ id: string; deduped: boolean }> {
  const id = uuidv7();
  const { rows } = await tx.query<{ id: string }>(sql`
    insert into apick_jobs (id, tenant_id, queue, payload, run_at, max_attempts, backoff_ms, idempotency_key)
    values (
      ${id}, ${input.tenantId ?? null}, ${input.queue}, ${JSON.stringify(input.payload ?? {})},
      ${input.runAt ?? new Date()}, ${input.maxAttempts ?? 5}, ${input.backoffMs ?? 1000}, ${input.idempotencyKey ?? null}
    )
    on conflict (queue, idempotency_key) where idempotency_key is not null do nothing
    returning id
  `);
  return rows.length > 0 ? { id: rows[0]!.id, deduped: false } : { id, deduped: true };
}

export type JobHandler = (job: JobRow) => Promise<void>;

export interface JobRunnerOptions {
  pollIntervalMs?: number;
  /** How long a claimed job may run before another worker may rescue it. */
  lockTimeoutMs?: number;
  /** How many jobs this worker runs in parallel (default 5). */
  concurrency?: number;
  workerId?: string;
  logger?: Logger;
}

export class JobRunner {
  #db: Db;
  #handlers = new Map<string, JobHandler>();
  #pollIntervalMs: number;
  #lockTimeoutMs: number;
  #concurrency: number;
  #workerId: string;
  #log: Logger;
  #running = false;
  #inflight = new Set<Promise<void>>();
  #wake: (() => void) | null = null;
  #dispatcher: Promise<void> | null = null;
  #lastRescue = 0;

  constructor(db: Db, options: JobRunnerOptions = {}) {
    this.#db = db;
    this.#pollIntervalMs = options.pollIntervalMs ?? 500;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? 60_000;
    this.#concurrency = Math.max(1, options.concurrency ?? 5);
    this.#workerId = options.workerId ?? `worker-${uuidv7().slice(0, 8)}`;
    this.#log = (options.logger ?? silentLogger).child({ component: 'jobs', workerId: this.#workerId });
  }

  register(queue: string, handler: JobHandler): void {
    this.#handlers.set(queue, handler);
  }

  get workerId(): string {
    return this.#workerId;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#dispatcher = this.#dispatchLoop();
  }

  /**
   * Keep up to `concurrency` claimed jobs running; claim eagerly while work
   * exists, sleep for pollIntervalMs when the queue is drained or full.
   */
  async #dispatchLoop(): Promise<void> {
    while (this.#running) {
      let idle = true;
      try {
        // rescue crashed workers' jobs at most once per lock window
        if (Date.now() - this.#lastRescue > Math.max(this.#pollIntervalMs, this.#lockTimeoutMs / 4)) {
          this.#lastRescue = Date.now();
          await this.#rescueExpired();
        }
        while (this.#running && this.#inflight.size < this.#concurrency) {
          const job = await this.#claimOne();
          if (!job) break;
          idle = false;
          const run = this.#runClaimed(job).finally(() => {
            this.#inflight.delete(run);
            this.#wake?.();
          });
          this.#inflight.add(run);
        }
      } catch (err) {
        this.#log.error('job dispatch error', { error: String(err) });
      }
      if (!this.#running) break;
      if (idle || this.#inflight.size >= this.#concurrency) {
        await new Promise<void>((resolve) => {
          this.#wake = resolve;
          setTimeout(resolve, this.#pollIntervalMs);
        });
        this.#wake = null;
      }
    }
  }

  /** Stops claiming, then waits for every in-flight handler to finish. */
  async stop(): Promise<void> {
    this.#running = false;
    this.#wake?.();
    await this.#dispatcher?.catch(() => {});
    await Promise.allSettled([...this.#inflight]);
  }

  /** Run pending jobs until the queue is drained (test + CLI helper). */
  async drain(maxJobs = 1000): Promise<number> {
    let count = 0;
    while (count < maxJobs) {
      const job = await this.#claimOne();
      if (!job) break;
      await this.#runClaimed(job);
      count++;
    }
    return count;
  }

  async #rescueExpired(): Promise<void> {
    await this.#db.query(sql`
      update apick_jobs
      set state = 'pending', locked_by = null, locked_at = null
      where state = 'running'
        and locked_at < now() - make_interval(secs => ${this.#lockTimeoutMs / 1000})
    `);
  }

  async #claimOne(): Promise<JobRow | null> {
    const queues = [...this.#handlers.keys()];
    if (queues.length === 0) return null;

    const { rows } = await this.#db.query<JobRow>(sql`
      update apick_jobs
      set state = 'running', locked_by = ${this.#workerId}, locked_at = now(), attempts = attempts + 1
      where id = (
        select id from apick_jobs
        where state = 'pending' and run_at <= now() and queue = any(${queues})
        order by run_at, id
        limit 1
        for update skip locked
      )
      returning id, tenant_id, queue, payload, state, run_at, attempts, max_attempts, backoff_ms, idempotency_key, last_error
    `);
    return rows[0] ?? null;
  }

  async #runClaimed(job: JobRow): Promise<void> {
    const handler = this.#handlers.get(job.queue)!;
    try {
      await withSpan('apick.job.run', { 'apick.queue': job.queue, 'apick.attempt': job.attempts }, () => handler(job));
      metricsBundle.jobRuns.add(1, { 'apick.queue': job.queue, 'apick.outcome': 'done' });
      await this.#db.query(sql`
        update apick_jobs set state = 'done', finished_at = now(), locked_by = null, locked_at = null
        where id = ${job.id}
      `);
      this.#log.debug('job done', { jobId: job.id, queue: job.queue, attempts: job.attempts });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const exhausted = job.attempts >= job.max_attempts;
      metricsBundle.jobRuns.add(1, { 'apick.queue': job.queue, 'apick.outcome': exhausted ? 'dead' : 'retry' });
      if (exhausted) {
        await this.#db.query(sql`
          update apick_jobs set state = 'dead', last_error = ${message}, finished_at = now(), locked_by = null, locked_at = null
          where id = ${job.id}
        `);
        this.#log.warn('job dead-lettered', { jobId: job.id, queue: job.queue, attempts: job.attempts, error: message });
      } else {
        const backoff = job.backoff_ms * 2 ** (job.attempts - 1);
        await this.#db.query(sql`
          update apick_jobs
          set state = 'pending', last_error = ${message}, locked_by = null, locked_at = null,
              run_at = now() + make_interval(secs => ${backoff / 1000})
          where id = ${job.id}
        `);
        this.#log.debug('job retry scheduled', { jobId: job.id, queue: job.queue, attempts: job.attempts, backoffMs: backoff });
      }
    }
  }
}

/** Requeue a dead job (dead-letter replay). */
export async function replayJob(db: Queryable, jobId: string): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(sql`
    update apick_jobs
    set state = 'pending', attempts = 0, last_error = null, run_at = now(), finished_at = null
    where id = ${jobId} and state = 'dead'
    returning id
  `);
  return rows.length > 0;
}
