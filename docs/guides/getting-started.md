# Getting started

## Install & run

```bash
mkdir my-app && cd my-app && npm init -y && npm i apick
```

`server.js` (or use `npx apick init`):

```js
import { createApp, defineCollection, f } from 'apick';

const todos = defineCollection('todos', {
  fields: {
    title: f.text({ required: true }),
    done: f.boolean({ default: false }),
  },
});

const app = await createApp({ collections: [todos] });
console.log('root key:', app.rootKey); // printed ONCE on first boot — save it
await app.listen(3000);
```

```bash
node server.js
```

With no `database` configured, APIck runs an embedded Postgres (PGlite) in
`./.apick-data` — full SQL semantics, zero setup. For deployment, set
`database: 'postgres://…'` (or the `APICK_DATABASE_URL` / `DATABASE_URL` env vars).

## First requests

```bash
KEY=<the printed root key>

# create + publish
curl -X POST http://127.0.0.1:3000/v1/collections/todos/docs \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"data": {"title": "Ship it"}, "publish": true}'

# list (published by default)
curl -H "Authorization: Bearer $KEY" http://127.0.0.1:3000/v1/collections/todos/docs

# patch the draft (merge patch: send only what changes)
curl -X PATCH http://127.0.0.1:3000/v1/collections/todos/docs/<docId> \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"patch": {"done": true}}'
```

## The document lifecycle

Every document has a **draft head** and optionally a **published head** — two
pointers into an append-only version history of the same identity
`(docId, locale)`:

- `POST …/docs` creates version 1 as a draft (`"publish": true` publishes atomically)
- `PATCH …/docs/:docId` merge-patches the draft → new version
- `POST …/docs/:docId/publish` points the published head at the current draft (no copying)
- Reads default to `status=published`; `?status=draft` needs the `readDraft` permission
- `GET …/versions`, `GET …/versions/:n`, `POST …/versions/:n/restore` — history and rollback

## What you get for free

| Surface | URL |
|---|---|
| REST API | `/v1/collections/:key/docs` |
| OpenAPI 3.1 (live) | `/openapi.json` |
| Agent guides (live) | `/llms.txt`, `/llms-full.txt` |
| MCP server | `/mcp` |
| Health | `/health` |
| Audit / change feed | `/v1/events` |

## The error contract

Every error, on every surface:

```json
{ "error": { "code": "validation", "message": "…", "details": { } } }
```

Codes → status: `bad_request`/`plan_rejected` 400, `unauthorized` 401,
`forbidden` 403, `not_found` 404, `conflict` 409, `validation` 422, `internal` 500.

## Next

- [Schema & fields](schema.md) — the full DSL, uniques, private fields, renames
- [Auth & RBAC](auth-rbac.md) — keys, roles, custom permissions
- [Deployment](deployment.md) — real Postgres, migrations, replicas
