# Build a real site with APIck CMS — the glopo.info playbook

Step-by-step instructions for taking a content-heavy site from nothing to
client-ready, exactly the way APIck's first production site (glopo.info — an
IB Global Politics teaching hub: ~45 pages, a filterable case library, 126
resource cards, a non-technical editor) was built. Follow it literally; every
command works as written.

At the end you have ONE process serving: a public site on your own theme, a
full admin panel, a REST API, webhooks, durable jobs/cron, and an MCP server —
with editors working in the admin and AI agents working over MCP against the
same content.

## Step 0 — Decide if APIck is the right tool (honestly)

| Your situation | Use |
|---|---|
| Non-technical editors + custom frontend + APIs/agents | **@apick/cms** — this guide |
| Developers are the only editors and the site is truly static | An SSG (Astro/11ty). A CMS is overhead you don't need |
| Backend/API only — apps and agents are the consumers, no website | **@apick/core** alone |
| Not content-shaped (a game, a realtime canvas, a dashboard over foreign data) | Neither — don't force a CMS shape onto it |

The deciding question is almost always: *does someone who can't open a pull
request need to change the content?* If yes, keep reading.

## Step 1 — Zero to running (about a minute)

```bash
npx --package=@apick/cms apick-cms init my-site
cd my-site && npm install && npm start
```

Open `http://localhost:3000/admin` — the first visit creates your admin
account. The site is at `/`, the API at `/v1`, MCP at `/mcp`. There is no
Docker and no database to install: dev runs embedded Postgres (PGlite) in
`.apick-data/`; production is any Postgres ≥ 14 via `APICK_DATABASE_URL`.

The scaffold's layout is the contract — the framework lives in node_modules
(never touched), YOUR site is four small directories:

```
my-site/
  server.js        wiring — yours, small
  collections/     your content types      ← most of your thinking goes here
  theme/           your theme
  plugins/         your routes/jobs/crons
```

## Step 2 — Model the content as code

Content types are code, deliberately (schema drift and runtime DDL are how
other CMSes lose data — see ADR 0003). Before writing any, name your types on
paper. glopo.info needed five, and this pattern covers most real sites:

- **pages** — the prose (one collection for ALL of it, with a `section` enum
  and a nested `path`, not one collection per site area)
- **resources** — typed attachments (video/pdf/link cards) that point AT a page
- **cases** — structured entities with filterable facets
- **activities**, **glossary-terms** — more of the same shapes
- **redirects** — yes, as content: editors fix old URLs without a deploy

Rules that pay off later:

1. **Give every collection exactly one `unique` field** (`path`, `slug`,
   `from`…). It becomes the upsert key for the content pipeline (step 5) and
   the human key other files use to reference the doc.
2. **Point relations from the attachment to the owner** (`resource.page →
   site-pages`), not the other way. The admin's related-content panels are
   generated from this direction — open a page and see/reorder/edit everything
   attached to it.
3. **`private` for secrets** (structurally unreadable via any API), `indexed`
   only on fields you filter by constantly, `renamedFields` when you rename
   (lossless — never drop/recreate).

```js
// collections/pages.js — the load-bearing pattern from glopo.info
import { defineCollection, f } from '@apick/cms';

export const pages = defineCollection('site-pages', {
  description: 'Every prose page, on one spine',
  access: { publicRead: true },
  admin: { label: 'Site pages', icon: '📄', titleField: 'title', orderField: 'order' },
  fields: {
    title: f.text({ required: true }),
    path: f.text({ required: true, unique: true, indexed: true, pattern: '^[a-z0-9-]+(?:/[a-z0-9-]+)*$' }),
    section: f.enum(['start', 'core', 'studies'], { required: true }),
    summary: f.text({ maxLength: 300 }),
    body: f.markdown({ required: true }),
    order: f.integer({ default: 0 }),
  },
});
```

## Step 3 — Make the admin feel made-for-them

The `admin` hints above are all it takes: `label` + `icon` name the sidebar
entry, `titleField` names documents everywhere (listings, pickers, panels),
`orderField` enables drag-reordering in related-content panels. Restart and
open `/admin`: listings (full-text search, status filters, bulk actions),
a schema-driven editor for every field type, relation pickers, version
history, ⌘K palette and the read-only Schema inspector are all generated —
you write none of it.

## Step 4 — Theme

Two honest options:

- **Child theme** (most sites): keep the built-in "barebones" black-&-white
  theme and override what you want — `theme/index.js` exports
  `{ css, templates: { home: … }, blocks: { … } }`, merged over the default.
- **Full custom + your own routes** (glopo.info): when the URL scheme IS the
  product (`/core/sovereignty`, `/studies/rights-justice/debates`), take over
  routing with a plugin and render with your own templates:

```js
// plugins/site.js — the pattern; register routes, read via the anonymous API
export const sitePlugin = {
  name: 'site',
  routes(hono) {
    const api = async (path) => {
      const res = await hono.fetch(new Request(`http://site.internal${path}`));
      return res.ok ? res.json() : null;
    };
    hono.get('*', async (c) => {
      const path = new URL(c.req.url).pathname.replace(/^\//, '');
      const page = (await api(`/v1/collections/site-pages/docs?filter=${encodeURIComponent(JSON.stringify({ path: { $eq: path } }))}`))?.data?.[0];
      // render page with your own html`` templates, else themed 404 …
    });
  },
};
```

The site reads through the **anonymous in-process API** — it can only ever
show what an anonymous caller could fetch (published + publicRead). No
privileged side door to leak drafts through. Server-side search is one call
away (`/v1/search?q=…`), redirects are a lookup in your redirects collection,
markdown renders safely by default with `md()`.

## Step 5 — Content as files (the pipeline)

Author or migrate content as files, then push idempotently:

```
content/
  site-pages/sovereignty.md      ← frontmatter = fields, body = the markdown field
  cases.json                     ← flat collections as JSON arrays
```

```markdown
---
title: Sovereignty
path: core/sovereignty
section: core
order: 30
publish: true
---
## What is sovereignty?
…
```

```bash
# stop the dev server first — dev's embedded PGlite is single-process
# (against real Postgres this doesn't apply)
npx apick content check ./content --app ./collections/index.js   # validate, no writes
npx apick content push  ./content --app ./collections/index.js   # create/update/publish
```

(`npx apick` resolves the project-local bin that @apick/cms brings along;
outside a project use `npx --package=@apick/core apick …`.)

Push is safe to re-run forever: unchanged docs are untouched, changed docs get
a new draft version and republish, and **nothing is ever auto-unpublished** —
editors' decisions in the admin always win. Relations reference other files by
their human key (`page: core/sovereignty`), resolved at push time.

Migrating someone's real writing? Two glopo.info rules worth stealing: split
mechanically and keep their prose **verbatim** (editing is a separate,
human pass), and run a **rights filter** before anything ships (glopo's
seeder greps every file for third-party-content fingerprints and fails the
push — cheap insurance that caught real problems).

## Step 6 — The editorial loop

- **Preview before publish**: map documents to their pages once —
  ```js
  await createCms({ preview: { pathFor: (col, doc) => col === 'site-pages' ? `/${doc.data.path}` : null } });
  ```
  The editor's Preview button now renders the *draft* through your real theme
  on a 30-minute signed URL (banner + noindex).
- **Schedule**: Publish ▾ → Schedule… publishes at a future time,
  cluster-single-fire. Cancel any time.
- **Roles**: admin / editor (content only, structurally can't touch users) /
  viewer. Scripted first admin (once, then never again — 403 after):
  ```bash
  curl -X POST localhost:3000/admin/api/setup -H 'content-type: application/json' \
    -d '{"email":"you@example.com","name":"You","password":"min-ten-chars"}'
  ```
- **Agents are editors too**: mint a scoped key in Settings → API keys and
  point any MCP client at `/mcp` — same content, same permissions, same audit
  trail. Hand the LLM `https://cdn.jsdelivr.net/npm/@apick/cms/llms-full.txt`
  and it knows the whole contract.

## Step 7 — Ship it

```bash
APICK_DATABASE_URL=postgres://…:5432/db \   # any Postgres; SESSION-mode pooler if pooled
APICK_DATABASE_SCHEMA=apick_my_site \        # sharing a DB? own schema, created automatically
APICK_CMS_SECRET=<long random> \             # stable across replicas/restarts
APICK_ROOT_KEY=<long random> \               # pinned root key (rotatable: apick key rotate-root)
node server.js
```

- The scaffold's `app.listen(process.env.PORT ? undefined : 3000)` gives you
  port 3000 in dev and, when a PaaS injects `PORT`, the no-args behavior —
  honor `PORT`, bind `0.0.0.0` — so DigitalOcean/Railway/Fly/Render need zero
  extra config. Point the platform's health check at `/health`.
- **Shared database?** `APICK_DATABASE_SCHEMA` puts every apick table in its
  own schema — existing tables untouched, several APIck apps per database, and
  on Supabase the non-exposed schema is invisible to PostgREST.
- Migrations: `migrate: 'apply'` at boot for a single-app install, or
  `apick migrate --database $URL` as a deploy step.
- Seed production with the same push against the prod **database**:
  `npx apick content push ./content --app ./collections/index.js
  --database postgres://… [--schema apick_my_site]` — same files, same
  idempotency.

## Step 8 — Keep it healthy (compose the primitives)

The platform's jobs + cron + collections compose into operational features in
~100 lines. glopo.info's weekly link-checker is the template: a cron enqueues
a durable job → the job checks every resource URL → writes one "Link report"
document editors see in the admin. Its first production run found three
privately-shared decks that had been silently invisible to students for
months. Webhooks (signed, retried, replayable) and the `/v1/events` audit
trail are already on.

## What "done" looks like

- [ ] Editors add/edit/publish without a developer (watch them do it)
- [ ] Every old URL 301s (redirects are content)
- [ ] Search returns hits from inside the real content
- [ ] Preview → schedule → publish round-trips through the real theme
- [ ] `apick content push` is a no-op right after itself (idempotent)
- [ ] Deployed with its own schema, health-checked, root key stored
- [ ] Something watches the content's health (link-check pattern)

---

## Appendix — Is APIck worth it, or should you build from scratch?

The honest version, measured on glopo.info (built end-to-end by an AI agent):

**The numbers.** The whole site is **~2,150 lines of app code** (collections,
custom theme, routes, seeder) plus 90 content files — riding on **~16,700
lines of platform** that ship with 136 black-box + 21 real-browser tests.
From scratch, the app-code number triples and the platform number becomes
yours to write, test, and patch: auth/sessions, RBAC, draft/publish state
machine, versioning, admin UI, media, replica-safe cron, signed webhooks,
MCP. Those are exactly the subsystems where "it seems to work" hides the
expensive bugs.

**Why it's *more* worth it with an AI agent, not less.** An agent writes code
fast — including fast wrong code in security-sensitive places. APIck's value
to an agent is structural: authorization lives in the query planner, so a
generated route *cannot* leak a private field; reads are bounded, so a
generated query *cannot* be pathological; the site renders through the
anonymous API, so drafts *cannot* leak through a template. Rails matter most
at high speed. And when the agent hits a genuine platform gap, the fix lands
in APIck once (this build produced list-membership filtering, schema
isolation, draft preview, scheduling, `/v1/search`, the content CLI — three
releases in two days) — every next site starts where the last one ended.
From-scratch pays those costs again per project.

**Where from-scratch (or an SSG) genuinely wins.** Developer-only editing on
a truly static site — skip the server entirely. Non-content-shaped apps —
don't bend a CMS into a game engine. Ultra-custom editorial workflows beyond
draft→schedule→publish — you'd fight the grain. And know the real risks:
APIck is 0.x with one production site and a small maintainer surface. The
mitigations are structural rather than promised: the black-box suite is an
executable spec, export is lossless (`/v1/export`, `apick content pull`,
plain-SQL escape hatch), and your app code is a thin, portable layer.

**Verdict.** For a content site with a non-developer editor, an API surface,
or agents in the loop: use APIck — the glopo build went brief-to-deployed in
about two days *including* building three platform features, and rebuilding
it bespoke would have spent that time re-implementing table stakes instead.
For anything else, be honest at Step 0 and pick the smaller tool.
