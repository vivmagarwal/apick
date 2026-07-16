import type { AppCore } from '../app/core.js';
import type { FieldDef } from '../schema/fields.js';

/**
 * llms.txt / llms-full.txt — generated from the live registry so the guide an
 * agent reads is always the schema the server enforces.
 */

export function buildLlmsTxt(core: AppCore): string {
  const collections = core.registry.list().map((c) => `- ${c.key}${c.description ? `: ${c.description}` : ''}`).join('\n');
  return `# APIck

> APIck (API Construction Kit) is a pure-headless, AI-first application platform: code-defined content
> collections with validation, RBAC enforced in the query planner, versioned documents with pointer-publish,
> reliable signed webhooks, durable background jobs, and a first-class MCP server. No admin UI: agents and
> apps drive everything through the API and MCP.

## Start here

- /llms-full.txt : the complete API guide (auth, tenancy, endpoints, filter grammar, webhooks, MCP)
- /openapi.json : OpenAPI 3.1 with exact request/response schemas for every collection
- /mcp : MCP endpoint (streamable HTTP). Authorization: Bearer <api key>

## Auth in one line

Send \`Authorization: Bearer <api key>\`. Optional \`x-apick-tenant: <slug>\` selects the tenant (defaults to "${core.config.defaultTenantSlug}").

## Collections on this server

${collections || '- (none defined yet)'}
`;
}

function fieldLine(name: string, def: FieldDef, indent: string): string[] {
  const attrs: string[] = [def.type];
  if (def.type === 'relation') attrs.push(`-> ${def.to}${def.many ? '[]' : ''}`);
  if (def.type === 'enum') attrs.push(`values: ${(def.values ?? []).join('|')}`);
  if (def.required) attrs.push('required');
  if (def.unique) attrs.push('unique');
  if (def.private) attrs.push('PRIVATE (never readable/filterable via API)');
  if (def.immutable) attrs.push('immutable');
  if (def.default !== undefined) attrs.push(`default: ${JSON.stringify(def.default)}`);
  const lines = [`${indent}- ${name}: ${attrs.join(', ')}${def.description ? ` — ${def.description}` : ''}`];
  if (def.type === 'object' && def.fields) {
    for (const [k, v] of Object.entries(def.fields)) lines.push(...fieldLine(k, v, indent + '  '));
  }
  if (def.type === 'list' && def.of) {
    lines.push(...fieldLine('(items)', def.of, indent + '  '));
  }
  if (def.type === 'blocks' && def.variants) {
    for (const [variant, shape] of Object.entries(def.variants)) {
      lines.push(`${indent}  - block "${variant}":`);
      for (const [k, v] of Object.entries(shape)) lines.push(...fieldLine(k, v, indent + '    '));
    }
  }
  return lines;
}

export function buildLlmsFullTxt(core: AppCore): string {
  const sections: string[] = [];

  sections.push(`# APIck — full API guide

APIck is a pure-headless, AI-first application platform. Everything is done via REST (this guide),
MCP (/mcp), or webhooks. There is no admin UI by design.

## Authentication & tenancy

- Every request may send \`Authorization: Bearer <api key>\`. Without a key you are the anonymous
  principal (only collections with public read are visible).
- Multi-tenant: send \`x-apick-tenant: <slug-or-id>\` to select a tenant. Without it, requests act on
  the default tenant ("${core.config.defaultTenantSlug}"). Tenant isolation is structural — enforced in
  the query planner, not a filter.
- Errors are always \`{ "error": { "code", "message", "details" } }\` with a matching HTTP status.
  Codes: bad_request(400), plan_rejected(400), unauthorized(401), forbidden(403), not_found(404),
  conflict(409), validation(422), internal(500).

## Document model

- A document = (docId uuid, locale, version). Writes create a new version (append-only history).
- Drafts and published are two heads of the SAME document. Publishing moves a pointer — it never
  copies the document. \`GET ...?status=draft\` reads the draft head (needs readDraft permission);
  default reads are published.
- Writes are RFC 7386 merge patches: send only changed keys; \`null\` removes a key; arrays replace.
- Optimistic concurrency: pass \`ifVersion\` in PATCH bodies to reject concurrent edits (409).
- History: \`GET .../versions\`, \`GET .../versions/{n}\`, \`POST .../versions/{n}/restore\`.

## Reading

\`GET /v1/collections/{collection}/docs?filter=...&sort=-createdAt&page=1&pageSize=25&populate=rel1&fields=a,b&count=true\`

- filter is JSON. Operators: $eq $ne $gt $gte $lt $lte $in $nin $contains $icontains $startsWith
  $endsWith $null; combinators $and $or $not. Shorthand: {"title":"x"} means $eq.
  Example: filter={"$or":[{"views":{"$gt":100}},{"title":{"$startsWith":"Hello"}}]}
- Only fields that exist in the schema AND that you may read are accepted in filter/sort/populate —
  anything else is rejected at plan time (400 plan_rejected). Private fields are invisible: they can
  never be read, filtered, sorted or populated.
- populate=relationField returns related documents under "populated", rendered under the TARGET
  collection's permissions. One hop, bounded.
- Reads are bounded: pageSize <= 100, filter <= 50 nodes, sort <= 3 keys, populate <= 8 relations.

## Writing

- Create: \`POST /v1/collections/{c}/docs\` body \`{"data": {...}, "publish": true|false, "locale": "..."}\`
- Update: \`PATCH /v1/collections/{c}/docs/{docId}\` body \`{"patch": {...}, "ifVersion": n}\`
- Publish/unpublish: \`POST .../docs/{docId}/publish\` | \`/unpublish\`; schedule with body \`{"at":"<iso>"}\`, cancel via \`DELETE .../publish-schedule\`
- Search: \`GET .../docs?search=<websearch query>\` (ranked FTS) and \`GET /v1/search?q=...&collections=a,b\` across collections
- Delete: \`DELETE .../docs/{docId}\` (all locales) or \`?locale=xx\` (one variant)
- Relations are docId strings (to-one) or arrays of docId strings (to-many); targets must exist.

## System endpoints (permission-gated)

- \`GET/POST /v1/tenants\`, \`PATCH /v1/tenants/{ref}\` — operator only
- \`POST /v1/keys\` {role, name} creates a scoped service key; {principalId} operator-only. \`GET /v1/keys\`, \`DELETE /v1/keys/{id}\`
- \`GET/POST /v1/roles\` — custom roles: permissions [{action, resource, fields?, condition?}];
  condition is a filter AST, "$me" = caller's principal id (e.g. own-documents policies)
- \`POST /v1/grants\` {principalId, roleKey}
- \`GET/POST/PATCH/DELETE /v1/webhooks\`, \`GET /v1/webhooks/{id}/deliveries\`, \`POST /v1/deliveries/{id}/replay\`
- \`GET /v1/events?types=doc.*&afterSeq=cursor\` — the audit/event log (poll it as a change feed)
- \`GET /v1/jobs?state=dead\`, \`POST /v1/jobs/{id}/replay\` — job dead-letter
- \`GET /v1/export\`, \`POST /v1/import\` — lossless data portability

## Webhooks

Payloads are signed: header \`apick-signature: t=<ms>,v1=<hmacSHA256(secret, t + "." + body)>\`.
Verify with a constant-time compare and a timestamp tolerance. Delivery is at-least-once with
exponential backoff and a dead-letter + replay; use \`apick-delivery-id\` for idempotency.
Subscribe with patterns: "*", "doc.*", "doc.published", "doc.published:articles".

## MCP

POST /mcp (streamable HTTP, stateless) with \`Authorization: Bearer <api key>\`. Tools: list_collections,
list_documents, get_document, create_document, update_document, delete_document, publish_document,
unpublish_document, list_versions, restore_version, plus one query_<key> tool per saved query.
Every mutation is attributed to the key's principal in the event log.`);

  sections.push(`## Collections & fields on this server`);
  for (const col of core.registry.list()) {
    const lines: string[] = [`### ${col.key}${col.description ? ` — ${col.description}` : ''}`];
    if (col.access.publicRead) lines.push(`(public read enabled: anonymous callers can read published documents)`);
    for (const [name, def] of Object.entries(col.compiled.fields)) lines.push(...fieldLine(name, def, ''));
    sections.push(lines.join('\n'));
  }

  if (core.queries.size > 0) {
    const lines: string[] = ['## Saved queries', ''];
    for (const q of core.queries.values()) {
      const params = Object.entries(q.params ?? {})
        .map(([n, s]) => `${n}: ${s.type}${s.required ? ' (required)' : ''}`)
        .join(', ');
      lines.push(`- GET /v1/queries/${q.key} — ${q.description ?? `query on ${q.collection}`}${params ? ` (params: ${params})` : ''}`);
    }
    sections.push(lines.join('\n'));
  }

  return sections.join('\n\n') + '\n';
}
