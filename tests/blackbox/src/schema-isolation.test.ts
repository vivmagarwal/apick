import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp, defineCollection, f, silentLogger, sql, type ApickApp } from '@apick/core';
import { ApiClient, freshPgDatabase, pgUrl } from './helpers.js';

/**
 * PROMISE: several APIck apps can share ONE database, each isolated in its
 * own Postgres schema (`databaseSchema` / `?schema=` / APICK_DATABASE_SCHEMA)
 * — no table collisions, no cross-app reads, and nothing outside the schema
 * is touched (an existing database keeps its own tables undisturbed).
 */

const notes = () =>
  defineCollection('notes', {
    access: { publicRead: true },
    fields: { title: f.text({ required: true }) },
  });

describe('schema isolation (embedded PGlite)', () => {
  let app: ApickApp;

  afterAll(() => app?.stop());

  it('creates all tables inside the configured schema and works end to end', async () => {
    const rootKey = `apick_test_${randomBytes(8).toString('base64url')}`;
    app = await createApp({
      database: 'pglite://memory',
      databaseSchema: 'apick_site_a',
      collections: [notes()],
      rootKey,
      logger: silentLogger,
    });
    const { url } = await app.listen();
    const api = new ApiClient(url, rootKey);

    const created = await api.post('/v1/collections/notes/docs', { data: { title: 'hello' }, publish: true });
    expect(created.status).toBe(201);

    const inSchema = await app.db.query<{ n: string }>(
      sql`select count(*)::text as n from information_schema.tables
          where table_schema = 'apick_site_a' and table_name like 'apick_%'`,
    );
    expect(Number(inSchema.rows[0]!.n)).toBeGreaterThan(5);

    const inPublic = await app.db.query<{ n: string }>(
      sql`select count(*)::text as n from information_schema.tables
          where table_schema = 'public' and table_name like 'apick_%'`,
    );
    expect(Number(inPublic.rows[0]!.n)).toBe(0);
  });

  it('rejects malformed schema names at plan time', async () => {
    await expect(
      createApp({ database: 'pglite://memory', databaseSchema: 'bad-name!', logger: silentLogger }),
    ).rejects.toThrow(/Invalid database schema/);
  });
});

describe.skipIf(!pgUrl())('schema isolation on real Postgres (shared database)', () => {
  const apps: ApickApp[] = [];

  afterAll(async () => {
    for (const app of apps) await app.stop();
  });

  it('two apps in one database stay fully isolated and leave existing tables alone', async () => {
    const database = await freshPgDatabase();

    // an "existing" application already lives in public
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: database });
    await client.connect();
    await client.query(`create table legacy_users (id serial primary key, name text)`);
    await client.query(`insert into legacy_users (name) values ('keep-me')`);

    const rootA = `apick_a_${randomBytes(8).toString('base64url')}`;
    const rootB = `apick_b_${randomBytes(8).toString('base64url')}`;
    const mk = (schema: string, rootKey: string) =>
      createApp({
        database,
        databaseSchema: schema,
        collections: [notes()],
        rootKey,
        migrate: 'apply',
        logger: silentLogger,
      });

    // boot CONCURRENTLY — migrations must not deadlock or cross-apply
    const [appA, appB] = await Promise.all([mk('apick_site_a', rootA), mk('apick_site_b', rootB)]);
    apps.push(appA, appB);
    const [urlA, urlB] = [await appA.listen(), await appB.listen()];
    const apiA = new ApiClient(urlA.url, rootA);
    const apiB = new ApiClient(urlB.url, rootB);

    // writes land in their own schema…
    await apiA.post('/v1/collections/notes/docs', { data: { title: 'only-in-A' }, publish: true });
    const inB = await apiB.get('/v1/collections/notes/docs');
    expect(inB.body.data).toHaveLength(0);
    const inA = await apiA.get('/v1/collections/notes/docs');
    expect(inA.body.data).toHaveLength(1);

    // …root keys don't cross apps…
    const crossAuth = await new ApiClient(urlB.url, rootA).get('/v1/collections/notes/docs');
    expect(crossAuth.status).toBe(401);

    // …tables live where they should, and the existing app is untouched
    const placement = await client.query(
      `select table_schema, count(*)::int as n from information_schema.tables
       where table_name like 'apick_%' group by table_schema order by table_schema`,
    );
    expect(placement.rows.map((r: { table_schema: string }) => r.table_schema)).toEqual(['apick_site_a', 'apick_site_b']);
    const legacy = await client.query(`select name from legacy_users`);
    expect(legacy.rows).toEqual([{ name: 'keep-me' }]);
    const publicApick = await client.query(
      `select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name like 'apick_%'`,
    );
    expect(publicApick.rows[0].n).toBe(0);
    await client.end();
  });

  it('?schema= on the database URL works too', async () => {
    const database = await freshPgDatabase();
    const rootKey = `apick_c_${randomBytes(8).toString('base64url')}`;
    const app = await createApp({
      database: `${database}${database.includes('?') ? '&' : '?'}schema=apick_via_url`,
      collections: [notes()],
      rootKey,
      migrate: 'apply',
      logger: silentLogger,
    });
    apps.push(app);
    const { url } = await app.listen();
    const created = await new ApiClient(url, rootKey).post('/v1/collections/notes/docs', { data: { title: 'x' } });
    expect(created.status).toBe(201);

    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: database });
    await client.connect();
    const rows = await client.query(`select count(*)::int as n from apick_via_url.apick_docs`);
    expect(rows.rows[0].n).toBe(1);
    await client.end();
  });
});
