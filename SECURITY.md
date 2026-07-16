# Security policy

## Reporting a vulnerability

Please email **vivmagarwal@gmail.com** with the subject line `[apick security]`.
Do not open a public issue for anything exploitable. You will get an
acknowledgement within 72 hours and a fix or mitigation plan within 14 days
for confirmed issues. Credit is given in the release notes unless you prefer
otherwise.

## Scope

APIck's security model makes specific, tested guarantees — reports that break
any of these are always in scope:

- `private: true` fields must never be readable, filterable, sortable or
  populatable through REST or MCP (no boolean-oracle side channels).
- Tenant isolation: no request authenticated in tenant A may read or write
  tenant B's rows through any endpoint.
- RBAC: no path may bypass the query planner's field whitelists or row
  conditions; tenant admins must not be able to escalate to operator scope.
- Webhook deliveries must not be usable as an SSRF proxy into private networks
  when `allowPrivateTargets` is false.
- API keys are stored only as SHA-256 hashes; webhook payload signatures must
  not be forgeable or replayable outside the timestamp tolerance.
- Bounded reads: no request may construct unbounded database work.

## Hardening notes for deployers

- Run behind TLS (your proxy's job) and keep the root key in a secret manager.
- Key revocation propagates to other replicas within `authCacheTtlMs`
  (default 5s); set it to 0 to disable caching entirely.
- Rate limiting is deliberately left to your proxy/edge.
