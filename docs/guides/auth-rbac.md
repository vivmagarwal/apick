# Auth & RBAC

One model for everything. A request resolves to an **access context**: a
principal (or anonymous), the **scope** it acts in (operator, or one tenant),
and its effective permission rules. There is no separate admin auth system —
avoiding the two-parallel-auth-systems trap is a founding decision.

## API keys

- `Authorization: Bearer <key>`. Keys are stored as SHA-256 hashes; the token is
  shown exactly once at creation.
- First boot creates the **root** principal (operator scope) and one key,
  returned as `app.rootKey` / printed once. Pass `rootKey: '…'` (or keep it in
  your secret manager) for reproducible environments.

Create scoped keys over HTTP (requires `manage system:keys`):

```bash
# safe path: creates a service principal + grants a role in the CURRENT tenant
POST /v1/keys   { "role": "content-editor", "name": "CI publisher" }
# → { "token": "apick_…", "id": "…", "principalId": "…" }   token shown once

# operator-only: key for an existing principal
POST /v1/keys   { "principalId": "…" }
```

Revoke: `DELETE /v1/keys/:id`. Expiry: pass `expiresAt`. Tenant admins can only
mint keys via the role-path (never for arbitrary existing principals) and only
revoke keys fully inside their tenant — privilege escalation is structurally
blocked.

## Built-in roles

| Role | Grants |
|---|---|
| `operator-admin` | everything, everywhere (`*` on `*`) — the root key's role |
| `tenant-admin` | all doc actions + manage keys/roles/webhooks/events/jobs/principals/export within the tenant |
| `content-editor` | read, readDraft, create, update, delete, publish on all collections |
| `content-reader` | read (published) on all collections |
| `public` | what anonymous callers get — empty by default; `access: { publicRead: true }` on a collection adds published-read |

Doc actions: `read` (published), `readDraft` (drafts, versions), `create`,
`update`, `delete`, `publish`. System resources: `system:tenants` (operator
only), `system:keys`, `system:roles`, `system:webhooks`, `system:events`,
`system:jobs`, `system:principals`, `system:export`.

## Custom roles

```bash
POST /v1/roles
{
  "key": "support",
  "name": "Support agent",
  "permissions": [
    { "action": "read", "resource": "doc:tickets", "fields": ["subject", "status"] },
    { "action": "update", "resource": "doc:tickets",
      "condition": { "assignee": { "$eq": "$me" } } }
  ]
}
POST /v1/grants  { "principalId": "…", "roleKey": "support" }
```

- **`fields`** — a read whitelist. Enforced by the planner: fields outside it
  are unprojectable AND unfilterable/unsortable (rejected like unknown fields).
- **`condition`** — a row filter (same JSON grammar as queries) AND-ed into
  every read the role performs. `"$me"` substitutes the caller's principal id.
  Non-matching documents are invisible (404), not forbidden.
- Rules are **additive** (union across roles + the public baseline). There are
  no deny rules; on a `publicRead` collection no role can see less than
  anonymous. Restrictions are meaningful on non-public collections.

## Anonymous access

No token → the `public` role in the resolved tenant. Introspection
(`/v1/collections`), reads, saved queries and MCP all honor it. Everything else
is `401`.

## Private fields vs field whitelists

`private: true` is schema-level and absolute: no role, not even
`operator-admin`, can read or filter it over any API (it's for secrets — the
value only exists for your server-side code and raw SQL). Whitelists are
role-level restrictions among the non-private fields.
