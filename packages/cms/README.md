# @apick/cms

**A full, themable CMS on top of [`@apick/core`](https://www.npmjs.com/package/@apick/core)** —
WordPress-class out of the box, headless-first underneath. Your schema
definition generates the admin UI, the REST API, the MCP tools and the
validation, all from one source.

```bash
npx --package=@apick/cms apick-cms init my-site && cd my-site && npm install && npm start
```

Open `http://localhost:3000/admin` — the first visit creates your admin
account. That's the install.

## What's in the box

- **Schema-driven admin UI** (`/admin`): listings with search + status,
  an editor generated for every field type — text, markdown, numbers,
  booleans, dates, enums, JSON, nested objects, lists, relations, and
  composable **blocks** with reordering. Draft → publish workflow
  (`draft / modified / published`), version history with one-click restore,
  users, API keys and webhooks management. No frontend build for you — the
  SPA ships pre-bundled.
- **Media library** (`/admin/media`): drag-and-drop upload, a browse grid, and
  a picker in every image field; files serve from `/media/:id/:filename` with
  hardened headers. Bytes default to a zero-config Postgres blob store; bring
  your own storage driver (S3, …) for large libraries.
- **Modern markdown editor**: [edodo-write](https://github.com/vivmagarwal/edodo-write)
  Notion/Medium-style WYSIWYG with Markdown as the value, plus slug
  auto-generation and draft autosave.
- **Themable server-rendered site** (`/`): pages + blog out of the box,
  navigation from your pages, dark-mode aware, zero client JS. Themes are
  code — override any template or block renderer, child-theme style.
- **Real users & sessions**: email + password (scrypt, stored in a `private`
  field the API structurally cannot leak), signed sessions, password changes
  invalidate sessions, roles: admin / editor (content only — user-management
  escalation is closed structurally) / viewer.
- **Still headless**: the admin UI is a pure REST client. The same session
  token works against `/v1` and `/mcp`; agents with scoped API keys manage
  content through MCP and their posts appear on the site like anyone else's.
- **Plugins**: collections + saved queries + durable jobs + crons + custom
  routes + admin nav + theme fragments in one unit.
- Everything from `@apick/core` underneath: multi-tenant Postgres platform,
  RBAC in the query planner, signed webhooks, durable jobs, OpenAPI,
  llms.txt, OpenTelemetry.

## The project layout

```
my-site/
  server.js        wiring (yours, ~20 lines)
  collections/     your content types      ← yours
  theme/           your child theme        ← yours
  plugins/         your plugins            ← yours
  node_modules/    the framework           ← never touched; upgrade via npm
```

Drupal's conventions, npm's distribution: there is no framework code in your
repo to fork by accident.

## Docs

Guides, architecture decisions and the black-box + real-browser test suites:
https://github.com/vivmagarwal/apick — see `docs/guides/cms.md`.

MIT.
