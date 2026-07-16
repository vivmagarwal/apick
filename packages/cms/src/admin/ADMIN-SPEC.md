# APIck Admin v2 — build spec

The authoring experience that makes people love APIck: Strapi's best patterns,
executed cleaner, on a document-centric model. React 18 + TypeScript +
Tailwind v4 + shadcn-style components (hand-rolled on Radix primitives —
no shadcn CLI). Everything the SPA does goes through the public API — it is a
reference client with zero privileged access.

## Sources of truth (read these)

- `src/admin/ui-legacy/` — the OLD working admin (deleted after the rebuild
  shipped; recover it from git history). It documented every API endpoint, the
  edodo-write integration (`flush.ts` — the no-keystroke-loss registry — ported
  exactly), slug autogen, autosave, the media picker, blocks editing.
- The Strapi UX study: `/private/tmp/claude-501/-Users-vivmagarwal-Work-opensource-apick/781eff13-5a73-46ce-8209-e2e2afe4798d/tasks/ww0xwkl0x.output`
  — the interaction inventory to match/beat (status chips, relation UX,
  keyboard shortcuts, unsaved guards…).
- API surface: `/admin/api/*` (status, setup, login, me, preview, users CRUD),
  `/v1/collections` (+ `admin` hints), `/v1/collections/:key/schema`
  (+ `admin`, `referencedBy`, `fields` when writable), `/v1/collections/:c/docs`
  CRUD + `?search=` + publish (`{at}` schedules) + `/publish-schedule` DELETE +
  versions, `/v1/search?q=`, `/v1/keys`, `/v1/webhooks(+deliveries,replay)`,
  media endpoints (see ui-legacy/media.ts + src/media/routes.ts).

## Stack rules

- Files live in `src/admin/ui/`. Entry `main.tsx`. Tailwind theme in `app.css`
  (Tailwind v4 `@import "tailwindcss"; @theme {…}` syntax).
- Router: `wouter` with `/admin` base. Data: `@tanstack/react-query`
  (staleTime 5s; invalidate on mutation). Toasts: `sonner`. Icons:
  `lucide-react`. Command palette: `cmdk`.
- shadcn-style primitives in `components/ui/`: button, input, textarea, label,
  select (radix), dialog (radix), sheet (radix dialog side variant),
  dropdown-menu (radix), popover (radix), tooltip (radix), tabs (radix),
  switch (radix), badge, card, table, skeleton, command (cmdk), separator.
  Variants via `class-variance-authority`; `cn()` = clsx + tailwind-merge.
- Design: zinc neutral scale, white surfaces / zinc-950 dark (respect
  `prefers-color-scheme`), 1 accent = zinc-900 buttons (shadcn "default"
  look), status colors: draft=blue, modified=amber, published=green,
  scheduled=violet. Density comfortable, radius 8px, `Inter, system-ui`.
- TypeScript strict; `src/admin/ui/tsconfig.json` mirrors ui-legacy's but with
  `"jsx": "react-jsx"`, `"types": []`, DOM libs.

## Information architecture

- Shell: left sidebar — wordmark "APIck · <site title>" (from /admin/api/status),
  CONTENT group (one entry per collection from /v1/collections: `admin.icon`
  emoji + `admin.label ?? key`, sorted as returned; hide `cms-users`),
  Media entry; SYSTEM group: Users, API keys, Webhooks, Schema; footer:
  View site ↗, user name, Sign out. Topbar: breadcrumb-ish page title +
  global ⌘K search button.
- Routes: `/admin` dashboard · `/admin/c/:key` listing · `/admin/c/:key/new` +
  `/admin/c/:key/:docId` editor · `/admin/media` · `/admin/users` ·
  `/admin/keys` · `/admin/webhooks` · `/admin/schema` + `/admin/schema/:key` ·
  `/admin/login`, `/admin/setup` (fullscreen, no shell).
- Auth: token in localStorage (`apick-admin-token`, same as legacy); 401 →
  login. /admin/api/status.needsSetup → setup screen.

## The views

**Dashboard** — count cards per collection (label + icon, links), recent
activity (last 10 events via `/v1/events?pageSize=10` — render type + collection
+ relative time), quick links (Media, Schema).

**Listing** (`/admin/c/:key`) — search input that queries `?search=` (FTS,
300ms debounce; falls back to title `$icontains` if FTS 400s), status filter
(All/Draft/Modified/Published/Scheduled — client-side on publishedVersion/
scheduledPublishAt/updated), sortable columns (auto: titleField + next 2
presentable scalars + status pill + updated), pagination (25/page), row click
→ editor, checkbox multi-select → bulk bar (Publish, Unpublish, Delete — with
confirm dialog; parallel API calls + one summary toast), "+ New" button.
Status pill component shared everywhere: draft(blue)/modified(amber)/
published(green)/scheduled(violet, with tooltip showing when).

**Editor** (`/admin/c/:key/:docId|new`) — the centerpiece.
- Header: back link, title = titleField value (or "Untitled"), status pill,
  actions: Preview (if POST /admin/api/preview returns a url — open in new
  tab), Save draft, Publish split-button (Publish now / Schedule… opens a
  datetime dialog → publish with `{at}`; when scheduled shows "Scheduled
  <date>" + Cancel schedule), ⋯ menu (Unpublish, Delete, Copy docId, Copy
  API URL, metadata: created/updated/published relative times + docId).
- Form: schema-driven from `fields` (writeSchema introspection like
  ui-legacy/fields.ts): text/textarea by maxLength, markdown → edodo-write
  (port flush registry + image upload paste), email/uri/slug (slug: autogen
  from title until manually edited + Regenerate button), integer/number,
  boolean switch, datetime/date pickers, enum select, json (textarea +
  validity check), list-of-scalars (tag input / add-remove rows),
  object (fieldset), blocks (variant cards: add menu, drag reorder via
  HTML5 dnd, collapse, delete), image (f.image: url input + Media picker
  dialog + thumbnail preview), relation/relations → RelationPicker.
- Validation errors from 422 map to fields inline (details path best-effort)
  + toast. Unsaved-changes route guard + beforeunload. Autosave drafts (2s
  debounce, like legacy) with "Saved · just now" indicator; ⌘S save,
  ⌘⇧Enter publish.
- **RelationPicker** (to-one + to-many): combobox popover, 300ms debounced
  `?search=` (fallback title $icontains) against the TARGET collection,
  options show target titleField + status pill; selected shown as chips (one)
  or reorderable rows (many, drag to reorder writes array order); X removes;
  "Create new ↗" opens the editor in a Sheet (drawer) with the created doc
  auto-connected on save.
- **Related content panels** (THE differentiator, from `referencedBy`): under
  the form, one panel per inverse relation: "<Their label> — <count>"
  listing docs where `field == this docId` (sorted by their admin.orderField
  else updatedAt), each row: titleField + status pill + drag handle (when
  orderField: drag persists by PATCHing evenly spaced order values 10,20,30…)
  + Edit (opens THAT doc's full schema-driven form in a Sheet — save/publish
  inside, list refreshes) + unlink (sets relation null with confirm) ·
  "+ Add <label>" button opens a Sheet on a NEW doc of that collection with
  the relation field pre-filled to this doc. Hidden on unsaved new docs.
- The Sheet editor reuses the same DocumentForm component as the main editor
  (one component, two containers).

**Media** — grid of uploads (thumbnails for images, icon tiles otherwise),
upload button + drag-drop zone, search by filename, click → detail Sheet
(preview, alt text edit, copy URL, delete). MediaPicker dialog variant reused
by image fields (pick → returns `/media/:id/:filename` URL). Endpoints: see
ui-legacy/media.ts.

**Users / API keys / Webhooks** — port legacy pages to the new components
(tables + create dialogs). Keys: show-once token dialog. Webhooks: list +
create + recent deliveries with replay button.

**Schema** (`/admin/schema`, `/admin/schema/:key`) — read-only inspector:
per collection: description, admin hints, fields table (name, type badge,
flags: required/unique/private/indexed/immutable, enum values, default,
description), relations in/out (linking to other schema pages), plus the
line: "Content types are code — collections/<key>.js in your project."

**⌘K command palette** — sections: collections (jump), "Search content…"
(queries /v1/search across collections, shows hits with collection label +
title, enter → editor), actions (New <collection>…, Media, Schema).

## Quality bar

- Every list/fetch has skeleton loading + empty state (friendly, with a CTA).
- Errors: toast + inline where field-mappable; never swallow.
- Keyboard: ⌘K palette, ⌘S save, Esc closes sheets/dialogs.
- No `any` unless unavoidable; build must pass `tsc --noEmit` strict and
  esbuild bundle.
- a11y: labels on inputs, focus-visible rings, Radix handles the rest.

## Explicit non-goals (v1)

Locales UI, per-user column config, review workflows, relation modal
back-stack (Sheet depth 1 is fine), drag-drop file upload inside markdown
(edodo paste covers it).
