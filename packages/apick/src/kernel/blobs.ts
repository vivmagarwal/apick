import { createHash } from 'node:crypto';
import type { Queryable } from './db.js';
import { uuidv7 } from './ids.js';
import { sql } from './sql.js';

/**
 * Minimal blob store (server-side API only — core exposes no HTTP surface
 * for binaries). @apick/cms builds its media library on this; the default
 * "database" storage is zero-config and replica-safe. Large media libraries
 * should use object storage via the CMS's pluggable storage driver instead.
 */
export interface BlobMeta {
  id: string;
  sha256: string;
  mime: string;
  size: number;
}

export async function putBlob(db: Queryable, tenantId: string, data: Buffer, mime: string): Promise<BlobMeta> {
  const id = uuidv7();
  const sha256 = createHash('sha256').update(data).digest('hex');
  await db.query(sql`
    insert into apick_blobs (id, tenant_id, sha256, mime, size, data)
    values (${id}, ${tenantId}, ${sha256}, ${mime}, ${data.length}, ${data})
  `);
  return { id, sha256, mime, size: data.length };
}

export async function getBlob(db: Queryable, tenantId: string, id: string): Promise<(BlobMeta & { data: Buffer }) | null> {
  const { rows } = await db.query<{ id: string; sha256: string; mime: string; size: number; data: Buffer | Uint8Array }>(sql`
    select id, sha256, mime, size, data from apick_blobs where id = ${id} and tenant_id = ${tenantId}
  `);
  const row = rows[0];
  if (!row) return null;
  return { ...row, data: Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data) };
}

export async function deleteBlob(db: Queryable, tenantId: string, id: string): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(sql`
    delete from apick_blobs where id = ${id} and tenant_id = ${tenantId} returning id
  `);
  return rows.length > 0;
}
