import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { sql, type Db } from '@apick/core';

/**
 * CMS sessions: the CMS is its own identity provider on top of core's
 * bring-your-own-IdP hook. A session token is a compact signed payload
 * (`cms1.<payload>.<sig>`, HMAC-SHA256) carrying the user's doc id, expiry
 * and a password-version fingerprint — changing the password invalidates
 * every outstanding session for that user.
 */

export interface SessionPayload {
  sub: string; // cms user docId
  exp: number; // unix ms
  pv: string; // password-version fingerprint
}

export function passwordVersion(passwordHash: string): string {
  return createHash('sha256').update(passwordHash).digest('hex').slice(0, 12);
}

export function signSession(secret: string, payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `cms1.${body}.${sig}`;
}

export function verifySession(secret: string, token: string): SessionPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'cms1') return null;
  const [, body, sig] = parts;
  const expected = createHmac('sha256', secret).update(body!).digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(sig!);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body!, 'base64url').toString()) as SessionPayload;
    if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number' || typeof payload.pv !== 'string') return null;
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * The signing secret: config/env wins; otherwise one is generated once and
 * persisted in the default tenant's settings so every replica agrees.
 */
export async function resolveCmsSecret(db: Db, tenantId: string, configured?: string): Promise<string> {
  if (configured) return configured;
  const envSecret = process.env['APICK_CMS_SECRET'];
  if (envSecret) return envSecret;

  const read = async (): Promise<string | null> => {
    const { rows } = await db.query<{ secret: string | null }>(sql`
      select settings->>'cmsSecret' as secret from apick_tenants where id = ${tenantId}
    `);
    return rows[0]?.secret ?? null;
  };
  const existing = await read();
  if (existing) return existing;

  const generated = randomBytes(32).toString('base64url');
  // Only claim the slot if still empty (another replica may have raced us).
  await db.query(sql`
    update apick_tenants
    set settings = settings || ${JSON.stringify({ cmsSecret: generated })}
    where id = ${tenantId} and not (settings ? 'cmsSecret')
  `);
  return (await read()) ?? generated;
}

/** Tiny fixed-window limiter for login attempts (per key, e.g. email+ip). */
export function createRateLimiter(maxAttempts: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt < now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      if (hits.size > 10_000) {
        for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k);
      }
      return true;
    }
    entry.count++;
    return entry.count <= maxAttempts;
  };
}
