#!/usr/bin/env node
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDb } from '../kernel/db.js';
import { migrate, migrationStatus } from '../kernel/migrate.js';
import { Registry } from '../content/registry.js';
import { randomBytes } from 'node:crypto';
import { createLogger } from '../kernel/log.js';
import { sql } from '../kernel/sql.js';
import { createApiKey, hashToken } from '../auth/rbac.js';
import type { Collection } from '../schema/collection.js';
import { VERSION } from '../version.js';

/**
 * apick CLI — deliberately small:
 *   apick init [dir]      scaffold a runnable hello-world app
 *   apick migrate         apply APIck's schema migrations (explicit, deploy-time)
 *   apick status          show pending migrations
 *
 * `migrate` accepts --app <module> to also create the opt-in field indexes for
 * your collections (the module must export `collections`). This is the ONLY
 * place DDL for user schemas ever happens — never at server boot.
 */

const HELP = `apick ${VERSION} — API Construction Kit

Usage:
  apick init [dir]                 Scaffold a hello-world app (runnable in <1 min)
  apick migrate [--database url] [--app ./app.js]
                                   Apply apick schema migrations (+ field indexes with --app)
  apick status [--database url]    Show migration status
  apick key list [--database url]  List active API keys (never token values)
  apick key rotate-root [--database url]
                                   Mint a new root key, revoke the old ones —
                                   the "lost root key" recovery path
  apick content push <dir> --app ./app.js [--database url] [--schema name]
                                   Upsert content files into collections
                                   (<dir>/<collection>/*.md + <collection>.json)
  apick content pull <dir> --app ./app.js [--database url] [--schema name]
                                   Export collection content back to files
  apick content check <dir> --app ./app.js
                                   Validate content files (no writes, exit 1 on problems)

Database resolution: --database > APICK_DATABASE_URL > DATABASE_URL > pglite://./.apick-data
(all db commands also honor --schema / APICK_DATABASE_SCHEMA)
`;

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const HELLO_SERVER = `import { createApp, defineCollection, f } from '@apick/core';

const todos = defineCollection('todos', {
  fields: {
    title: f.text({ required: true }),
    done: f.boolean({ default: false }),
  },
});

const app = await createApp({
  collections: [todos],
  // Sharing a Postgres with other apps (or other APIck instances)? Give this
  // app its own schema — created automatically, nothing else is touched:
  // databaseSchema: 'apick_my_app',
});
if (app.rootKey) {
  console.log('Your root API key (shown once, save it):');
  console.log('  ' + app.rootKey);
}
const { url } = await app.listen(3000);
console.log(\`
APIck is running:
  API      \${url}/v1/collections/todos/docs
  OpenAPI  \${url}/openapi.json
  MCP      \${url}/mcp
  Guide    \${url}/llms-full.txt

Try it:
  curl -H "Authorization: Bearer <your key>" -H "Content-Type: application/json" \\\\
    -d '{"data":{"title":"Ship it"},"publish":true}' \${url}/v1/collections/todos/docs
\`);
`;

const HELLO_PKG = `{
  "name": "my-apick-app",
  "private": true,
  "type": "module",
  "scripts": { "start": "node server.js" },
  "dependencies": { "@apick/core": "^${VERSION}" }
}
`;

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  const log = createLogger({ level: 'info' });

  switch (command) {
    case 'init': {
      const dir = resolve(process.cwd(), args[0] && !args[0].startsWith('--') ? args[0] : '.');
      mkdirSync(dir, { recursive: true });
      for (const [name, content] of [
        ['server.js', HELLO_SERVER],
        ['package.json', HELLO_PKG],
      ] as const) {
        const target = resolve(dir, name);
        if (existsSync(target)) {
          console.error(`refusing to overwrite ${target}`);
          process.exitCode = 1;
          return;
        }
        writeFileSync(target, content);
      }
      console.log(`Scaffolded APIck app in ${dir}\n\n  cd ${dir}\n  npm install\n  npm start\n`);
      return;
    }

    case 'migrate': {
      const url = arg(args, '--database');
      const db = await openDb(url !== undefined ? { url } : {});
      const { applied } = await migrate(db);
      log.info(applied.length > 0 ? 'migrations applied' : 'database already up to date', { applied });

      const appModule = arg(args, '--app');
      if (appModule) {
        const mod = (await import(pathToFileURL(resolve(process.cwd(), appModule)).href)) as {
          collections?: Collection[];
          default?: { collections?: Collection[] };
        };
        const collections = mod.collections ?? mod.default?.collections;
        if (!collections) {
          console.error(`--app module must export "collections" (an array of defineCollection results)`);
          process.exitCode = 1;
        } else {
          const registry = new Registry(collections);
          await registry.sync(db, { logger: log });
          const created = await registry.ensureIndexes(db);
          log.info('field indexes ensured', { count: created.length });
        }
      }
      await db.close();
      return;
    }

    case 'status': {
      const url = arg(args, '--database');
      const db = await openDb(url !== undefined ? { url } : {});
      const status = await migrationStatus(db);
      console.log(JSON.stringify(status, null, 2));
      await db.close();
      return;
    }

    case 'key': {
      const sub = args[0];
      const url = arg(args, '--database');
      const schema = arg(args, '--schema');
      const db = await openDb({ ...(url !== undefined ? { url } : {}), ...(schema !== undefined ? { schema } : {}) });
      try {
        if (sub === 'list') {
          const { rows } = await db.query<{ id: string; label: string; created_at: Date; last_used_at: Date | null; expires_at: Date | null; principal: string }>(sql`
            select k.id, k.label, k.created_at, k.last_used_at, k.expires_at, p.name as principal
            from apick_api_keys k join apick_principals p on p.id = k.principal_id
            where k.revoked_at is null order by k.created_at
          `);
          console.log(JSON.stringify(rows.map((r) => ({
            id: r.id, label: r.label, principal: r.principal,
            createdAt: r.created_at, lastUsedAt: r.last_used_at, expiresAt: r.expires_at,
          })), null, 2));
          return;
        }
        if (sub === 'rotate-root') {
          // mint a new root key, revoke every other root key — recoverable even
          // when the old key is lost (direct-DB, like `apick migrate`)
          const { rows: roots } = await db.query<{ id: string }>(sql`
            select id from apick_principals where kind = 'service' and name = '__root'
          `);
          const rootId = roots[0]?.id;
          if (!rootId) {
            console.error('No root principal found — has this database been bootstrapped (run the app once)?');
            process.exitCode = 1;
            return;
          }
          const token = `apick_root_${randomBytes(24).toString('base64url')}`;
          await createApiKey(db, { principalId: rootId, label: 'root (rotated via cli)', token });
          const { rows: revoked } = await db.query<{ id: string }>(sql`
            update apick_api_keys set revoked_at = now()
            where principal_id = ${rootId} and revoked_at is null and token_hash != ${hashToken(token)}
            returning id
          `);
          console.log('New root key (shown once — save it):');
          console.log(`  ${token}`);
          console.log(`Revoked ${revoked.length} previous root key(s).`);
          return;
        }
        console.error('Usage: apick key <list|rotate-root> [--database <url>] [--schema <name>]');
        process.exitCode = 1;
        return;
      } finally {
        await db.close();
      }
    }

    case 'content': {
      const { contentCommand } = await import('./content.js');
      await contentCommand(args);
      return;
    }

    case '--version':
    case '-v':
      console.log(VERSION);
      return;

    default:
      console.log(HELP);
      if (command && command !== 'help' && command !== '--help') process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
