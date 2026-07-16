import type { Db } from './db.js';
import { sql } from './sql.js';

/**
 * APIck's OWN fixed schema. This is the only DDL in the system apart from
 * opt-in `create index` statements for indexed fields. User content models are
 * data (rows in apick_collections / apick_docs), never DDL — which is what
 * makes schema changes safe and reversible by construction.
 *
 * Migrations are versioned, forward-only, and explicit: they run when the
 * caller asks (createApp `migrate: 'apply'`, or the `apick migrate` CLI),
 * never implicitly at server boot against production Postgres.
 */
interface Migration {
  version: number;
  name: string;
  statements: string[];
}

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core-schema',
    statements: [
      `create table apick_tenants (
        id uuid primary key,
        slug text not null unique,
        name text not null,
        status text not null default 'active',
        settings jsonb not null default '{}',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`,
      `create table apick_principals (
        id uuid primary key,
        kind text not null,
        name text not null,
        email text,
        created_at timestamptz not null default now()
      )`,
      `create table apick_api_keys (
        id uuid primary key,
        token_hash text not null unique,
        prefix text not null,
        principal_id uuid not null references apick_principals(id) on delete cascade,
        label text not null default '',
        expires_at timestamptz,
        revoked_at timestamptz,
        last_used_at timestamptz,
        created_at timestamptz not null default now()
      )`,
      `create table apick_roles (
        id uuid primary key,
        tenant_id uuid references apick_tenants(id) on delete cascade,
        key text not null,
        name text not null,
        builtin boolean not null default false,
        created_at timestamptz not null default now()
      )`,
      `create unique index apick_roles_scope_key on apick_roles (coalesce(tenant_id, '${ZERO_UUID}'::uuid), key)`,
      `create table apick_permissions (
        id uuid primary key,
        role_id uuid not null references apick_roles(id) on delete cascade,
        action text not null,
        resource text not null,
        fields jsonb,
        condition jsonb,
        created_at timestamptz not null default now()
      )`,
      `create index apick_permissions_role on apick_permissions (role_id)`,
      `create table apick_role_grants (
        id uuid primary key,
        principal_id uuid not null references apick_principals(id) on delete cascade,
        role_id uuid not null references apick_roles(id) on delete cascade,
        tenant_id uuid references apick_tenants(id) on delete cascade,
        created_at timestamptz not null default now()
      )`,
      `create unique index apick_role_grants_uniq on apick_role_grants (principal_id, role_id, coalesce(tenant_id, '${ZERO_UUID}'::uuid))`,
      `create table apick_collections (
        key text primary key,
        version int not null,
        schema jsonb not null,
        updated_at timestamptz not null default now()
      )`,
      `create table apick_doc_versions (
        id uuid primary key,
        tenant_id uuid not null,
        collection text not null,
        doc_id uuid not null,
        locale text not null,
        version int not null,
        op text not null,
        data jsonb not null,
        patch jsonb,
        actor uuid,
        created_at timestamptz not null default now(),
        unique (tenant_id, collection, doc_id, locale, version)
      )`,
      `create table apick_docs (
        tenant_id uuid not null references apick_tenants(id) on delete cascade,
        collection text not null,
        doc_id uuid not null,
        locale text not null,
        draft_version_id uuid not null references apick_doc_versions(id),
        published_version_id uuid references apick_doc_versions(id),
        draft_version int not null,
        published_version int,
        draft_data jsonb not null,
        published_data jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        published_at timestamptz,
        created_by uuid,
        primary key (tenant_id, collection, doc_id, locale)
      )`,
      `create index apick_docs_collection on apick_docs (tenant_id, collection, updated_at)`,
      `create table apick_edges (
        tenant_id uuid not null,
        collection text not null,
        doc_id uuid not null,
        locale text not null,
        head text not null,
        field text not null,
        position int not null default 0,
        to_collection text not null,
        to_doc_id uuid not null,
        primary key (tenant_id, collection, doc_id, locale, head, field, position)
      )`,
      `create index apick_edges_reverse on apick_edges (tenant_id, to_collection, to_doc_id, head)`,
      `create table apick_uniques (
        tenant_id uuid not null,
        collection text not null,
        field text not null,
        locale text not null,
        value_hash text not null,
        doc_id uuid not null,
        primary key (tenant_id, collection, field, locale, value_hash)
      )`,
      `create index apick_uniques_doc on apick_uniques (tenant_id, collection, doc_id)`,
      `create table apick_events (
        id uuid primary key,
        seq bigint generated always as identity,
        tenant_id uuid,
        type text not null,
        actor jsonb not null,
        subject jsonb not null,
        payload jsonb not null default '{}',
        created_at timestamptz not null default now()
      )`,
      `create index apick_events_tenant_seq on apick_events (tenant_id, seq)`,
      `create index apick_events_seq on apick_events (seq)`,
      `create index apick_events_type on apick_events (type)`,
      `create table apick_jobs (
        id uuid primary key,
        tenant_id uuid,
        queue text not null,
        payload jsonb not null default '{}',
        state text not null default 'pending',
        run_at timestamptz not null default now(),
        attempts int not null default 0,
        max_attempts int not null default 5,
        backoff_ms int not null default 1000,
        idempotency_key text,
        locked_by text,
        locked_at timestamptz,
        last_error text,
        created_at timestamptz not null default now(),
        finished_at timestamptz
      )`,
      `create unique index apick_jobs_idem on apick_jobs (queue, idempotency_key) where idempotency_key is not null`,
      `create index apick_jobs_ready on apick_jobs (state, run_at)`,
      `create table apick_crons (
        id uuid primary key,
        tenant_id uuid,
        key text not null,
        schedule text not null,
        queue text not null,
        payload jsonb not null default '{}',
        enabled boolean not null default true,
        next_run_at timestamptz not null,
        last_run_at timestamptz
      )`,
      `create unique index apick_crons_key on apick_crons (coalesce(tenant_id, '${ZERO_UUID}'::uuid), key)`,
      `create table apick_webhooks (
        id uuid primary key,
        tenant_id uuid not null references apick_tenants(id) on delete cascade,
        name text not null,
        url text not null,
        secret text not null,
        events jsonb not null default '["*"]',
        headers jsonb not null default '{}',
        enabled boolean not null default true,
        created_at timestamptz not null default now()
      )`,
      `create table apick_deliveries (
        id uuid primary key,
        webhook_id uuid not null references apick_webhooks(id) on delete cascade,
        tenant_id uuid not null,
        event_id uuid not null,
        state text not null default 'pending',
        attempts int not null default 0,
        last_status int,
        last_error text,
        next_attempt_at timestamptz,
        created_at timestamptz not null default now(),
        delivered_at timestamptz
      )`,
      `create unique index apick_deliveries_uniq on apick_deliveries (webhook_id, event_id)`,
      `create index apick_deliveries_webhook on apick_deliveries (webhook_id, created_at)`,
    ],
  },
  {
    version: 2,
    name: 'external-identities',
    statements: [
      // Bring-your-own-IdP: principals verified by the auth.verifyToken hook
      // are keyed by their IdP subject.
      `alter table apick_principals add column external_id text`,
      `create unique index apick_principals_external on apick_principals (external_id) where external_id is not null`,
    ],
  },
];

export async function migrate(db: Db): Promise<{ applied: string[] }> {
  await db.exec(`create table if not exists apick_migrations (
    version int primary key,
    name text not null,
    applied_at timestamptz not null default now()
  )`);

  const applied: string[] = [];
  await db.transaction(async (tx) => {
    if (db.kind === 'pg') {
      // Serialize concurrent migrators across replicas (xact-scoped lock).
      await tx.query(sql`select pg_advisory_xact_lock(872194617)`);
    }
    const { rows } = await tx.query<{ version: number }>(sql`select version from apick_migrations`);
    const done = new Set(rows.map((r) => r.version));
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      for (const statement of m.statements) {
        await tx.query(sql.raw(statement));
      }
      await tx.query(sql`insert into apick_migrations (version, name) values (${m.version}, ${m.name})`);
      applied.push(`${m.version}-${m.name}`);
    }
  });
  return { applied };
}

export async function migrationStatus(db: Db): Promise<{ current: number; latest: number; pending: string[] }> {
  const latest = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
  let current = 0;
  try {
    const { rows } = await db.query<{ version: number }>(sql`select max(version) as version from apick_migrations`);
    current = rows[0]?.version ?? 0;
  } catch {
    current = 0; // table missing = never migrated
  }
  const pending = MIGRATIONS.filter((m) => m.version > current).map((m) => `${m.version}-${m.name}`);
  return { current, latest, pending };
}
