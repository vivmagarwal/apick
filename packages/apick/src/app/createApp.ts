import type { Server } from 'node:http';
import type { Hono } from 'hono';
import { createAuthCaches } from '../kernel/cache.js';
import { openDb, type Db } from '../kernel/db.js';
import { errors } from '../kernel/errors.js';
import { CronScheduler, type CronDefinition } from '../kernel/cron.js';
import { enqueueJob, JobRunner, type EnqueueJobInput, type JobRow } from '../kernel/jobs.js';
import { createLogger, silentLogger, type Logger, type LogLevel } from '../kernel/log.js';
import { migrate, migrationStatus } from '../kernel/migrate.js';
import { sql } from '../kernel/sql.js';
import { sweepScheduledPublishes } from '../content/store.js';
import { fanoutEvent } from '../webhooks/index.js';
import type { RoleDefinition, TenantRow, VerifyTokenHook } from '../auth/rbac.js';
import {
  createRetentionHandler,
  resolveRetention,
  retentionCronDef,
  retentionEnabled,
  RETENTION_QUEUE,
  type RetentionConfig,
} from './retention.js';
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
  /**
   * Postgres schema for all apick tables (created if missing) — how several
   * APIck apps share one database, each isolated in its own schema. Also
   * settable as `?schema=…` on the database URL or APICK_DATABASE_SCHEMA.
   * Needs a direct connection or session-mode pooler (verified at boot).
   */
  databaseSchema?: string;
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
  /** Code-defined roles, synced at bootstrap (key must not clash with built-ins). */
  roles?: RoleDefinition[];
  /** Serve the JSON index at "/" (default true; set false to claim "/" for your own routes). */
  rootIndex?: boolean;
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
  /**
   * Webhook behavior. `retry` defaults to 6 attempts / 1s exponential backoff.
   * `allowPrivateTargets` is the SSRF policy: it defaults to true on embedded
   * PGlite (local dev) and FALSE on Postgres — production webhook targets must
   * resolve to public addresses unless you explicitly opt out.
   */
  webhooks?: {
    retry?: { maxAttempts?: number; backoffMs?: number };
    allowPrivateTargets?: boolean;
    timeoutMs?: number;
  };
  /**
   * Bring-your-own-IdP: verify a non-APIck bearer token (a JWT from your
   * identity provider) and map it to an external identity. Returning null
   * rejects the token. API keys are always checked first.
   */
  auth?: {
    verifyToken?: VerifyTokenHook;
  };
  /**
   * CORS. Default: enabled for all origins (auth is bearer-token based, not
   * cookie based, so this is safe). Restrict with { origins: [...] } or
   * disable with false.
   */
  cors?: boolean | { origins?: '*' | string[]; maxAge?: number };
  /** Retention windows for events/jobs/versions; see docs/guides/deployment.md. */
  retention?: RetentionConfig;
  /** Parallel job handlers per worker process (default 5). */
  jobConcurrency?: number;
  /**
   * TTL for the auth caches (tenant, key grants, public rules). Mutations on
   * this instance invalidate immediately; other replicas converge within the
   * TTL (e.g. key revocation). 0 disables caching. Default 5000ms.
   */
  authCacheTtlMs?: number;
  /** Request body size limit in bytes (default 5MB). */
  maxBodyBytes?: number;
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
  /** Graceful shutdown: drain HTTP (up to gracefulMs, default 10s), finish in-flight jobs, close the db. */
  stop: (options?: { gracefulMs?: number }) => Promise<void>;
}

export async function createApp(config: ApickConfig = {}): Promise<ApickApp> {
  const log =
    config.logger ?? (config.logLevel ? createLogger({ level: config.logLevel }) : createLogger({ level: 'info' }));

  const db = await openDb({
    ...(config.database !== undefined ? { url: config.database } : {}),
    ...(config.databaseSchema !== undefined ? { schema: config.databaseSchema } : {}),
  });

  // Shared-database guidance: connecting to a Postgres that already holds
  // other tables without a schema of our own works, but isolation is better —
  // suggest it (people can ignore or override; nothing existing is touched).
  if (db.kind === 'pg' && db.schema === null) {
    const { rows } = await db.query<{ n: string }>(
      sql`select count(*)::text as n from information_schema.tables
          where table_schema = current_schema() and table_name not like 'apick_%'`,
    );
    if (Number(rows[0]?.n ?? 0) > 0) {
      log.warn(
        'this database already contains non-apick tables — consider giving this app its own schema ' +
          "(databaseSchema: 'apick_myapp', or ?schema= on the URL) so several apps can share the database untangled",
        { foreignTables: Number(rows[0]!.n) },
      );
    }
  }

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
    ...(config.roles !== undefined ? { roles: config.roles } : {}),
    logger: log,
  });

  const queries = new Map<string, SavedQuery>();
  for (const q of config.queries ?? []) {
    if (queries.has(q.key)) throw errors.badRequest(`Duplicate saved query "${q.key}"`);
    registry.get(q.collection); // fail fast on unknown collection
    queries.set(q.key, q);
  }

  // SSRF policy: local dev (embedded db) may target private addresses;
  // production Postgres deployments must opt in explicitly.
  const allowPrivateTargets = config.webhooks?.allowPrivateTargets ?? db.kind === 'pglite';

  const corsConfig =
    config.cors === false
      ? (false as const)
      : {
          origins: (typeof config.cors === 'object' ? config.cors.origins : undefined) ?? ('*' as const),
          maxAge: (typeof config.cors === 'object' ? config.cors.maxAge : undefined) ?? 600,
        };

  const resolvedConfig: ResolvedConfig = {
    defaultLocale: config.defaultLocale ?? 'default',
    defaultTenantSlug: boot.defaultTenant.slug,
    interactionLog: config.interactionLog ?? 'mutations',
    resolveTenant: config.resolveTenant ?? null,
    webhooks: {
      retry: {
        maxAttempts: config.webhooks?.retry?.maxAttempts ?? DEFAULT_WEBHOOK_RETRY.maxAttempts,
        backoffMs: config.webhooks?.retry?.backoffMs ?? DEFAULT_WEBHOOK_RETRY.backoffMs,
      },
      allowPrivateTargets,
      timeoutMs: config.webhooks?.timeoutMs ?? 10_000,
    },
    cors: corsConfig,
    maxBodyBytes: config.maxBodyBytes ?? 5 * 1024 * 1024,
    verifyToken: config.auth?.verifyToken ?? null,
    rootIndex: config.rootIndex ?? true,
  };

  const caches = createAuthCaches(config.authCacheTtlMs ?? 5000);

  const core: AppCore = {
    db,
    registry,
    queries,
    config: resolvedConfig,
    log,
    defaultTenant: boot.defaultTenant,
    caches,
    version: VERSION,
  };

  // Durable jobs: internal webhook deliveries + retention + user handlers.
  const jobs = new JobRunner(db, {
    ...(config.pollIntervalMs !== undefined ? { pollIntervalMs: config.pollIntervalMs } : {}),
    ...(config.jobConcurrency !== undefined ? { concurrency: config.jobConcurrency } : {}),
    logger: log,
  });
  jobs.register(
    WEBHOOK_QUEUE,
    createDeliveryHandler(db, { allowPrivateTargets, timeoutMs: resolvedConfig.webhooks.timeoutMs }),
  );

  const retention = resolveRetention(config.retention);
  if (retentionEnabled(retention)) {
    jobs.register(RETENTION_QUEUE, createRetentionHandler(db, retention, log));
  }

  for (const [queue, handler] of Object.entries(config.jobs ?? {})) {
    if (queue.startsWith('apick.')) throw errors.badRequest(`Queue name "${queue}" is reserved (apick.*)`);
    jobs.register(queue, async (job: JobRow) => {
      await handler(job.payload, { tenantId: job.tenant_id, jobId: job.id, attempts: job.attempts, db });
    });
  }

  for (const cron of config.crons ?? []) {
    if (cron.key.startsWith('apick-')) throw errors.badRequest(`Cron key "${cron.key}" is reserved (apick-*)`);
    if (cron.queue.startsWith('apick.')) throw errors.badRequest(`Cron "${cron.key}" targets a reserved queue`);
    if (!(config.jobs ?? {})[cron.queue]) {
      throw errors.badRequest(`Cron "${cron.key}" targets queue "${cron.queue}" but no job handler is registered for it`);
    }
  }
  const cronDefs = [...(config.crons ?? [])];
  if (retentionEnabled(retention)) cronDefs.push(retentionCronDef(retention));
  // Scheduled publishing: sweep due schedules once a minute, cluster-single-fire.
  const SCHEDULED_PUBLISH_QUEUE = 'apick.scheduled-publish';
  jobs.register(SCHEDULED_PUBLISH_QUEUE, async () => {
    const n = await sweepScheduledPublishes(
      db,
      (key) => (registry.has(key) ? registry.get(key).compiled : null),
      (tenantId) => ({
        tenantId,
        actor: { principalId: null, via: 'system' },
        onEvent: (tx, event) => fanoutEvent(tx, event, core.config.webhooks.retry),
      }),
    );
    if (n > 0) log.info('published scheduled documents', { published: n });
  });
  cronDefs.push({ key: 'apick-scheduled-publish', schedule: '* * * * *', queue: SCHEDULED_PUBLISH_QUEUE, tenantId: null });
  const crons = new CronScheduler(db, cronDefs, {
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
      // PaaS ergonomics: with no explicit args, honor the platform's PORT env —
      // and since an injected PORT is the "running on a PaaS" signal, bind
      // 0.0.0.0 there (HOST overrides either way). Explicit args always win.
      const envPort = port === undefined && process.env['PORT'] ? Number.parseInt(process.env['PORT'], 10) : undefined;
      const envHost = hostname ?? process.env['HOST'] ?? (envPort !== undefined ? '0.0.0.0' : undefined);
      const started = await serve((req) => hono.fetch(req), {
        ...(port !== undefined ? { port } : envPort !== undefined ? { port: envPort } : {}),
        ...(envHost !== undefined ? { hostname: envHost } : {}),
      });
      server = started.server;
      log.info('apick listening', { url: started.url });
      return { url: started.url, port: started.port };
    },
    stop: async (options: { gracefulMs?: number } = {}) => {
      // 1. stop accepting connections, drain in-flight HTTP (bounded)
      if (server) await shutdownServer(server, options.gracefulMs ?? 10_000);
      // 2. stop scheduling, then wait for in-flight jobs to finish
      await crons.stop();
      await jobs.stop();
      // 3. release the database
      await db.close();
    },
  };
  return app;
}

async function shutdownServer(server: Server, gracefulMs: number): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  const timer = setTimeout(() => server.closeAllConnections(), gracefulMs);
  await closed;
  clearTimeout(timer);
}

export { silentLogger };
