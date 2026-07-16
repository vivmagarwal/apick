import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthCaches } from '../kernel/cache.js';
import type { Db, Queryable } from '../kernel/db.js';
import { errors } from '../kernel/errors.js';
import { isUuid, uuidv7 } from '../kernel/ids.js';
import { sql } from '../kernel/sql.js';

/**
 * ONE auth model for everything. A request resolves to an AccessContext:
 * a principal (or anonymous), the scope it acts in (operator, or one tenant),
 * and its effective permission rules. Operator is a scope in the same model —
 * not a second auth system (Strapi's admin vs users-permissions split is the
 * anti-pattern this avoids).
 *
 * Authorization is consumed by the QUERY PLANNER, not by route handlers:
 * rules carry field whitelists and row conditions that the planner compiles
 * into every read and traversal.
 */

export type DocAction = 'read' | 'readDraft' | 'create' | 'update' | 'delete' | 'publish';
export type Action = DocAction | 'manage' | '*';

export interface PermissionRule {
  action: string; // Action, but stored as text
  resource: string; // 'doc:<collection>' | 'doc:*' | 'system:<name>' | 'system:*' | '*'
  fields: string[] | null; // null = all non-private fields
  condition: Record<string, unknown> | null; // filter AST, ANDed into plans ('$me' substitutes the principal id)
}

export interface AccessContext {
  principalId: string | null; // null = anonymous
  keyId: string | null;
  via: 'api' | 'mcp' | 'system' | 'cli';
  /** True when the principal holds an operator-scope grant. */
  isOperator: boolean;
  /** The tenant this request acts on (system/operator-only endpoints ignore it). */
  tenantId: string;
  rules: PermissionRule[];
}

/** Code-defined role, synced at bootstrap (upserted; permissions replaced). */
export interface RoleDefinition {
  key: string;
  name: string;
  permissions: PermissionRule[];
}

export const BUILTIN_ROLES: { key: string; name: string; permissions: Omit<PermissionRule, 'condition'>[] }[] = [
  { key: 'operator-admin', name: 'Operator admin', permissions: [{ action: '*', resource: '*', fields: null }] },
  {
    key: 'tenant-admin',
    name: 'Tenant admin',
    permissions: [
      { action: '*', resource: 'doc:*', fields: null },
      { action: 'manage', resource: 'system:keys', fields: null },
      { action: 'manage', resource: 'system:roles', fields: null },
      { action: 'manage', resource: 'system:webhooks', fields: null },
      { action: 'manage', resource: 'system:events', fields: null },
      { action: 'manage', resource: 'system:export', fields: null },
      { action: 'manage', resource: 'system:principals', fields: null },
      { action: 'manage', resource: 'system:jobs', fields: null },
    ],
  },
  {
    key: 'content-editor',
    name: 'Content editor',
    permissions: [
      { action: 'read', resource: 'doc:*', fields: null },
      { action: 'readDraft', resource: 'doc:*', fields: null },
      { action: 'create', resource: 'doc:*', fields: null },
      { action: 'update', resource: 'doc:*', fields: null },
      { action: 'delete', resource: 'doc:*', fields: null },
      { action: 'publish', resource: 'doc:*', fields: null },
    ],
  },
  { key: 'content-reader', name: 'Content reader', permissions: [{ action: 'read', resource: 'doc:*', fields: null }] },
  // `public` starts with no permissions; collections opt in via access.publicRead.
  { key: 'public', name: 'Public (anonymous)', permissions: [] },
];

// -- API keys -----------------------------------------------------------------

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface CreatedKey {
  id: string;
  token: string;
  prefix: string;
}

export async function createApiKey(
  db: Queryable,
  input: { principalId: string; label?: string; expiresAt?: Date; token?: string },
): Promise<CreatedKey> {
  const id = uuidv7();
  const token = input.token ?? `apick_${randomBytes(24).toString('base64url')}`;
  const prefix = token.slice(0, 12);
  await db.query(sql`
    insert into apick_api_keys (id, token_hash, prefix, principal_id, label, expires_at)
    values (${id}, ${hashToken(token)}, ${prefix}, ${input.principalId}, ${input.label ?? ''}, ${input.expiresAt ?? null})
  `);
  return { id, token, prefix };
}

export async function revokeApiKey(db: Queryable, keyId: string): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(sql`
    update apick_api_keys set revoked_at = now() where id = ${keyId} and revoked_at is null returning id
  `);
  return rows.length > 0;
}

interface KeyLookupRow {
  key_id: string;
  token_hash: string;
  principal_id: string;
  expires_at: Date | null;
  revoked_at: Date | null;
}

// -- principals / roles / grants ----------------------------------------------

export async function createPrincipal(db: Queryable, input: { kind: 'user' | 'service' | 'agent'; name: string; email?: string }): Promise<{ id: string }> {
  const id = uuidv7();
  await db.query(sql`
    insert into apick_principals (id, kind, name, email)
    values (${id}, ${input.kind}, ${input.name}, ${input.email ?? null})
  `);
  return { id };
}

export async function grantRole(db: Queryable, input: { principalId: string; roleKey: string; tenantId: string | null }): Promise<void> {
  const { rows } = await db.query<{ id: string; tenant_id: string | null }>(sql`
    select id, tenant_id from apick_roles
    where key = ${input.roleKey} and (tenant_id is null or tenant_id is not distinct from ${input.tenantId})
    order by tenant_id nulls last
    limit 1
  `);
  const role = rows[0];
  if (!role) throw errors.notFound(`Role "${input.roleKey}" not found`);
  await db.query(sql`
    insert into apick_role_grants (id, principal_id, role_id, tenant_id)
    values (${uuidv7()}, ${input.principalId}, ${role.id}, ${input.tenantId})
    on conflict do nothing
  `);
}

export async function createRole(
  db: Queryable,
  input: { key: string; name: string; tenantId: string | null; permissions: PermissionRule[] },
): Promise<{ id: string }> {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(input.key)) throw errors.badRequest(`Invalid role key "${input.key}"`);
  const id = uuidv7();
  await db.query(sql`
    insert into apick_roles (id, tenant_id, key, name) values (${id}, ${input.tenantId}, ${input.key}, ${input.name})
  `);
  for (const p of input.permissions) {
    await db.query(sql`
      insert into apick_permissions (id, role_id, action, resource, fields, condition)
      values (${uuidv7()}, ${id}, ${p.action}, ${p.resource}, ${p.fields ? JSON.stringify(p.fields) : null}, ${p.condition ? JSON.stringify(p.condition) : null})
    `);
  }
  return { id };
}

// -- access resolution ----------------------------------------------------------

/**
 * Bring-your-own-IdP identity, returned by the `auth.verifyToken` hook after
 * it verifies a non-APIck bearer token (a JWT from Auth0/Supabase/Clerk/…).
 */
export interface ExternalIdentity {
  /** Stable subject from your IdP (e.g. the JWT `sub` claim). */
  externalId: string;
  kind?: 'user' | 'service' | 'agent';
  name?: string;
  email?: string;
  /**
   * Role keys applied within the RESOLVED TENANT for this request (drive them
   * from IdP claims). Never confers operator scope — grant that persistently
   * via POST /v1/grants if you really mean it.
   */
  roles?: string[];
}

export type VerifyTokenHook = (
  token: string,
  request: Request,
) => Promise<ExternalIdentity | null> | ExternalIdentity | null;

export interface ResolveAccessInput {
  token: string | null;
  tenantId: string;
  via: AccessContext['via'];
  caches?: AuthCaches;
  verifyToken?: VerifyTokenHook | null;
  request?: Request;
}

type GrantRow = {
  tenant_id: string | null;
  action: string;
  resource: string;
  fields: string[] | null;
  condition: Record<string, unknown> | null;
};

async function publicRules(db: Queryable, caches?: AuthCaches): Promise<PermissionRule[]> {
  const cached = caches?.publicRules.get('public') as PermissionRule[] | undefined;
  if (cached) return cached;
  const { rows } = await db.query<PermissionRule>(sql`
    select p.action, p.resource, p.fields, p.condition
    from apick_permissions p
    join apick_roles r on r.id = p.role_id
    where r.key = 'public' and r.tenant_id is null
  `);
  caches?.publicRules.set('public', rows);
  return rows;
}

async function grantsFor(db: Queryable, principalId: string): Promise<GrantRow[]> {
  const { rows } = await db.query<GrantRow>(sql`
    select g.tenant_id, p.action, p.resource, p.fields, p.condition
    from apick_role_grants g
    join apick_permissions p on p.role_id = g.role_id
    where g.principal_id = ${principalId}
  `);
  return rows;
}

function contextFromGrants(
  base: { principalId: string; keyId: string | null; via: AccessContext['via']; tenantId: string },
  grants: GrantRow[],
  publicBaseline: PermissionRule[],
  extraRules: PermissionRule[] = [],
): AccessContext {
  const isOperator = grants.some((g) => g.tenant_id === null);
  const applicable = grants.filter((g) => g.tenant_id === null || g.tenant_id === base.tenantId);
  const rules: PermissionRule[] = applicable.map((g) => ({
    action: g.action,
    resource: g.resource,
    fields: g.fields,
    condition: g.condition,
  }));
  rules.push(...extraRules, ...publicBaseline);
  return { ...base, isOperator, rules };
}

/** Permission rules of the given role keys, resolvable in this tenant (used for IdP-claim roles). */
async function rulesForRoleKeys(db: Queryable, roleKeys: string[], tenantId: string): Promise<PermissionRule[]> {
  if (roleKeys.length === 0) return [];
  const { rows } = await db.query<PermissionRule>(sql`
    select p.action, p.resource, p.fields, p.condition
    from apick_permissions p
    join apick_roles r on r.id = p.role_id
    where r.key = any(${roleKeys}) and (r.tenant_id is null or r.tenant_id = ${tenantId})
  `);
  return rows;
}

async function resolveExternal(
  db: Db,
  identity: ExternalIdentity,
  input: ResolveAccessInput,
): Promise<AccessContext> {
  if (typeof identity.externalId !== 'string' || identity.externalId.length === 0 || identity.externalId.length > 255) {
    throw errors.unauthorized('Identity provider returned an invalid externalId');
  }
  type Bundle = { principalId: string; grants: GrantRow[] };
  let bundle = input.caches?.externals.get(identity.externalId) as Bundle | undefined;
  if (!bundle) {
    const { rows } = await db.query<{ id: string }>(sql`
      insert into apick_principals (id, kind, name, email, external_id)
      values (${uuidv7()}, ${identity.kind ?? 'user'}, ${identity.name ?? identity.externalId}, ${identity.email ?? null}, ${identity.externalId})
      on conflict (external_id) where external_id is not null
      do update set name = excluded.name, email = excluded.email
      returning id
    `);
    const principalId = rows[0]!.id;
    bundle = { principalId, grants: await grantsFor(db, principalId) };
    input.caches?.externals.set(identity.externalId, bundle);
  }
  // Claim-driven roles are ephemeral and tenant-scoped by construction: they can
  // never confer operator scope (contextFromGrants derives isOperator from
  // PERSISTENT grants only).
  const claimRules = await rulesForRoleKeys(db, identity.roles ?? [], input.tenantId);
  return contextFromGrants(
    { principalId: bundle.principalId, keyId: null, via: input.via, tenantId: input.tenantId },
    bundle.grants,
    await publicRules(db, input.caches),
    claimRules,
  );
}

export async function resolveAccess(db: Db, input: ResolveAccessInput): Promise<AccessContext> {
  if (!input.token) {
    return {
      principalId: null,
      keyId: null,
      via: input.via,
      isOperator: false,
      tenantId: input.tenantId,
      rules: await publicRules(db, input.caches),
    };
  }

  // 1) APIck API key?
  const tokenHash = hashToken(input.token);
  type KeyBundle = { key: KeyLookupRow; grants: GrantRow[] };
  let bundle = input.caches?.keys.get(tokenHash) as KeyBundle | undefined;
  const fromCache = bundle !== undefined;
  if (!bundle) {
    const { rows } = await db.query<KeyLookupRow>(sql`
      select id as key_id, token_hash, principal_id, expires_at, revoked_at
      from apick_api_keys where token_hash = ${tokenHash}
    `);
    const key = rows[0];
    // timing-safe compare even though we looked up by hash (defense in depth)
    if (key && timingSafeEqual(Buffer.from(key.token_hash), Buffer.from(tokenHash))) {
      bundle = { key, grants: await grantsFor(db, key.principal_id) };
      if (!key.revoked_at) input.caches?.keys.set(tokenHash, bundle);
    }
  }

  if (bundle) {
    const { key } = bundle;
    if (key.revoked_at) throw errors.unauthorized('API key revoked');
    if (key.expires_at && new Date(key.expires_at).getTime() < Date.now()) throw errors.unauthorized('API key expired');
    if (!fromCache) {
      db.query(sql`update apick_api_keys set last_used_at = now() where id = ${key.key_id}`).catch(() => {});
    }
    return contextFromGrants(
      { principalId: key.principal_id, keyId: key.key_id, via: input.via, tenantId: input.tenantId },
      bundle.grants,
      await publicRules(db, input.caches),
    );
  }

  // 2) Bring-your-own-IdP token?
  if (input.verifyToken && input.request) {
    const identity = await input.verifyToken(input.token, input.request);
    if (identity) return resolveExternal(db, identity, input);
  }

  throw errors.unauthorized('Invalid API key');
}

// -- permission checks -----------------------------------------------------------

function actionMatches(rule: string, action: string): boolean {
  return rule === '*' || rule === action;
}

function resourceMatches(rule: string, resource: string): boolean {
  if (rule === '*') return true;
  if (rule === resource) return true;
  if (rule.endsWith(':*')) return resource.startsWith(rule.slice(0, -1));
  return false;
}

export function rulesFor(ctx: AccessContext, action: string, resource: string): PermissionRule[] {
  return ctx.rules.filter((r) => actionMatches(r.action, action) && resourceMatches(r.resource, resource));
}

export function can(ctx: AccessContext, action: string, resource: string): boolean {
  return rulesFor(ctx, action, resource).length > 0;
}

export function assertCan(ctx: AccessContext, action: string, resource: string): void {
  if (!can(ctx, action, resource)) {
    if (ctx.principalId === null) throw errors.unauthorized();
    throw errors.forbidden(`Missing permission: ${action} on ${resource}`);
  }
}

/**
 * Effective readable-field whitelist for a collection, or null for "all
 * non-private fields". Union across matching rules.
 */
export function readableFields(ctx: AccessContext, collection: string): string[] | null {
  const rules = rulesFor(ctx, 'read', `doc:${collection}`).concat(rulesFor(ctx, 'readDraft', `doc:${collection}`));
  if (rules.length === 0) return [];
  if (rules.some((r) => r.fields === null)) return null;
  return [...new Set(rules.flatMap((r) => r.fields!))];
}

/**
 * Effective writable-field whitelist for create/update, or null for "all
 * fields". Union across matching rules — a rule with `fields` restricts which
 * TOP-LEVEL fields its holder may write.
 */
export function writableFields(ctx: AccessContext, action: 'create' | 'update', collection: string): string[] | null {
  const rules = rulesFor(ctx, action, `doc:${collection}`);
  if (rules.length === 0) return [];
  if (rules.some((r) => r.fields === null)) return null;
  return [...new Set(rules.flatMap((r) => r.fields!))];
}

export function assertFieldsWritable(ctx: AccessContext, action: 'create' | 'update', collection: string, keys: string[]): void {
  const allowed = writableFields(ctx, action, collection);
  if (allowed === null) return;
  for (const key of keys) {
    if (!allowed.includes(key)) {
      throw errors.forbidden(`Field "${key}" is not writable with your permissions`, );
    }
  }
}

/**
 * Row-level conditions for an action: if ANY matching rule is unconditional,
 * access is unconditional; otherwise conditions are OR-ed. `$me` in a
 * condition resolves to the principal id.
 */
export function conditionsFor(ctx: AccessContext, action: string, collection: string): Record<string, unknown>[] | 'unconditional' {
  const rules = rulesFor(ctx, action, `doc:${collection}`);
  if (rules.some((r) => !r.condition)) return 'unconditional';
  return rules.map((r) => substituteVars(r.condition!, ctx) as Record<string, unknown>);
}

function substituteVars(node: unknown, ctx: AccessContext): unknown {
  if (node === '$me') return ctx.principalId;
  if (Array.isArray(node)) return node.map((n) => substituteVars(n, ctx));
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, substituteVars(v, ctx)]));
  }
  return node;
}

// -- tenants ---------------------------------------------------------------------

export interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  settings: Record<string, unknown>;
}

export async function resolveTenantBySlugOrId(db: Queryable, slugOrId: string): Promise<TenantRow | null> {
  const byId = isUuid(slugOrId);
  const { rows } = await db.query<TenantRow>(
    byId
      ? sql`select id, slug, name, status, settings from apick_tenants where id = ${slugOrId}`
      : sql`select id, slug, name, status, settings from apick_tenants where slug = ${slugOrId}`,
  );
  return rows[0] ?? null;
}

export async function createTenant(db: Queryable, input: { slug: string; name: string; settings?: Record<string, unknown> }): Promise<TenantRow> {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(input.slug)) throw errors.badRequest(`Invalid tenant slug "${input.slug}"`);
  const id = uuidv7();
  const { rows } = await db.query<TenantRow>(sql`
    insert into apick_tenants (id, slug, name, settings)
    values (${id}, ${input.slug}, ${input.name}, ${JSON.stringify(input.settings ?? {})})
    returning id, slug, name, status, settings
  `);
  return rows[0]!;
}
