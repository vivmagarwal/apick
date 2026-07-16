import type { Db } from '../kernel/db.js';
import { uuidv7 } from '../kernel/ids.js';
import type { Logger } from '../kernel/log.js';
import { sql } from '../kernel/sql.js';
import { BUILTIN_ROLES, createApiKey, createTenant, hashToken, type RoleDefinition, type TenantRow } from '../auth/rbac.js';
import type { Registry } from '../content/registry.js';

/**
 * Idempotent install bootstrap. Creates the operator plumbing so hello-world
 * never has to think about tenancy:
 * - built-in roles (synced to their canonical permission sets)
 * - the default tenant
 * - the root principal with an operator-scope grant and one API key
 *
 * The root key is returned ONLY when newly created (shown once). Pass a fixed
 * `rootKey` for reproducible dev/test setups.
 */
export interface BootstrapResult {
  /** Set only when a new root key was just created — display it once. */
  rootKey: string | null;
  defaultTenant: TenantRow;
  rootPrincipalId: string;
}

const ROOT_NAME = '__root';

export async function bootstrap(
  db: Db,
  registry: Registry,
  config: { defaultTenant?: string; rootKey?: string; roles?: RoleDefinition[]; logger?: Logger },
): Promise<BootstrapResult> {
  // 1. built-in roles, synced to canonical permissions
  for (const role of BUILTIN_ROLES) {
    await db.transaction(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(sql`
        select id from apick_roles where key = ${role.key} and tenant_id is null for update
      `);
      let roleId = rows[0]?.id;
      if (!roleId) {
        roleId = uuidv7();
        await tx.query(sql`
          insert into apick_roles (id, tenant_id, key, name, builtin) values (${roleId}, ${null}, ${role.key}, ${role.name}, true)
        `);
      }
      // Builtin permission sets are code-owned: resync them (custom roles are untouched).
      await tx.query(sql`delete from apick_permissions where role_id = ${roleId}`);
      for (const p of role.permissions) {
        await tx.query(sql`
          insert into apick_permissions (id, role_id, action, resource, fields, condition)
          values (${uuidv7()}, ${roleId}, ${p.action}, ${p.resource}, ${p.fields ? JSON.stringify(p.fields) : null}, ${null})
        `);
      }
      // access.publicRead collections grant published reads to the public role.
      if (role.key === 'public') {
        for (const col of registry.list()) {
          if (!col.access.publicRead) continue;
          await tx.query(sql`
            insert into apick_permissions (id, role_id, action, resource, fields, condition)
            values (${uuidv7()}, ${roleId}, ${'read'}, ${`doc:${col.key}`}, ${null}, ${null})
          `);
        }
      }
    });
  }

  // 1b. code-defined roles (config.roles): upsert + replace permissions, so
  // the code is the source of truth — same treatment as built-ins.
  for (const role of config.roles ?? []) {
    if (BUILTIN_ROLES.some((b) => b.key === role.key)) {
      throw new Error(`Role key "${role.key}" is reserved (built-in)`);
    }
    await db.transaction(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(sql`
        select id from apick_roles where key = ${role.key} and tenant_id is null for update
      `);
      let roleId = rows[0]?.id;
      if (!roleId) {
        roleId = uuidv7();
        await tx.query(sql`
          insert into apick_roles (id, tenant_id, key, name, builtin) values (${roleId}, ${null}, ${role.key}, ${role.name}, false)
        `);
      } else {
        await tx.query(sql`update apick_roles set name = ${role.name} where id = ${roleId}`);
      }
      await tx.query(sql`delete from apick_permissions where role_id = ${roleId}`);
      for (const perm of role.permissions) {
        await tx.query(sql`
          insert into apick_permissions (id, role_id, action, resource, fields, condition)
          values (${uuidv7()}, ${roleId}, ${perm.action}, ${perm.resource}, ${perm.fields ? JSON.stringify(perm.fields) : null}, ${perm.condition ? JSON.stringify(perm.condition) : null})
        `);
      }
    });
  }

  // 2. default tenant
  const slug = config.defaultTenant ?? 'default';
  let tenant = (
    await db.query<TenantRow>(sql`select id, slug, name, status, settings from apick_tenants where slug = ${slug}`)
  ).rows[0];
  if (!tenant) {
    tenant = await createTenant(db, { slug, name: slug === 'default' ? 'Default' : slug });
    config.logger?.info('created default tenant', { slug });
  }

  // 3. root principal + operator grant + key
  let rootId = (
    await db.query<{ id: string }>(sql`select id from apick_principals where kind = 'service' and name = ${ROOT_NAME}`)
  ).rows[0]?.id;
  if (!rootId) {
    rootId = uuidv7();
    await db.query(sql`insert into apick_principals (id, kind, name) values (${rootId}, 'service', ${ROOT_NAME})`);
  }
  const { rows: adminRole } = await db.query<{ id: string }>(sql`
    select id from apick_roles where key = 'operator-admin' and tenant_id is null
  `);
  await db.query(sql`
    insert into apick_role_grants (id, principal_id, role_id, tenant_id)
    values (${uuidv7()}, ${rootId}, ${adminRole[0]!.id}, ${null})
    on conflict do nothing
  `);

  let rootKey: string | null = null;
  if (config.rootKey) {
    const { rows } = await db.query(sql`select 1 from apick_api_keys where token_hash = ${hashToken(config.rootKey)}`);
    if (rows.length === 0) {
      await createApiKey(db, { principalId: rootId, label: 'root (configured)', token: config.rootKey });
    }
  } else {
    const { rows } = await db.query(sql`
      select 1 from apick_api_keys where principal_id = ${rootId} and revoked_at is null limit 1
    `);
    if (rows.length === 0) {
      const created = await createApiKey(db, { principalId: rootId, label: 'root' });
      rootKey = created.token;
      config.logger?.info('created root API key (shown once)', { prefix: created.prefix });
    }
  }

  return { rootKey, defaultTenant: tenant, rootPrincipalId: rootId };
}
