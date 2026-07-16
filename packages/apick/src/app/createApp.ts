import type { Server } from 'node:http';
import type { Hono } from 'hono';
import { openDb, type Db } from '../kernel/db.js';
import { errors } from '../kernel/errors.js';
import { CronScheduler, type CronDefinition } from '../kernel/cron.js';
import { enqueueJob, JobRunner, type EnqueueJobInput, type JobRow } from '../kernel/jobs.js';
import { createLogger, silentLogger, type Logger, type LogLevel } from '../kernel/log.js';
import { migrate, migrationStatus } from '../kernel/migrate.js';
import type { TenantRow } from '../auth/rbac.js';
import { Registry } from '../content/registry.js';
import type { Collection } from '../schema/collection.js';
import type { SavedQuery } from '../query/saved.js';
import { createDeliveryHandler, DEFAULT_WEBHOOK_RETRY, WEBHOOK_QUEUE } from '../webhooks/index.js';
import { buildHttpApp, type HonoEnv } from '../http/app.js';
import { bootstrap } from './bootstrap.js';
import type { AppCore, ResolvedConfig } from './core.js';
import { serve } from './serve.js';
import { VERSION } from '../version.js';

export type UserJobHandler = (
  payload: Record<string, unknown>,
  context: { tenantId: string | null; jobId: string; attempts: number; db: Db },
) => Promise<void>;

export interface ApickConfig {
  /**
   * `postgres://…` for production, `pglite://./dir` or `pglite://memory` for
   * embedded dev/test Postgres. Defaults to APICK_DATABASE_URL / DATABASE_URL,
   * falling back to `pglite://./.apick-data` (zero-setup hello world).
   */
  database?: string;
  collections?: Collection[];
  queries?: SavedQuery[];
  crons?: CronDefinition[];
  /** Durable job handlers by queue name (reserved prefix "apick." is internal). */
  jobs?: Record<string, UserJobHandler>;
  /**
   * 'apply' runs APIck's own schema migrations + opt-in field indexes.
   * 'check' refuses to start if migrations are pending (run `apick migrate`).
   * Default: 'apply' on PGlite (embedded dev), 'check' on Postgres — the
   * server never mutates production DDL at boot unless you opt in.
   */
  migrate?: 'apply' | 'check';
  defaultLocale?: string;
  /** Slug of the auto-provisioned tenant. Default "default". */
  defaultTenant?: string;
  /** Fixed root API key for reproducible dev/test setups; otherwise generated once and returned. */
  rootKey?: string;
  logger?: Logger;
  logLevel?: LogLevel;
  /** Run the job worker + cron scheduler in this process (default true). */
  worker?: boolean;
  /** Worker/cron poll tuning (mostly for tests). */
  pollIntervalMs?: number;
  tickIntervalMs?: number;
  /** Map a request to a tenant slug/id (e.g. from the Host header). */
  resolveTenant?: (request: Request) => string | null | Promise<string | null>;
  interactionLog?: 'off' | 'mutations' | 'all';
  /** Webhook delivery retry policy (default: 6 attempts, 1s exponential backoff). */
  webhookRetry?: { maxAttempts?: number; backoffMs?: number };
  /** Add your own routes on the same Hono app (custom endpoints). */
  extend?: (app: Hono<HonoEnv>, core: AppCore) => void;
}

export interface ApickApp {
  /** Fetch handler — mount it in any fetch-capable server (or use listen()). */
  fetch: (request: Request) => Response | Promise<Response>;
  hono: Hono<HonoEnv>;
  db: Db;
  registry: Registry;
  jobs: JobRunner;
  crons: CronScheduler;
  log: Logger;
  version: string;
  /** Set ONLY when a brand-new root key was created this boot — show it once. */
  rootKey: string | null;
  defaultTenant: TenantRow;
  /** Enqueue a durable job (server-side). */
  enqueue: (input: EnqueueJobInput) => Promise<{ id: string; deduped: boolean }>;
  listen: (port?: number, hostname?: string) => Promise<{ url: string; port: number }>;
  stop: () => Promise<void>;
}

export async function createApp(config: ApickConfig = {}): Promise<ApickApp> {
  const log =
    config.logger ?? (config.logLevel ? createLogger({ level: config.logLevel }) : createLogger({ level: 'info' }));

  const db = await openDb(config.database !== undefined ? { url: config.database } : {});

  // Migration policy: embedded dev DB applies automatically; production
  // Postgres refuses to serve with pending migrations unless opted in.
  const migrateMode = config.migrate ?? (db.kind === 'pglite' ? 'apply' : 'check');
  if (migrateMode === 'apply') {
    const { applied } = await migrate(db);
    if (applied.length > 0) log.info('applied apick migrations', { applied });
  } else {
    const status = await migrationStatus(db);
    if (status.pending.length > 0) {
      await db.close();
      throw errors.internal(
        `Database is behind by ${status.pending.length} apick migration(s): ${status.pending.join(', ')}. ` +
          `Run "apick migrate" against this database, or pass migrate: 'apply'.`,
      );
    }
  }

  const registry = new Registry(config.collections ?? []);
  await registry.sync(db, { logger: log });
  if (migrateMode === 'apply') {
    await registry.ensureIndexes(db);
  }

  const boot = await bootstrap(db, registry, {
    ...(config.defaultTenant !== undefined ? { defaultTenant: config.defaultTenant } : {}),
    ...(config.rootKey !== undefined ? { rootKey: config.rootKey } : {}),
    logger: log,
  });

  const queries = new Map<string, SavedQuery>();
  for (const q of config.queries ?? []) {
    if (queries.has(q.key)) throw errors.badRequest(`Duplicate saved query "${q.key}"`);
    registry.get(q.collection); // fail fast on unknown collection
    queries.set(q.key, q);
  }

  const resolvedConfig: ResolvedConfig = {
    defaultLocale: config.defaultLocale ?? 'default',
    defaultTenantSlug: boot.defaultTenant.slug,
    interactionLog: config.interactionLog ?? 'mutations',
    resolveTenant: config.resolveTenant ?? null,
    webhookRetry: {
      maxAttempts: config.webhookRetry?.maxAttempts ?? DEFAULT_WEBHOOK_RETRY.maxAttempts,
      backoffMs: config.webhookRetry?.backoffMs ?? DEFAULT_WEBHOOK_RETRY.backoffMs,
    },
  };

  const core: AppCore = {
    db,
    registry,
    queries,
    config: resolvedConfig,
    log,
    defaultTenant: boot.defaultTenant,
    version: VERSION,
  };

  // Durable jobs: internal webhook deliveries + user handlers.
  const jobs = new JobRunner(db, {
    ...(config.pollIntervalMs !== undefined ? { pollIntervalMs: config.pollIntervalMs } : {}),
    logger: log,
  });
  jobs.register(WEBHOOK_QUEUE, createDeliveryHandler(db));
  for (const [queue, handler] of Object.entries(config.jobs ?? {})) {
    if (queue.startsWith('apick.')) throw errors.badRequest(`Queue name "${queue}" is reserved (apick.*)`);
    jobs.register(queue, async (job: JobRow) => {
      await handler(job.payload, { tenantId: job.tenant_id, jobId: job.id, attempts: job.attempts, db });
    });
  }

  for (const cron of config.crons ?? []) {
    if (cron.queue.startsWith('apick.')) throw errors.badRequest(`Cron "${cron.key}" targets a reserved queue`);
    if (!(config.jobs ?? {})[cron.queue]) {
      throw errors.badRequest(`Cron "${cron.key}" targets queue "${cron.queue}" but no job handler is registered for it`);
    }
  }
  const crons = new CronScheduler(db, config.crons ?? [], {
    ...(config.tickIntervalMs !== undefined ? { tickIntervalMs: config.tickIntervalMs } : {}),
    logger: log,
  });
  await crons.sync();

  const worker = config.worker ?? true;
  if (worker) {
    jobs.start();
    crons.start();
  }

  const hono = buildHttpApp(core);
  config.extend?.(hono, core);

  let server: Server | null = null;
  const app: ApickApp = {
    fetch: (request) => hono.fetch(request),
    hono,
    db,
    registry,
    jobs,
    crons,
    log,
    version: VERSION,
    rootKey: boot.rootKey,
    defaultTenant: boot.defaultTenant,
    enqueue: (input) => enqueueJob(db, input),
    listen: async (port, hostname) => {
      const started = await serve((req) => hono.fetch(req), {
        ...(port !== undefined ? { port } : {}),
        ...(hostname !== undefined ? { hostname } : {}),
      });
      server = started.server;
      log.info('apick listening', { url: started.url });
      return { url: started.url, port: started.port };
    },
    stop: async () => {
      await crons.stop();
      await jobs.stop();
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await db.close();
    },
  };
  return app;
}

export { silentLogger };
