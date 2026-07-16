# @apick/cms — the full CMS

Everything in `@apick/core`, plus what WordPress/Drupal give you: an admin UI
generated from your schemas, users with passwords and roles, and a themable
server-rendered site. Still headless underneath — the admin is a REST client,
and every running CMS is also an API + MCP server.

## Zero to CMS

```bash
npx apick-cms init my-site && cd my-site && npm install && npm start
```

Open `http://localhost:3000/admin` — the first visit walks you through
creating your admin account (that's the whole install). The site is at `/`,
the API at `/v1`, MCP at `/mcp`.

Or in code:

```js
import { createCms } from '@apick/cms';
const app = await createCms({ site: { title: 'My Site' } });
await app.listen(3000);
```

## What you get out of the box

- **Content model**: `pages` (block-composed, `showInNav`) and `posts`
  (markdown blog). Disable with `defaultContent: false`.
- **Admin UI** at `/admin`: dashboard, listings with search/status/pagination,
  a schema-driven editor for every field type (text/markdown/number/boolean/
  datetime/enum/json/objects/lists/relations/**blocks with reordering**),
  draft→publish workflow with `draft/modified/published` states, version
  history with restore, users, API keys, webhooks.
- **Site** at `/`: server-rendered by the theme — home, `/blog`,
  `/blog/:slug`, `/:page-slug`, nav from pages, themed 404, dark-mode aware,
  zero client JS.

## Project layout (the "yours vs not yours" rule)

```
my-site/
  server.js        wiring — yours, small
  collections/     your content types      ← meant to be touched
  theme/           your child theme        ← meant to be touched
  plugins/         your plugins            ← meant to be touched
  node_modules/    the framework           ← never touched; npm update upgrades it
```

Add a collection and it automatically gets: an admin UI, validation, REST
endpoints, MCP tools, webhooks and history:

```js
// collections/recipes.js
import { defineCollection, f } from '@apick/cms';
export const recipes = defineCollection('recipes', {
  access: { publicRead: true },
  fields: {
    name: f.text({ required: true }),
    slug: f.slug({ required: true, unique: true }),
    difficulty: f.enum(['easy', 'medium', 'hard'], { default: 'easy' }),
    ingredients: f.list(f.text()),
    instructions: f.markdown({ required: true }),
  },
});
```

## Users, roles & sessions

- Humans sign in with email + password (scrypt-hashed into a `private` field —
  structurally unreadable via any API). Sessions are signed tokens; changing a
  password invalidates that user's sessions everywhere.
- Three CMS roles map onto core RBAC: **admin** (everything), **editor**
  (all content, *never* user management — escalation is closed structurally),
  **viewer** (read-only, drafts included).
- The same session token works against `/v1` and `/mcp` — an admin user IS an
  API principal; every action is attributed in the audit log.
- Agents get scoped API keys from Settings → API keys (e.g. the `cms-editor`
  role) and drive the same content through MCP.

## Theming

A theme is code: templates + block renderers + css. Override only what you
want (child-theme semantics):

```js
// theme/index.js
import { html, md, defaultTheme } from '@apick/cms';
export const theme = {
  name: 'mine',
  css: defaultTheme.css + `\n.hero h1 { color: rebeccapurple; }`,
  templates: {
    home: ({ site, posts }) => html`
      <h1>${site.title}</h1>
      <ul>${posts.map((p) => html`<li><a href="/blog/${p.data.slug}">${p.data.title}</a></li>`)}</ul>`,
  },
  blocks: {
    quote: (props) => html`<aside class="pull">${props.text}</aside>`,
  },
};
```

- `html` escapes interpolations by default; `md()` renders markdown (editors
  are trusted authors, as in WordPress); `raw()` marks trusted HTML.
- Templates: `layout, home, page, post, postList, notFound`. Blocks render
  `f.blocks` variants — add renderers for your own variants.

## Plugins

One composable unit over the existing primitives — no internal override points:

```js
export const analyticsPlugin = {
  name: 'analytics',
  collections: [events],                      // more content types
  jobs: { 'roll-up': async (payload) => {} }, // durable background work
  crons: [{ key: 'nightly', schedule: '0 2 * * *', queue: 'roll-up' }],
  routes: (hono) => hono.get('/api/stats', (c) => c.json({ ok: true })),
  adminNav: [{ label: 'Analytics', href: '/api/stats' }],
  theme: { blocks: { chart: (props) => html`…` } },
};
```

## Configuration

`createCms` accepts everything `createApp` does (database, retention, CORS,
webhooks, telemetry, …) plus:

| Option | Meaning |
|---|---|
| `site.title / description / postsPageSize` | site identity |
| `collections / queries / jobs / crons` | merged with defaults + plugins |
| `defaultContent: false` | drop pages/posts |
| `theme` | child-theme overrides |
| `plugins` | see above |
| `session.ttlHours` (72) / `session.secret` | session policy; secret comes from config → `APICK_CMS_SECRET` → generated once and persisted |

## Deploying

Same story as core (see [deployment.md](deployment.md)): embedded Postgres in
dev, `APICK_DATABASE_URL=postgres://…` in production, N replicas safe.
Sessions and the CMS's internal service key derive from the persisted secret,
so replicas and restarts agree with no coordination.

## v1 boundaries

The admin manages the default tenant (multi-tenant admin UI is post-v1 —
the API's multi-tenancy is unaffected). No media library yet — store files in
object storage and use `f.uri` fields. Both are on the roadmap in
[ADR-0002](../decisions/0002-cms-on-core.md).
