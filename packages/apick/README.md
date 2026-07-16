# @apick/core

**API Construction Kit** — a pure-headless, AI-first application platform for
Node.js and Postgres. One TypeScript schema definition produces a validated
REST API, RBAC, multi-tenancy, versioned documents with draft/publish,
reliable signed webhooks, durable background jobs and cron, OpenAPI 3.1,
`llms.txt`, and a first-class MCP server. No admin UI, by design.

> **🤖 Building with an AI/LLM? Give it the complete, always-current API in one file:**
> **https://cdn.jsdelivr.net/npm/@apick/core/llms-full.txt**
> (short index: [`…/llms.txt`](https://cdn.jsdelivr.net/npm/@apick/core/llms.txt) ·
> mirror: [`unpkg.com/@apick/core/llms-full.txt`](https://unpkg.com/@apick/core/llms-full.txt) ·
> pin a version: `@apick/core@0.5.3/llms-full.txt`). These ship in the package,
> are generated from the docs, and are stamped with the exact version.

```ts
import { createApp, defineCollection, f } from '@apick/core';

const todos = defineCollection('todos', {
  fields: {
    title: f.text({ required: true }),
    done: f.boolean({ default: false }),
  },
});

const app = await createApp({ collections: [todos] });
console.log('root key:', app.rootKey); // shown once on first boot
await app.listen(3000);
```

You now have:

- `POST/GET/PATCH/DELETE /v1/collections/todos/docs` — validated CRUD with
  draft→publish, version history and rollback
- `/openapi.json`, `/llms.txt`, `/llms-full.txt` — live, schema-accurate docs
- `/mcp` — an MCP server any AI agent can drive with a scoped API key
- webhooks with HMAC signatures, retries and dead-letter replay
- a durable job queue + cluster-single-fire cron — on plain Postgres
- multi-tenancy and RBAC enforced structurally in the query planner

No database setup needed in dev: an embedded Postgres (PGlite) lives in
`./.apick-data`. In production point `database` (or `APICK_DATABASE_URL`) at
any Postgres ≥ 14 — including Supabase — and run `npx apick migrate` on deploy.

## Guarantees (each backed by a black-box test)

- A `private: true` field is never readable, filterable, sortable or
  populatable through any API — structurally, in the query planner.
- Tenant isolation is compiled into every query; a tenant key cannot cross
  tenants.
- Publish is a pointer move, never a row clone; `unique` works everywhere,
  including nested objects.
- A field rename (`renamedFields`) is a lossless JSONB key migration — data,
  history and indexes survive.
- N replicas are safe: cron fires once cluster-wide; each webhook delivers once.
- Reads are bounded (filter/sort/populate/page caps) — no query a client sends
  can produce unbounded work.
- Export → import into a fresh install is lossless; ids are portable UUIDv7.

## LLM / agent docs

This package ships machine-readable docs generated from the guides, stamped with
this exact version:

- `llms.txt` — a concise index
- `llms-full.txt` — the complete API guide in one file

Point an agent at `node_modules/@apick/core/llms-full.txt`. (Every running app
also serves live, schema-specific docs at `/llms.txt`, `/llms-full.txt`,
`/openapi.json`.)

## Documentation

Full guides, architecture decisions and the test suite:
https://github.com/vivmagarwal/apick — plus every running app self-documents at
`/llms-full.txt`.

## CLI

```bash
npx --package=@apick/core apick init my-app      # runnable hello world
npx apick migrate --database postgres://…   [--app ./schema.js]
npx apick status
npx apick content push|pull|check ./content --app ./schema.js   # content as files (md + json)
```

MIT.
