import type { CronDefinition } from '../kernel/cron.js';
import type { Db } from '../kernel/db.js';
import type { Logger } from '../kernel/log.js';
import { sql } from '../kernel/sql.js';

/**
 * Retention: "log everything" must have teeth. Without pruning, the event
 * log, finished jobs and version history grow without bound. A built-in
 * daily job (cluster-single-fire like any cron) applies the configured
 * windows. Version history is NEVER pruned unless explicitly opted in —
 * "history built in and free" stays true by default.
 */
export interface RetentionConfig {
  /** Prune events older than N days (default 90). `false` disables. */
  events?: { days: number } | false;
  /** Prune finished jobs: done after N days (default 7), dead-lettered after N days (default 30). `false` disables. */
  jobs?: { doneDays?: number; deadDays?: number } | false;
  /** Keep only the last N versions per document (heads always survive). Default: keep everything. */
  versions?: { keepLast: number } | false;
  /** When the pruning job runs (default daily at 03:47 UTC). */
  schedule?: string;
}

export const RETENTION_QUEUE = 'apick.retention';
export const RETENTION_CRON_KEY = 'apick-retention';

export interface ResolvedRetention {
  events: { days: number } | false;
  jobs: { doneDays: number; deadDays: number } | false;
  versions: { keepLast: number } | false;
  schedule: string;
}

export function resolveRetention(config: RetentionConfig = {}): ResolvedRetention {
  const events = config.events === false ? false : { days: config.events?.days ?? 90 };
  const jobs =
    config.jobs === false
      ? false
      : { doneDays: config.jobs?.doneDays ?? 7, deadDays: config.jobs?.deadDays ?? 30 };
  const versions = !config.versions ? (false as const) : { keepLast: config.versions.keepLast };
  for (const [label, days] of [
    ['events.days', events === false ? null : events.days],
    ['jobs.doneDays', jobs === false ? null : jobs.doneDays],
    ['jobs.deadDays', jobs === false ? null : jobs.deadDays],
  ] as const) {
    if (days !== null && (!Number.isFinite(days) || days < 0)) {
      throw new Error(`retention.${label} must be a non-negative number of days`);
    }
  }
  if (versions !== false && (!Number.isInteger(versions.keepLast) || versions.keepLast < 1)) {
    throw new Error('retention.versions.keepLast must be a positive integer');
  }
  return { events, jobs, versions, schedule: config.schedule ?? '47 3 * * *' };
}

export function retentionEnabled(r: ResolvedRetention): boolean {
  return r.events !== false || r.jobs !== false || r.versions !== false;
}

export function retentionCronDef(r: ResolvedRetention): CronDefinition {
  return { key: RETENTION_CRON_KEY, schedule: r.schedule, queue: RETENTION_QUEUE, tenantId: null };
}

async function countDelete(db: Db, frag: ReturnType<typeof sql>): Promise<number> {
  const { rows } = await db.query<{ n: string }>(frag);
  return Number(rows[0]?.n ?? 0);
}

export function createRetentionHandler(db: Db, r: ResolvedRetention, log: Logger) {
  return async (): Promise<void> => {
    const pruned: Record<string, number> = {};
    if (r.events !== false) {
      // Events still awaiting a webhook delivery are kept regardless of age.
      pruned['events'] = await countDelete(db, sql`
        with del as (
          delete from apick_events
          where created_at < now() - make_interval(secs => ${r.events.days * 86_400})
            and id not in (select event_id from apick_deliveries where state = 'pending')
          returning 1
        ) select count(*)::text as n from del
      `);
    }
    if (r.jobs !== false) {
      pruned['jobsDone'] = await countDelete(db, sql`
        with del as (
          delete from apick_jobs
          where state = 'done' and finished_at < now() - make_interval(secs => ${r.jobs.doneDays * 86_400})
          returning 1
        ) select count(*)::text as n from del
      `);
      pruned['jobsDead'] = await countDelete(db, sql`
        with del as (
          delete from apick_jobs
          where state = 'dead' and finished_at < now() - make_interval(secs => ${r.jobs.deadDays * 86_400})
          returning 1
        ) select count(*)::text as n from del
      `);
    }
    if (r.versions !== false) {
      // Keep the newest keepLast versions per (tenant, collection, doc, locale);
      // the draft and published head rows always survive (they are FK targets).
      pruned['versions'] = await countDelete(db, sql`
        with del as (
          delete from apick_doc_versions v
          using apick_docs d
          where d.tenant_id = v.tenant_id and d.collection = v.collection
            and d.doc_id = v.doc_id and d.locale = v.locale
            and v.version <= d.draft_version - ${r.versions.keepLast}
            and v.id <> d.draft_version_id
            and (d.published_version_id is null or v.id <> d.published_version_id)
          returning 1
        ) select count(*)::text as n from del
      `);
    }
    log.info('retention pruning done', pruned);
  };
}
