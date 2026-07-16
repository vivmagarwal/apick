import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { ApickError } from './errors.js';
import type { SqlFragment } from './sql.js';

export interface QueryResult<T> {
  rows: T[];
}

/** A connection-ish thing you can query: the pool/db itself or a tx handle. */
export interface Queryable {
  query<T = Record<string, unknown>>(frag: SqlFragment): Promise<QueryResult<T>>;
}

export interface Db extends Queryable {
  readonly kind: 'pg' | 'pglite';
  /** The Postgres schema all apick tables live in (null = the default search_path, i.e. public). */
  readonly schema: string | null;
  /** Multi-statement execution for DDL (migrations only). */
  exec(text: string): Promise<void>;
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function rethrow(err: unknown): never {
  // Surface Postgres unique-violation as a typed conflict so callers can map it.
  const code = (err as { code?: string }).code;
  if (code === '23505') {
    throw new ApickError('conflict', 'Unique constraint violated', {
      constraint: (err as { constraint?: string }).constraint ?? null,
    });
  }
  throw err;
}

class PgDb implements Db {
  readonly kind = 'pg' as const;
  readonly schema: string | null;
  #pool: import('pg').Pool;

  constructor(pool: import('pg').Pool, schema: string | null = null) {
    this.#pool = pool;
    this.schema = schema;
  }

  async query<T = Record<string, unknown>>(frag: SqlFragment): Promise<QueryResult<T>> {
    const { text, values } = frag.compile();
    try {
      const res = await this.#pool.query(text, values);
      return { rows: res.rows as T[] };
    } catch (err) {
      rethrow(err);
    }
  }

  async exec(text: string): Promise<void> {
    await this.#pool.query(text);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query('begin');
      const tx: Queryable = {
        async query<R = Record<string, unknown>>(frag: SqlFragment): Promise<QueryResult<R>> {
          const { text, values } = frag.compile();
          try {
            const res = await client.query(text, values);
            return { rows: res.rows as R[] };
          } catch (err) {
            rethrow(err);
          }
        },
      };
      const out = await fn(tx);
      await client.query('commit');
      return out;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

type PgliteInstance = import('@electric-sql/pglite').PGlite;

class PgliteDb implements Db {
  readonly kind = 'pglite' as const;
  readonly schema: string | null;
  #db: PgliteInstance;
  #onClose: (() => void) | undefined;

  constructor(db: PgliteInstance, onClose?: () => void, schema: string | null = null) {
    this.#db = db;
    this.#onClose = onClose;
    this.schema = schema;
  }

  async query<T = Record<string, unknown>>(frag: SqlFragment): Promise<QueryResult<T>> {
    const { text, values } = frag.compile();
    try {
      const res = await this.#db.query(text, values as unknown[]);
      return { rows: res.rows as T[] };
    } catch (err) {
      rethrow(err);
    }
  }

  async exec(text: string): Promise<void> {
    await this.#db.exec(text);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.#db.transaction(async (ptx) => {
      const tx: Queryable = {
        async query<R = Record<string, unknown>>(frag: SqlFragment): Promise<QueryResult<R>> {
          const { text, values } = frag.compile();
          try {
            const res = await ptx.query(text, values as unknown[]);
            return { rows: res.rows as R[] };
          } catch (err) {
            rethrow(err);
          }
        },
      };
      return fn(tx);
    });
  }

  async close(): Promise<void> {
    await this.#db.close();
    this.#onClose?.();
  }
}

/**
 * PGlite supports exactly ONE instance per data directory. Guard with a pid
 * lockfile so a second process (or a second createApp in the same process)
 * fails with a clear error instead of corrupting the database.
 */
function acquirePgliteLock(dir: string): () => void {
  // The lockfile lives BESIDE the data directory: PGlite requires its data
  // dir to be empty on first init, so we must not write into it.
  const normalized = dir.replace(/\/+$/, '');
  const parent = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '.';
  mkdirSync(parent, { recursive: true });
  const lockPath = `${normalized}.apick-lock`;
  if (existsSync(lockPath)) {
    const holder = Number.parseInt(readFileSync(lockPath, 'utf8'), 10);
    let alive = false;
    if (Number.isInteger(holder)) {
      try {
        process.kill(holder, 0);
        alive = true;
      } catch {
        alive = false; // stale lock from a dead process — take over
      }
    }
    if (alive) {
      throw new ApickError(
        'conflict',
        `PGlite database at "${dir}" is already open (pid ${holder}). ` +
          `PGlite supports a single instance per directory — use postgres:// for multi-process setups.`,
      );
    }
  }
  writeFileSync(lockPath, String(process.pid));
  return () => {
    try {
      rmSync(lockPath, { force: true });
    } catch {
      /* best effort */
    }
  };
}

export interface DatabaseConfig {
  /**
   * - `postgres://…` / `postgresql://…`  → node-postgres pool (production)
   * - `pglite://memory`                  → embedded in-memory Postgres (tests)
   * - `pglite://./some/dir`              → embedded file-backed Postgres (dev)
   * Defaults to `pglite://./.apick-data` so hello-world needs no database setup.
   */
  url?: string;
  poolSize?: number;
  /**
   * Postgres schema for ALL apick tables (created if missing). This is how
   * several APIck apps share ONE database — each app in its own schema, fully
   * isolated, no table-name collisions. Also settable as `?schema=…` on a
   * postgres URL or via APICK_DATABASE_SCHEMA. On Supabase this doubles as a
   * safety boundary: a non-exposed schema is never served by PostgREST.
   * NOTE: requires a direct connection or a SESSION-mode pooler —
   * transaction-mode poolers share server sessions and cannot hold a
   * per-connection search_path (openDb verifies and fails fast).
   */
  schema?: string;
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,62}$/;

function resolveSchema(config: DatabaseConfig, urlParam: string | null): string | null {
  const schema = config.schema ?? urlParam ?? process.env['APICK_DATABASE_SCHEMA'] ?? null;
  if (schema === null || schema === '') return null;
  if (!SCHEMA_RE.test(schema)) {
    throw new ApickError('bad_request', `Invalid database schema "${schema}" (want: ${SCHEMA_RE})`);
  }
  return schema;
}

export async function openDb(config: DatabaseConfig = {}): Promise<Db> {
  const rawUrl = config.url ?? process.env['APICK_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? 'pglite://./.apick-data';

  if (rawUrl.startsWith('postgres://') || rawUrl.startsWith('postgresql://')) {
    // `?schema=` is apick's, not libpq's — extract and strip before connecting.
    const parsed = new URL(rawUrl);
    const urlParam = parsed.searchParams.get('schema');
    if (urlParam !== null) parsed.searchParams.delete('schema');
    const schema = resolveSchema(config, urlParam);
    const url = parsed.toString();

    const { default: pg } = await import('pg');
    const pool = new pg.Pool({
      connectionString: url,
      max: config.poolSize ?? 10,
      // Preferred path: the server applies the search_path at connection
      // startup — race-free and works through session-mode poolers that
      // forward startup parameters (Supavisor does).
      ...(schema ? { options: `-c search_path=${schema}` } : {}),
    });
    const hasSchema = (searchPath: string): boolean =>
      searchPath.split(',').some((s) => s.trim().replace(/^"|"$/g, '') === schema);
    // Fail fast with a readable error instead of on first query.
    const client = await pool.connect();
    try {
      if (schema) {
        const before = await client.query('show search_path');
        if (!hasSchema(String(before.rows[0]?.['search_path'] ?? ''))) {
          // The pooler stripped startup options — SET on every new connection
          // instead (queries issued inside 'connect' run before any checkout's
          // queries on that client), then verify a SET actually holds here.
          pool.on('connect', (c) => {
            c.query(`set search_path to "${schema}"`).catch(() => {
              /* a failure surfaces on that connection's next query */
            });
          });
          await client.query(`set search_path to "${schema}"`);
          const after = await client.query('show search_path');
          if (!hasSchema(String(after.rows[0]?.['search_path'] ?? ''))) {
            throw new ApickError(
              'bad_request',
              `Could not apply search_path "${schema}". Transaction-mode poolers cannot hold a session ` +
                `search_path — use a direct connection or a session-mode pooler (e.g. Supavisor on :5432).`,
            );
          }
        }
        await client.query(`create schema if not exists "${schema}"`);
      }
    } finally {
      client.release();
    }
    return new PgDb(pool, schema);
  }

  if (rawUrl.startsWith('pglite://')) {
    const target = rawUrl.slice('pglite://'.length);
    const schema = resolveSchema(config, null);
    const { PGlite } = await import('@electric-sql/pglite');
    const withSchema = async (db: PgliteInstance): Promise<void> => {
      if (!schema) return;
      // PGlite is a single session — one SET holds for the instance's lifetime.
      await db.exec(`create schema if not exists "${schema}"; set search_path to "${schema}";`);
    };
    if (target === 'memory') {
      const db = new PGlite();
      await db.waitReady;
      await withSchema(db);
      return new PgliteDb(db, undefined, schema);
    }
    const releaseLock = acquirePgliteLock(target);
    try {
      const db = new PGlite(target);
      await db.waitReady;
      await withSchema(db);
      return new PgliteDb(db, releaseLock, schema);
    } catch (err) {
      releaseLock();
      throw err;
    }
  }

  throw new ApickError('bad_request', `Unsupported database url scheme: ${rawUrl.split('://')[0]}://`);
}
