# @apick/cms

**A full, themable CMS on top of [`@apick/core`](https://www.npmjs.com/package/@apick/core)** —
WordPress-class out of the box, headless-first underneath. Your schema
definition generates the admin UI, the REST API, the MCP tools and the
validation, all from one source.

> **🤖 Building with an AI/LLM? Give it the complete, always-current guide (CMS + full core API) in one file:**
> **https://cdn.jsdelivr.net/npm/@apick/cms/llms-full.txt**
> (short index: [`…/llms.txt`](https://cdn.jsdelivr.net/npm/@apick/cms/llms.txt) ·
> mirror: [`unpkg.com/@apick/cms/llms-full.txt`](https://unpkg.com/@apick/cms/llms-full.txt) ·
> pin a version: `@apick/cms@0.2.3/llms-full.txt`). Ships in the package,
> generated from the docs, version-stamped.

```bash
npx --package=@apick/cms apick-cms init my-site && cd my-site && npm install && npm start
```

Open `http://localhost:3000/admin` — the first visit creates your admin
account. That's the install.

## What's in the box

- **Schema-driven admin UI** (`/admin`): an editor generated for every field
  type — text, markdown, numbers, booleans, dates, enums, JSON, nested
  objects, lists, relations, and composable **blocks** with reordering.
  Relation pickers with live search and create-in-place; **related-content
  panels** show everything that points at a document (its resources, its
  tips, …) with reorder, edit-in-a-drawer, unlink and add-prefilled. Listings
  with full-text search, status filters and bulk publish/unpublish/delete.
  Draft → publish with **scheduling**, draft **preview** on the real site,
  version history with one-click restore, a ⌘K command palette, a read-only
  schema inspector, users, API keys and webhooks. No frontend build for you —
  the SPA (React + Tailwind, shadcn-style) ships pre-bundled.
- **Media library** (`/admin/media`): drag-and-drop upload, a browse grid, and
  a picker in every image field; files serve from `/media/:id/:filename` with
  hardened headers and on-demand **image variants** (`?w=320|480|960|1600`,
  optional sharp). Bytes default to a zero-config Postgres blob store; bring
  your own storage driver (S3, …) for large libraries.
- **Modern markdown editor**: [edodo-write](https://github.com/vivmagarwal/edodo-write)
  Notion/Medium-style WYSIWYG with Markdown as the value, plus slug
  auto-generation and draft autosave.
- **Themable server-rendered site** (`/`): pages + blog out of the box on the
  minimal black-&-white "barebones" theme, navigation from your pages,
  dark-mode aware, zero client JS. Themes are code — override any template or
  block renderer, child-theme style.
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

## LLM / agent docs

Ships `llms.txt` (index) and `llms-full.txt` (the CMS guide plus the full core
API), generated from the guides and stamped with this version — read
`node_modules/@apick/cms/llms-full.txt`.

## Docs

Guides, architecture decisions and the black-box + real-browser test suites:
https://github.com/vivmagarwal/apick — see `docs/guides/cms.md`.

MIT.
