# MCP — agents as first-class users

Every APIck app is an MCP server: stateless streamable HTTP at `/mcp`,
speaking protocol versions 2024-11-05 through 2025-06-18. Point any MCP client
(Claude Code, Claude Desktop, the SDK) at it:

```json
{
  "mcpServers": {
    "my-apick-app": {
      "type": "http",
      "url": "https://api.example.com/mcp",
      "headers": { "Authorization": "Bearer <api key>", "x-apick-tenant": "acme" }
    }
  }
}
```

## Tools

Schema-derived, so they're always in sync with the code:

| Tool | Purpose |
|---|---|
| `list_collections` | discover collections + their read/write JSON Schemas (call first) |
| `list_documents` | filter/sort/paginate/populate — full query grammar |
| `get_document` / `create_document` / `update_document` / `delete_document` | CRUD (update = merge patch, supports `ifVersion`) |
| `publish_document` / `unpublish_document` | the publish pointer |
| `list_versions` / `get_version` / `restore_version` | history & rollback |
| `query_<key>` | one tool per saved query, with typed params |

## Security model (identical to REST — by construction)

MCP calls resolve the same access context and flow through the same planner and
store as HTTP:

- **Least privilege** — a `content-reader` key gets a tool *error* on
  `create_document`; a private-field filter probe is rejected exactly like REST.
  Mint narrowly-scoped keys for agents (`POST /v1/keys {"role": "...", "name": "my-agent"}`),
  optionally with `expiresAt`.
- **Attribution** — every mutation lands in the event log with
  `actor: { principalId, via: "mcp", keyId }`; every tool call is recorded as an
  `mcp.call` interaction event (tool, outcome, latency, arg keys — argument
  *values* are not logged).
- **Bounded** — the same plan-time caps apply; an agent cannot construct a
  pathological query.

## Design notes

- Stateless: each POST is independent; no sessions, no SSE stream. This keeps
  N-replica deployments trivial (any replica can answer any call).
- Tool errors return `isError: true` with the standard APIck error envelope in
  the content — agents can read the `code` and self-correct.
- Give agents `/llms-full.txt` as context for the filter grammar and field
  semantics; it is generated from the live schema.
