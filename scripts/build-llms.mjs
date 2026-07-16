// Regenerates docs/llms.txt and docs/llms-full.txt from README + guides,
// so the machine-readable docs can never drift from the human ones.
//   node scripts/build-llms.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

const GUIDES = [
  'docs/guides/getting-started.md',
  'docs/guides/cms.md',
  'docs/guides/schema.md',
  'docs/guides/queries.md',
  'docs/guides/auth-rbac.md',
  'docs/guides/tenancy.md',
  'docs/guides/webhooks.md',
  'docs/guides/jobs-cron.md',
  'docs/guides/mcp.md',
  'docs/guides/deployment.md',
  'docs/guides/portability.md',
  'docs/guides/extending.md',
];

const llms = `# APIck (API Construction Kit)

> Pure-headless, AI-first application platform for Node.js + Postgres. One
> TypeScript schema definition produces a validated REST API, RBAC,
> multi-tenancy, versioned documents with pointer-publish, reliable signed
> webhooks, durable jobs/cron, OpenAPI 3.1, and a first-class MCP server.
> No admin UI by design — developers, apps and AI agents are the users.
> npm package: \`apick\`. Requires Node >= 22. Embedded Postgres (PGlite) for
> dev; any Postgres >= 14 in production.

Every running APIck app also serves ITS OWN live docs at /llms.txt,
/llms-full.txt and /openapi.json — generated from that app's actual schema.
This file documents the framework itself.

## Docs

- [Getting started](docs/guides/getting-started.md): install, hello world, document lifecycle, error contract
- [@apick/cms](docs/guides/cms.md): the full themable CMS on core — admin UI, users, themes, plugins
- [Schema & fields](docs/guides/schema.md): field DSL, unique/private/indexed/immutable, lossless renames
- [Queries](docs/guides/queries.md): filter grammar, bounded reads, populate, saved queries
- [Auth & RBAC](docs/guides/auth-rbac.md): API keys, built-in + custom roles, field whitelists, row conditions
- [Multi-tenancy](docs/guides/tenancy.md): operator scope, tenant resolution, structural isolation
- [Webhooks](docs/guides/webhooks.md): signatures, retries, dead-letter, replay, change feed
- [Jobs & cron](docs/guides/jobs-cron.md): durable queue, idempotency, cluster-single-fire schedules
- [MCP](docs/guides/mcp.md): tools, least-privilege agent access, attribution
- [Deployment](docs/guides/deployment.md): Postgres/Supabase, explicit migrations, N replicas
- [Portability](docs/guides/portability.md): lossless export/import, SQL escape hatch
- [Extending](docs/guides/extending.md): custom endpoints, jobs-as-automation, stable surface
- [Architecture decisions](docs/decisions/0001-architecture.md): the full design rationale

## Optional

- [Full compiled guide](docs/llms-full.txt): all of the above in one file
`;

const full = [
  `# APIck — complete framework guide (compiled from docs/guides)\n`,
  read('README.md'),
  ...GUIDES.map((g) => read(g)),
].join('\n\n---\n\n');

writeFileSync(resolve(root, 'docs/llms.txt'), llms);
writeFileSync(resolve(root, 'docs/llms-full.txt'), full);
console.log(`wrote docs/llms.txt (${llms.length}b) and docs/llms-full.txt (${full.length}b)`);
