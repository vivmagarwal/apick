#!/usr/bin/env node
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDb } from '../kernel/db.js';
import { migrate, migrationStatus } from '../kernel/migrate.js';
import { Registry } from '../content/registry.js';
import { createLogger } from '../kernel/log.js';
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

Database resolution: --database > APICK_DATABASE_URL > DATABASE_URL > pglite://./.apick-data
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

const app = await createApp({ collections: [todos] });
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
