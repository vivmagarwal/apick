# ADR 0003 — The authoring experience (admin v2)

Date: 2026-07-16 · Status: accepted

## The UI question, answered

The founding notes ("no admin UI, ever") kept colliding with reality: editors,
operators and integrations all want a screen. Decision (option b from the
vision doc, now explicit): **core stays pure headless forever; the admin is a
separately-shipped reference UI in @apick/cms, built 100% on the public API.**
The admin authenticates as an ordinary principal and calls `/admin/api/*` +
`/v1` — everything it can do, an agent with the same token can do over REST or
MCP. No privileged side door, so the small-stable-extension-surface promise
holds, and human and LLM authoring are the *same* surface with two skins.

## The thesis: authors think in documents-on-pages, admins think in tables

Building glopo.info (the first production site) exposed the gap: the public
page composed a page document PLUS its related resource documents, but the
admin only showed the page — the resources lived in another collection with
no way to see, edit or reorder them *from the page*. Strapi has the same
weakness; Drupal solved it years ago (Inline Entity Form).

Core therefore grew **presentation-free authoring primitives** (0.8.0):

- `admin` hints on `defineCollection` — label, icon, titleField, orderField
  (pure data, carried through schema introspection; MCP clients see them too)
- **`referencedBy`** in `/v1/collections/:key/schema` — the inverse-relation
  map: who points at this collection, with which field
- **scheduled publishing** — `publish {at}` + cluster-single-fire sweep
- **`/v1/search`** — ranked Postgres FTS across collections, planner-scoped
  (+ the `search_content` MCP tool; the same search serves ?search= listings)
- **draft preview scope** — `runWithDraftPreview(docId, fn)`: inside the
  scope, ONE document's draft impersonates its published head across list and
  get reads — so any theme, including fully custom routes, renders a draft
  preview with zero theme changes (cms signs 30-min single-document tokens)

## Admin v2 (@apick/cms 0.3.0)

React 18 + TypeScript + Tailwind v4 + shadcn-style components, bundled at
package build (consumers never run a frontend build). Schema-driven
throughout; nothing collection-specific is hard-coded. Headliners:

- **Related-content panels** on every editor (from `referencedBy`): see,
  reorder (via orderField), edit-in-a-drawer, unlink, and create-prefilled —
  the "where are my embeds?" fix. Lineage: Drupal Inline Entity Form.
- Relation pickers with debounced search, status pills, create-in-place.
- Listing: cross-field + FTS search, status filters, bulk publish/delete.
- Publish split-button with **Schedule…**, preview links, version history,
  ⌘K command palette (jump anywhere, search content), schema inspector
  (read-only — content types stay code; a builder, if ever, writes files).
- edodo-write stays the markdown editor (flush registry preserved).

Site default theme replaced by **"barebones"** — minimal black & white
(zinc/Inter/hairlines), a clean sheet real sites extend or replace.

## What we deliberately did NOT copy from Strapi

Admin-editable content types (drift + runtime DDL), a separate admin auth
system (their admin-vs-users split), EE-gated history/audit, locale UI (v1),
and their plugin-riddled admin extension internals — CMS plugins may add nav
links and pages, not rewire the editor.

Credits: the Strapi reference corpus (UX study only — zero code), Drupal 7/8
module patterns (Views → saved queries; Redirect → redirects-as-content on
glopo; Inline Entity Form → related-content panels), WordPress's editorial
directness.
