# Multi-tenancy

APIck is multi-tenant native: one install serves N tenants, and the tenant is a
first-class scope threaded through the data model and the query planner from
day one. Isolation is **structural** — a `tenant_id` predicate the planner
compiles into every query and populate hop — not a filter someone can forget.

Single-tenant apps: do nothing. Install bootstrap creates a `default` tenant
and every request lands there. You'll never see tenancy until you want it.

## Scopes

```
operator (control plane, one per install)
└── tenants: default, acme, globex, …
```

- **Operator** provisions/suspends tenants, holds cross-tenant visibility, and
  is a *scope in the same RBAC model* — an operator-scope role grant
  (`tenant_id = null`), not a second auth system.
- **Tenant** grants apply within exactly one tenant. A tenant key presenting a
  different tenant's header gets `401/403` — its grants simply don't apply there.

## Resolving the tenant

Priority per request:

1. `x-apick-tenant: <slug-or-id>` header
2. your `resolveTenant(request)` hook — e.g. map `Host:` subdomains:

```ts
await createApp({
  resolveTenant: (req) => new URL(req.url).hostname.split('.')[0] ?? null,
});
```

3. the install's default tenant.

Custom-domain TLS and routing are the deployer's job (Caddy on-demand TLS,
Cloudflare for SaaS, your platform). APIck only needs to learn the tenant from
the request.

## Operating tenants

```bash
POST  /v1/tenants           { "slug": "acme", "name": "Acme Corp" }     # operator
PATCH /v1/tenants/acme      { "status": "suspended" }                    # turns the tenant off (403s)
GET   /v1/tenants                                                        # operator

# then create the tenant's own admin key:
POST /v1/keys  (header x-apick-tenant: acme)  { "role": "tenant-admin", "name": "acme admin" }
```

Everything a tenant does — documents, uniques, webhooks, deliveries, events,
jobs, crons — is scoped to it. Unique values are independent per tenant.
Operator keys act on any tenant by setting the header.

## Isolation guarantees (tested)

- Cross-tenant list/get/filter probes return empty/404 — including filter-based
  existence probes (`tenant-isolation.test.ts`).
- Webhooks fire only for their tenant's events; event-log reads are scoped.
- v1 is row-level isolation on shared tables. Schema-per-tenant/db-per-tenant
  (stronger isolation, data residency) is a planned post-v1 backend option —
  the scoping seam is already in one place (the planner).
