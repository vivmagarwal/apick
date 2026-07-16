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
  #pool: import('pg').Pool;

  constructor(pool: import('pg').Pool) {
    this.#pool = pool;
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
  #db: PgliteInstance;

  constructor(db: PgliteInstance) {
    this.#db = db;
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
  }
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
}

export async function openDb(config: DatabaseConfig = {}): Promise<Db> {
  const url = config.url ?? process.env['APICK_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? 'pglite://./.apick-data';

  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: url, max: config.poolSize ?? 10 });
    // Fail fast with a readable error instead of on first query.
    const client = await pool.connect();
    client.release();
    return new PgDb(pool);
  }

  if (url.startsWith('pglite://')) {
    const target = url.slice('pglite://'.length);
    const { PGlite } = await import('@electric-sql/pglite');
    const db = target === 'memory' ? new PGlite() : new PGlite(target);
    await db.waitReady;
    return new PgliteDb(db);
  }

  throw new ApickError('bad_request', `Unsupported database url scheme: ${url.split('://')[0]}://`);
}
