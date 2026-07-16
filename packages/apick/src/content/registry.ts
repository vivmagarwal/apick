import type { Db } from '../kernel/db.js';
import { errors } from '../kernel/errors.js';
import { appendEvent } from '../kernel/events.js';
import type { Logger } from '../kernel/log.js';
import { silentLogger } from '../kernel/log.js';
import { sql } from '../kernel/sql.js';
import type { Collection } from '../schema/collection.js';
import { FIELD_KEY_RE } from '../schema/compile.js';

/**
 * Code is the source of truth for content models. The registry snapshots each
 * collection's definition into apick_collections for introspection and drift
 * detection, and applies declared field renames as LOSSLESS jsonb key
 * migrations — the anti-Strapi guarantee: a rename is a rename, never a
 * silent drop-and-recreate.
 */
export class Registry {
  #collections = new Map<string, Collection>();

  constructor(collections: Collection[]) {
    for (const col of collections) {
      if (this.#collections.has(col.key)) throw errors.badRequest(`Duplicate collection key "${col.key}"`);
      this.#collections.set(col.key, col);
    }
    // Relation targets must exist at definition time — fail fast, not at runtime.
    for (const col of collections) {
      for (const rel of col.compiled.relations) {
        if (!this.#collections.has(rel.to)) {
          throw errors.badRequest(`Collection "${col.key}" relation "${rel.path}" targets unknown collection "${rel.to}"`);
        }
      }
    }
  }

  get(key: string): Collection {
    const col = this.#collections.get(key);
    if (!col) throw errors.notFound(`Unknown collection "${key}"`);
    return col;
  }

  has(key: string): boolean {
    return this.#collections.has(key);
  }

  list(): Collection[] {
    return [...this.#collections.values()];
  }

  /**
   * Sync definitions to the database:
   * 1. apply declared top-level field renames (lossless jsonb key move on
   *    heads, versions, uniques and edges — inside one transaction)
   * 2. upsert the schema snapshot (drift is recorded as a schema.changed event)
   *
   * Removing a field from code NEVER deletes stored data — stale keys simply
   * stop being validated/readable and reappear if the field is restored.
   */
  async sync(db: Db, options: { logger?: Logger } = {}): Promise<void> {
    const log = options.logger ?? silentLogger;
    for (const col of this.list()) {
      const snapshot = { key: col.key, description: col.description ?? null, fields: col.compiled.fields };

      await db.transaction(async (tx) => {
        const { rows } = await tx.query<{ schema: Record<string, unknown>; version: number }>(sql`
          select schema, version from apick_collections where key = ${col.key} for update
        `);
        const existing = rows[0];

        for (const [newKey, oldKey] of Object.entries(col.renamedFields)) {
          if (!FIELD_KEY_RE.test(newKey) || !FIELD_KEY_RE.test(oldKey)) {
            throw errors.badRequest(`Invalid rename ${oldKey} -> ${newKey} in "${col.key}"`);
          }
          if (!(newKey in col.compiled.fields)) {
            throw errors.badRequest(`renamedFields maps "${newKey}" but no such field exists in "${col.key}"`);
          }
          // Only migrate when the stored snapshot still has the old key (idempotent).
          const storedFields = (existing?.schema?.['fields'] ?? {}) as Record<string, unknown>;
          if (existing && !(oldKey in storedFields)) continue;

          log.info('applying field rename', { collection: col.key, from: oldKey, to: newKey });
          // sql.raw is safe here: both keys are validated against FIELD_KEY_RE above.
          const move = (column: string): string =>
            `${column} = (${column} - '${oldKey}') || jsonb_build_object('${newKey}', ${column}->'${oldKey}')`;
          await tx.query(sql.raw(`
            update apick_docs set ${move('draft_data')}
            where collection = '${col.key}' and draft_data ? '${oldKey}'
          `));
          await tx.query(sql.raw(`
            update apick_docs set ${move('published_data')}
            where collection = '${col.key}' and published_data is not null and published_data ? '${oldKey}'
          `));
          await tx.query(sql.raw(`
            update apick_doc_versions set ${move('data')}
            where collection = '${col.key}' and data ? '${oldKey}'
          `));
          await tx.query(sql`
            update apick_uniques set field = ${newKey} where collection = ${col.key} and field = ${oldKey}
          `);
          await tx.query(sql`
            update apick_edges set field = ${newKey} where collection = ${col.key} and field = ${oldKey}
          `);
          await appendEvent(tx, {
            tenantId: null,
            type: 'schema.fieldRenamed',
            actor: { principalId: null, via: 'system' },
            subject: { collection: col.key },
            payload: { from: oldKey, to: newKey },
          });
        }

        const serialized = JSON.stringify(snapshot);
        if (!existing) {
          await tx.query(sql`
            insert into apick_collections (key, version, schema) values (${col.key}, ${1}, ${serialized})
          `);
        } else if (JSON.stringify(existing.schema) !== JSON.stringify(snapshot)) {
          await tx.query(sql`
            update apick_collections set version = version + 1, schema = ${serialized}, updated_at = now()
            where key = ${col.key}
          `);
          await appendEvent(tx, {
            tenantId: null,
            type: 'schema.changed',
            actor: { principalId: null, via: 'system' },
            subject: { collection: col.key },
            payload: { version: existing.version + 1 },
          });
        }
      });
    }
  }

  /** Opt-in expression indexes for `indexed` fields. DDL happens HERE only (migrate step), never at serve time. */
  async ensureIndexes(db: Db): Promise<string[]> {
    const created: string[] = [];
    for (const col of this.list()) {
      for (const path of col.compiled.indexedPaths) {
        // Validated keys only (see compile) — safe to inline.
        const segments = path.split('.');
        const jsonPath = `'{${segments.join(',')}}'`;
        const name = `apick_idx_${col.key}_${segments.join('_')}`.replaceAll('-', '_').slice(0, 60);
        for (const column of ['draft_data', 'published_data']) {
          await db.exec(
            `create index if not exists ${name}_${column === 'draft_data' ? 'd' : 'p'} on apick_docs (tenant_id, collection, (${column} #>> ${jsonPath}))`,
          );
        }
        created.push(name);
      }
    }
    return created;
  }
}
