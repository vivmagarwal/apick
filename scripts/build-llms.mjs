// Deterministic generator for the machine-readable docs (llms.txt / llms-full.txt).
//
// Produces, from a SINGLE source (the guides in docs/guides + each package.json):
//   docs/llms.txt              docs/llms-full.txt              (framework: core + cms)
//   packages/apick/llms.txt    packages/apick/llms-full.txt    (@apick/core)
//   packages/cms/llms.txt      packages/cms/llms-full.txt      (@apick/cms)
//
// Guarantees the user asked for:
//   - DETERMINISTIC: pure function of the repo files — no timestamps, no
//     randomness. Two runs on the same tree produce byte-identical output.
//   - UPDATES WITH DOCS: the text is the guides, concatenated; editing a guide
//     and regenerating updates every llms file. `pnpm build` regenerates them,
//     and `pnpm llms:check` fails if any committed file is stale (drift guard).
//   - UPDATES WITH VERSION: each per-package file is stamped with that
//     package's version, read from its package.json at generation time.
//
// Usage:  node scripts/build-llms.mjs          (write)
//         node scripts/build-llms.mjs --check   (verify no drift; exit 1 if stale)
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Write only when the content actually changed, so regenerating is a true
// no-op on an unchanged tree (keeps git status clean, makes the git/Claude
// hooks cost nothing when there's nothing to do).
function writeIfChanged(abs, content) {
  let current = '';
  try {
    current = readFileSync(abs, 'utf8');
  } catch {
    /* missing */
  }
  if (current === content) return false;
  writeFileSync(abs, content);
  return true;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const version = (pkgPath) => JSON.parse(read(pkgPath)).version;
const CHECK = process.argv.includes('--check');

// --- guide catalog: path + one-line summary (drives both index and full) ---
const GUIDE = {
  overview: ['docs/guides/apick-in-one-page.md', 'the whole API compactly — DSL, endpoints, filter grammar, invariants (read first)'],
  gettingStarted: ['docs/guides/getting-started.md', 'install, hello world, document lifecycle, error contract'],
  cms: ['docs/guides/cms.md', 'the full themable CMS on core — admin UI, users, media, themes, plugins'],
  buildSite: ['docs/guides/build-a-real-site.md', 'step-by-step: a real content site from zero to client-ready (the glopo.info playbook)'],
  schema: ['docs/guides/schema.md', 'field DSL, unique/private/indexed/immutable, lossless renames'],
  queries: ['docs/guides/queries.md', 'filter grammar, bounded reads, populate, saved queries'],
  authRbac: ['docs/guides/auth-rbac.md', 'API keys, BYO-IdP, built-in + custom roles, field whitelists, row conditions'],
  tenancy: ['docs/guides/tenancy.md', 'operator scope, tenant resolution, structural isolation'],
  webhooks: ['docs/guides/webhooks.md', 'signatures, retries, dead-letter, replay, change feed'],
  jobsCron: ['docs/guides/jobs-cron.md', 'durable queue, idempotency, cluster-single-fire schedules, retention'],
  mcp: ['docs/guides/mcp.md', 'tools, least-privilege agent access, attribution'],
  deployment: ['docs/guides/deployment.md', 'Postgres/Supabase, explicit migrations, N replicas, CORS, OTel'],
  portability: ['docs/guides/portability.md', 'lossless export/import, SQL escape hatch'],
  extending: ['docs/guides/extending.md', 'custom endpoints, jobs-as-automation, stable surface'],
};

// Which guides belong to which package. cms is a superset: it needs the full
// core API (same schema DSL, RBAC, queries) PLUS the CMS-specific guide.
const CORE_ORDER = ['overview', 'gettingStarted', 'schema', 'queries', 'authRbac', 'tenancy', 'webhooks', 'jobsCron', 'mcp', 'deployment', 'portability', 'extending'];
const CMS_ORDER = ['overview', 'cms', 'buildSite', 'gettingStarted', 'schema', 'queries', 'authRbac', 'tenancy', 'webhooks', 'jobsCron', 'mcp', 'deployment', 'portability', 'extending'];
const FRAMEWORK_ORDER = ['overview', 'gettingStarted', 'cms', 'buildSite', 'schema', 'queries', 'authRbac', 'tenancy', 'webhooks', 'jobsCron', 'mcp', 'deployment', 'portability', 'extending'];

const title = {
  overview: 'APIck in one page',
  gettingStarted: 'Getting started', cms: '@apick/cms', buildSite: 'Build a real site', schema: 'Schema & fields', queries: 'Queries',
  authRbac: 'Auth & RBAC', tenancy: 'Multi-tenancy', webhooks: 'Webhooks', jobsCron: 'Jobs & cron',
  mcp: 'MCP', deployment: 'Deployment', portability: 'Portability', extending: 'Extending',
};

const GENERATED_NOTE =
  'This file is GENERATED from docs/guides by scripts/build-llms.mjs — do not edit by hand.\n' +
  'It is deterministic, version-stamped, and regenerated on every build (`pnpm llms`).';

function indexList(order) {
  return order.map((k) => `- [${title[k]}](${GUIDE[k][0]}): ${GUIDE[k][1]}`).join('\n');
}

function fullBody(order) {
  return order.map((k) => read(GUIDE[k][0])).join('\n\n---\n\n');
}

// --- @apick/core ---
const coreV = version('packages/apick/package.json');
const coreLlms = `# @apick/core v${coreV}

> Pure-headless, AI-first application platform for Node.js + Postgres. One
> TypeScript schema definition produces a validated REST API, RBAC,
> multi-tenancy, versioned documents with pointer-publish, reliable signed
> webhooks, durable jobs/cron, OpenAPI 3.1, and a first-class MCP server.
> No admin UI by design — developers, apps and AI agents are the users.

Install: \`npm i @apick/core\` (Node >= 22). Embedded Postgres (PGlite) for dev;
any Postgres >= 14 in production. Repo: https://github.com/vivmagarwal/apick

Every running app also serves ITS OWN live docs at /llms.txt, /llms-full.txt and
/openapi.json — generated from that app's actual schema. This file documents the
@apick/core API itself.

${GENERATED_NOTE}

## Contents (full text in llms-full.txt)

${indexList(CORE_ORDER)}

## The full CMS

Building content sites/apps on top of core? See @apick/cms (\`npm i @apick/cms\`)
— a WordPress-class themable CMS with a schema-driven admin UI, users, media and
plugins, all consuming this same API. Its LLM docs cover the CMS plus the full
core API below.
`;
const coreFull = [`# @apick/core v${coreV} — complete API guide (generated from docs/guides)\n\n${GENERATED_NOTE}`, fullBody(CORE_ORDER)].join('\n\n---\n\n') + '\n';

// --- @apick/cms ---
const cmsV = version('packages/cms/package.json');
const cmsLlms = `# @apick/cms v${cmsV}

> A full, themable, WordPress-class CMS built on @apick/core: a schema-driven
> admin UI, users & sessions, a media library, an edodo-write markdown editor,
> and a server-rendered themable site. Still headless underneath — the admin is
> a REST client, and every running CMS is also an API + MCP server.

Install: \`npm i @apick/cms\` (Node >= 22). Scaffold a site:
\`npx --package=@apick/cms apick-cms init my-site\`. Repo:
https://github.com/vivmagarwal/apick

@apick/cms re-exports the @apick/core schema DSL, so a CMS project needs one
import. These docs are a SUPERSET: the CMS guide plus the full core API (schema,
queries, RBAC, webhooks, jobs, MCP, deployment) that CMS collections use.

${GENERATED_NOTE}

## Contents (full text in llms-full.txt)

${indexList(CMS_ORDER)}
`;
const cmsFull = [`# @apick/cms v${cmsV} — complete guide (generated from docs/guides; built on @apick/core v${coreV})\n\n${GENERATED_NOTE}`, fullBody(CMS_ORDER)].join('\n\n---\n\n') + '\n';

// --- framework-level (repo docs/) ---
const frameworkLlms = `# APIck (API Construction Kit)

> Two packages: @apick/core (pure-headless, AI-first platform for Node.js +
> Postgres) and @apick/cms (a full themable CMS built on core). One TypeScript
> schema definition drives a validated REST API, RBAC, multi-tenancy, versioned
> documents, signed webhooks, durable jobs/cron, OpenAPI 3.1 and a first-class
> MCP server. Requires Node >= 22.

Packages: @apick/core v${coreV} · @apick/cms v${cmsV}.
Every running app also serves ITS OWN live docs at /llms.txt, /llms-full.txt and
/openapi.json — generated from that app's actual schema. This file documents the
framework itself.

${GENERATED_NOTE}

## Docs

${indexList(FRAMEWORK_ORDER)}
- [Architecture decisions](docs/decisions/0001-architecture.md): the full design rationale

## Per-package LLM docs

- @apick/core: packages/apick/llms.txt · packages/apick/llms-full.txt
- @apick/cms: packages/cms/llms.txt · packages/cms/llms-full.txt

## Optional

- [Full compiled guide](docs/llms-full.txt): all of the above in one file
`;
const frameworkFull = [`# APIck — complete framework guide (generated from docs/guides)\n\n> @apick/core v${coreV} · @apick/cms v${cmsV}\n\n${GENERATED_NOTE}`, read('README.md'), fullBody(FRAMEWORK_ORDER)].join('\n\n---\n\n') + '\n';

// --- emit / check ---
const outputs = [
  ['docs/llms.txt', frameworkLlms],
  ['docs/llms-full.txt', frameworkFull],
  ['packages/apick/llms.txt', coreLlms],
  ['packages/apick/llms-full.txt', coreFull],
  ['packages/cms/llms.txt', cmsLlms],
  ['packages/cms/llms-full.txt', cmsFull],
];

let stale = 0;
let changed = 0;
for (const [rel, content] of outputs) {
  const abs = resolve(root, rel);
  if (CHECK) {
    let current = '';
    try {
      current = readFileSync(abs, 'utf8');
    } catch {
      /* missing */
    }
    if (current !== content) {
      console.error(`STALE: ${rel} (run \`pnpm llms\`)`);
      stale++;
    }
  } else if (writeIfChanged(abs, content)) {
    changed++;
  }
}

if (CHECK) {
  if (stale > 0) {
    console.error(`\n${stale} llms file(s) out of date. Regenerate with \`pnpm llms\` and commit.`);
    process.exit(1);
  }
  console.log('llms files are up to date.');
} else {
  console.log(
    changed > 0
      ? `regenerated ${changed}/${outputs.length} llms files (core v${coreV}, cms v${cmsV}).`
      : `llms files already current (core v${coreV}, cms v${cmsV}).`,
  );
}
