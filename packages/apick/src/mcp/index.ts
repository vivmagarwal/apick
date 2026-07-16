import { Hono } from 'hono';
import { ApickError, errors } from '../kernel/errors.js';
import { appendEvent } from '../kernel/events.js';
import { assertCan, can, type AccessContext } from '../auth/rbac.js';
import { storeContextFor, type AppCore } from '../app/core.js';
import {
  createDoc,
  deleteDoc,
  getVersion,
  listVersions,
  patchDoc,
  publishDoc,
  restoreVersion,
  unpublishDoc,
} from '../content/store.js';
import { getDoc, listDocs } from '../query/plan.js';
import { executeSavedQuery } from '../query/saved.js';
import type { HonoEnv } from '../http/app.js';

/**
 * First-class MCP: a stateless streamable-HTTP endpoint at /mcp. Tools are
 * generated from the same compiled schemas as REST and go through the SAME
 * access context, planner and store — least-privilege by construction, and
 * every mutation lands in the event log attributed to the key's principal
 * with via: "mcp".
 */

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const COMMON_PROPS = {
  collection: { type: 'string', description: 'Collection key (see list_collections)' },
  docId: { type: 'string', description: 'Document uuid' },
  locale: { type: 'string', description: 'Locale (defaults to the install default)' },
  status: { type: 'string', enum: ['draft', 'published'], description: 'Which head to read (default published)' },
} as const;

function buildTools(core: AppCore): ToolDef[] {
  const tools: ToolDef[] = [
    {
      name: 'list_collections',
      description: 'List the content collections you can read, including their field schemas. Call this first.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'list_documents',
      description:
        'List documents in a collection with filtering, sorting, pagination and relation population. ' +
        'Filter operators: $eq $ne $gt $gte $lt $lte $in $nin $contains $icontains $startsWith $endsWith $null; combinators $and $or $not.',
      inputSchema: {
        type: 'object',
        properties: {
          collection: COMMON_PROPS.collection,
          filter: { type: 'object', description: 'e.g. {"title":{"$contains":"hello"}}' },
          sort: { type: 'string', description: 'e.g. "-createdAt,title"' },
          page: { type: 'integer', minimum: 1 },
          pageSize: { type: 'integer', minimum: 1, maximum: 100 },
          status: COMMON_PROPS.status,
          locale: COMMON_PROPS.locale,
          populate: { type: 'array', items: { type: 'string' }, description: 'Relation fields to expand' },
          fields: { type: 'array', items: { type: 'string' }, description: 'Project only these fields' },
          count: { type: 'boolean', description: 'Include total count' },
        },
        required: ['collection'],
        additionalProperties: false,
      },
    },
    {
      name: 'get_document',
      description: 'Fetch one document by docId.',
      inputSchema: {
        type: 'object',
        properties: {
          collection: COMMON_PROPS.collection,
          docId: COMMON_PROPS.docId,
          status: COMMON_PROPS.status,
          locale: COMMON_PROPS.locale,
          populate: { type: 'array', items: { type: 'string' } },
        },
        required: ['collection', 'docId'],
        additionalProperties: false,
      },
    },
    {
      name: 'create_document',
      description: 'Create a document (draft by default). "data" must match the collection writeSchema from list_collections.',
      inputSchema: {
        type: 'object',
        properties: {
          collection: COMMON_PROPS.collection,
          data: { type: 'object', description: 'Document body matching the collection schema' },
          locale: COMMON_PROPS.locale,
          publish: { type: 'boolean', description: 'Create and publish atomically' },
        },
        required: ['collection', 'data'],
        additionalProperties: false,
      },
    },
    {
      name: 'update_document',
      description: 'Patch the draft of a document (RFC 7386 merge patch: send only changed keys, null removes a key, arrays replace).',
      inputSchema: {
        type: 'object',
        properties: {
          collection: COMMON_PROPS.collection,
          docId: COMMON_PROPS.docId,
          patch: { type: 'object' },
          locale: COMMON_PROPS.locale,
          ifVersion: { type: 'integer', description: 'Optimistic concurrency: fail if draft version differs' },
        },
        required: ['collection', 'docId', 'patch'],
        additionalProperties: false,
      },
    },
    {
      name: 'delete_document',
      description: 'Delete a document (all locales, or one locale if given). Version history is retained.',
      inputSchema: {
        type: 'object',
        properties: { collection: COMMON_PROPS.collection, docId: COMMON_PROPS.docId, locale: COMMON_PROPS.locale },
        required: ['collection', 'docId'],
        additionalProperties: false,
      },
    },
    {
      name: 'publish_document',
      description: 'Publish the current draft (pointer move; instant, atomic).',
      inputSchema: {
        type: 'object',
        properties: { collection: COMMON_PROPS.collection, docId: COMMON_PROPS.docId, locale: COMMON_PROPS.locale },
        required: ['collection', 'docId'],
        additionalProperties: false,
      },
    },
    {
      name: 'unpublish_document',
      description: 'Unpublish a document (draft is kept).',
      inputSchema: {
        type: 'object',
        properties: { collection: COMMON_PROPS.collection, docId: COMMON_PROPS.docId, locale: COMMON_PROPS.locale },
        required: ['collection', 'docId'],
        additionalProperties: false,
      },
    },
    {
      name: 'list_versions',
      description: 'List the version history of a document (append-only, never rewritten).',
      inputSchema: {
        type: 'object',
        properties: { collection: COMMON_PROPS.collection, docId: COMMON_PROPS.docId, locale: COMMON_PROPS.locale },
        required: ['collection', 'docId'],
        additionalProperties: false,
      },
    },
    {
      name: 'get_version',
      description: 'Fetch the full data of one historical version.',
      inputSchema: {
        type: 'object',
        properties: {
          collection: COMMON_PROPS.collection,
          docId: COMMON_PROPS.docId,
          version: { type: 'integer', minimum: 1 },
          locale: COMMON_PROPS.locale,
        },
        required: ['collection', 'docId', 'version'],
        additionalProperties: false,
      },
    },
    {
      name: 'restore_version',
      description: 'Roll the draft back to a prior version (recorded as a new version; history is preserved).',
      inputSchema: {
        type: 'object',
        properties: {
          collection: COMMON_PROPS.collection,
          docId: COMMON_PROPS.docId,
          version: { type: 'integer', minimum: 1 },
          locale: COMMON_PROPS.locale,
        },
        required: ['collection', 'docId', 'version'],
        additionalProperties: false,
      },
    },
  ];

  for (const query of core.queries.values()) {
    tools.push({
      name: `query_${query.key.replaceAll('-', '_')}`,
      description: query.description ?? `Run the saved query "${query.key}" on ${query.collection}.`,
      inputSchema: {
        type: 'object',
        properties: {
          ...Object.fromEntries(
            Object.entries(query.params ?? {}).map(([name, spec]) => [
              name,
              { type: spec.type === 'text' ? 'string' : spec.type, description: spec.description },
            ]),
          ),
          page: { type: 'integer', minimum: 1 },
          pageSize: { type: 'integer', minimum: 1, maximum: 100 },
        },
        required: Object.entries(query.params ?? {})
          .filter(([, s]) => s.required && s.default === undefined)
          .map(([n]) => n),
        additionalProperties: false,
      },
    });
  }
  return tools;
}

type Args = Record<string, unknown>;

function argStr(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.length === 0) throw errors.badRequest(`Tool argument "${key}" (string) is required`);
  return v;
}

async function callTool(core: AppCore, ctx: AccessContext, name: string, args: Args): Promise<unknown> {
  const locale = typeof args['locale'] === 'string' ? (args['locale'] as string) : core.config.defaultLocale;

  if (name.startsWith('query_')) {
    const key = name.slice('query_'.length).replaceAll('_', '-');
    const query = core.queries.get(key);
    if (!query) throw errors.notFound(`Unknown tool "${name}"`);
    return executeSavedQuery(core.db, core.registry, ctx, query, args, {
      ...(typeof args['page'] === 'number' ? { page: args['page'] as number } : {}),
      ...(typeof args['pageSize'] === 'number' ? { pageSize: args['pageSize'] as number } : {}),
    });
  }

  switch (name) {
    case 'list_collections':
      return {
        collections: core.registry
          .list()
          .filter((col) => can(ctx, 'read', `doc:${col.key}`) || can(ctx, 'readDraft', `doc:${col.key}`))
          .map((col) => ({
            key: col.key,
            description: col.description ?? null,
            readSchema: col.compiled.readSchema,
            ...(can(ctx, 'create', `doc:${col.key}`) || can(ctx, 'update', `doc:${col.key}`)
              ? { writeSchema: col.compiled.writeSchema }
              : {}),
          })),
      };
    case 'list_documents': {
      const collection = argStr(args, 'collection');
      return listDocs(core.db, core.registry, ctx, collection, {
        ...(args['filter'] !== undefined ? { filter: args['filter'] } : {}),
        ...(typeof args['sort'] === 'string' ? { sort: args['sort'] as string } : {}),
        ...(typeof args['page'] === 'number' ? { page: args['page'] as number } : {}),
        ...(typeof args['pageSize'] === 'number' ? { pageSize: args['pageSize'] as number } : {}),
        ...(args['status'] === 'draft' || args['status'] === 'published' ? { status: args['status'] } : {}),
        ...(Array.isArray(args['populate']) ? { populate: args['populate'] as string[] } : {}),
        ...(Array.isArray(args['fields']) ? { fields: args['fields'] as string[] } : {}),
        ...(args['count'] === true ? { count: true } : {}),
        locale,
      });
    }
    case 'get_document': {
      const collection = argStr(args, 'collection');
      const doc = await getDoc(core.db, core.registry, ctx, collection, argStr(args, 'docId'), {
        ...(args['status'] === 'draft' || args['status'] === 'published' ? { status: args['status'] } : {}),
        ...(Array.isArray(args['populate']) ? { populate: args['populate'] as string[] } : {}),
        locale,
      });
      if (!doc) throw errors.notFound('Document not found');
      return { data: doc };
    }
    case 'create_document': {
      const collection = argStr(args, 'collection');
      assertCan(ctx, 'create', `doc:${collection}`);
      if (args['publish'] === true) assertCan(ctx, 'publish', `doc:${collection}`);
      if (args['data'] === null || typeof args['data'] !== 'object' || Array.isArray(args['data'])) {
        throw errors.badRequest('Tool argument "data" (object) is required');
      }
      const doc = await createDoc(core.db, core.registry.get(collection).compiled, storeContextFor(ctx, core), {
        data: args['data'] as Record<string, unknown>,
        locale,
        publish: args['publish'] === true,
      });
      return { data: doc };
    }
    case 'update_document': {
      const collection = argStr(args, 'collection');
      assertCan(ctx, 'update', `doc:${collection}`);
      if (args['patch'] === null || typeof args['patch'] !== 'object' || Array.isArray(args['patch'])) {
        throw errors.badRequest('Tool argument "patch" (object) is required');
      }
      const doc = await patchDoc(core.db, core.registry.get(collection).compiled, storeContextFor(ctx, core), {
        docId: argStr(args, 'docId'),
        patch: args['patch'] as Record<string, unknown>,
        locale,
        ...(typeof args['ifVersion'] === 'number' ? { ifVersion: args['ifVersion'] as number } : {}),
      });
      return { data: doc };
    }
    case 'delete_document': {
      const collection = argStr(args, 'collection');
      assertCan(ctx, 'delete', `doc:${collection}`);
      const result = await deleteDoc(
        core.db,
        core.registry.get(collection).compiled,
        storeContextFor(ctx, core),
        argStr(args, 'docId'),
        typeof args['locale'] === 'string' ? (args['locale'] as string) : undefined,
      );
      return { data: result };
    }
    case 'publish_document':
    case 'unpublish_document': {
      const collection = argStr(args, 'collection');
      assertCan(ctx, 'publish', `doc:${collection}`);
      const fn = name === 'publish_document' ? publishDoc : unpublishDoc;
      const doc = await fn(core.db, core.registry.get(collection).compiled, storeContextFor(ctx, core), argStr(args, 'docId'), locale);
      return { data: doc };
    }
    case 'list_versions': {
      const collection = argStr(args, 'collection');
      assertCan(ctx, 'readDraft', `doc:${collection}`);
      const versions = await listVersions(core.db, core.registry.get(collection).compiled, ctx.tenantId, argStr(args, 'docId'), locale);
      return { data: versions };
    }
    case 'get_version': {
      const collection = argStr(args, 'collection');
      assertCan(ctx, 'readDraft', `doc:${collection}`);
      if (typeof args['version'] !== 'number') throw errors.badRequest('Tool argument "version" (integer) is required');
      const version = await getVersion(core.db, core.registry.get(collection).compiled, ctx.tenantId, argStr(args, 'docId'), args['version'] as number, locale);
      if (!version) throw errors.notFound('Version not found');
      return { data: version };
    }
    case 'restore_version': {
      const collection = argStr(args, 'collection');
      assertCan(ctx, 'update', `doc:${collection}`);
      if (typeof args['version'] !== 'number') throw errors.badRequest('Tool argument "version" (integer) is required');
      const doc = await restoreVersion(core.db, core.registry.get(collection).compiled, storeContextFor(ctx, core), argStr(args, 'docId'), args['version'] as number, locale);
      return { data: doc };
    }
    default:
      throw errors.notFound(`Unknown tool "${name}"`);
  }
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function mcpRoutes(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  app.post('/', async (c) => {
    const core = c.get('core');
    const ctx = c.get('access');

    let message: unknown;
    try {
      message = await c.req.json();
    } catch {
      return c.json(rpcError(null, -32700, 'Parse error'), 400);
    }
    if (Array.isArray(message) || message === null || typeof message !== 'object') {
      return c.json(rpcError(null, -32600, 'Batching is not supported; send one JSON-RPC message'), 400);
    }
    const rpc = message as JsonRpcRequest;

    // Notifications and client responses get 202 and no body.
    if (rpc.id === undefined || rpc.id === null) {
      return c.body(null, 202);
    }

    switch (rpc.method) {
      case 'initialize': {
        const requested = rpc.params?.['protocolVersion'];
        const protocolVersion =
          typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0]!;
        return c.json(
          rpcResult(rpc.id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'apick', version: core.version },
            instructions:
              'APIck headless platform. Call list_collections first to discover schemas. ' +
              'Reads default to published documents; pass status:"draft" for drafts (needs readDraft permission). ' +
              'All operations are permission-scoped to your API key and recorded in the audit log.',
          }),
        );
      }
      case 'ping':
        return c.json(rpcResult(rpc.id, {}));
      case 'tools/list':
        return c.json(rpcResult(rpc.id, { tools: buildTools(core) }));
      case 'tools/call': {
        const name = rpc.params?.['name'];
        const args = (rpc.params?.['arguments'] ?? {}) as Args;
        if (typeof name !== 'string') return c.json(rpcError(rpc.id, -32602, 'params.name is required'));
        const started = Date.now();
        let outcome = 'ok';
        try {
          const result = await callTool(core, ctx, name, args);
          return c.json(
            rpcResult(rpc.id, {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
              structuredContent: result,
              isError: false,
            }),
          );
        } catch (err) {
          const apickErr = ApickError.wrap(err);
          outcome = apickErr.code;
          return c.json(
            rpcResult(rpc.id, {
              content: [{ type: 'text', text: JSON.stringify(apickErr.toBody(), null, 2) }],
              isError: true,
            }),
          );
        } finally {
          if (core.config.interactionLog !== 'off') {
            appendEvent(core.db, {
              tenantId: ctx.tenantId,
              type: 'mcp.call',
              actor: { principalId: ctx.principalId, via: 'mcp', ...(ctx.keyId ? { keyId: ctx.keyId } : {}) },
              subject: { tool: name, ...(typeof args['collection'] === 'string' ? { collection: args['collection'] } : {}) },
              payload: { outcome, latencyMs: Date.now() - started, argKeys: Object.keys(args) },
            }).catch((e) => core.log.warn('mcp interaction log failed', { error: String(e) }));
          }
        }
      }
      default:
        return c.json(rpcError(rpc.id, -32601, `Method not found: ${rpc.method}`));
    }
  });

  // Stateless server: no SSE stream, no sessions to delete.
  app.get('/', (c) => c.json(rpcError(null, -32600, 'This MCP server is stateless: POST JSON-RPC messages'), 405));
  app.delete('/', (c) => c.body(null, 405));

  return app;
}
