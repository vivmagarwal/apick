# ADR-0002: @apick/cms on top of @apick/core

Status: accepted · Date: 2026-07-16

## Naming & packaging

The npm scope is `@apick/*`. The library formerly published as `apick` is
`@apick/core` (v0.4.0 — supersedes the unrelated experimental 0.3.x kernel
previously on npm). The `apick` CLI bin name is unchanged.

## The revised UI decision

ADR-0001 settled "developers/agents only — no UI ships." That holds for
**core, permanently**. What changed: the UI ships as a *separate product*,
`@apick/cms` — a WordPress/Drupal-class CMS built entirely on core's public
surface. This was option (b) of the original open decision, now taken
deliberately:

- Core remains pure headless: zero CMS concepts leaked in (its test suite is
  the proof — nothing there knows about themes, sessions or admin screens).
- The admin SPA is a **pure REST consumer**: everything it does, an agent can
  do through `/v1` or `/mcp` with the same session token. The CMS is therefore
  a permanent, executable conformance test of the headless API.
- CMS users ride core's `auth.verifyToken` hook (the CMS is its own IdP:
  scrypt passwords, HMAC session tokens, password-change invalidation). One
  auth model, as promised.
- CMS roles (`cms-admin`/`cms-editor`/`cms-viewer`) are code-defined roles via
  core's `roles` config. The union-only model expresses "editors touch
  everything except cms-users" as explicit per-collection grants — closing the
  editor→admin escalation structurally.
- `passwordHash` is a `private` field: by the planner's guarantee it is
  unreachable through any API, for any role. Login verification is the one
  server-side db read, by design.

## Project layout: Drupal's conventions, npm's distribution

Drupal got the conventions right (clear "yours" vs "not yours" directories)
and the distribution wrong (framework files in the project tree ⇒ every
upgrade is a migration). `apick-cms init` scaffolds:

```
my-site/
  server.js        wiring (yours, ~20 lines)
  collections/     your content types
  theme/           your child theme
  plugins/         your plugins
```

with the framework only ever in `node_modules`. Directories aggregate via
explicit `index.js` re-exports — no magic filesystem scanning.

## Theming & plugins

A theme is CODE: template functions + block renderers + css, merged like
child themes (`mergeTheme(default, override)`); the `html` tag escapes by
default. A plugin is a composition unit over existing primitives
(collections, queries, jobs, crons, routes, admin nav, theme fragments) — no
override points into internals, per ADR-0001.

## v1 boundaries (explicit)

The CMS admin manages the **default tenant** (multi-tenant admin is post-v1;
core's multi-tenancy is unaffected). Markdown is sanitized on render by default (raw HTML dropped, URL protocols
allow-listed) at the server-side boundary — the non-bypassable one, since
content also arrives via the REST API and MCP; opt out with
`content: { sanitize: false }`. edodo-write independently sanitizes what it
renders in the editor. Admin SPA is bundled at
package build; consumers never run a frontend build.
