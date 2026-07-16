import type { AppCore } from '../app/core.js';

/**
 * OpenAPI 3.1 document generated live from the registry — always in sync with
 * the code-defined schema. Collection read/write schemas come from the same
 * compiled definitions that drive validation and MCP tools.
 */
export function buildOpenApi(core: AppCore): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  const schemas: Record<string, unknown> = {
    Error: {
      type: 'object',
      properties: {
        error: {
          type: 'object',
          properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} },
          required: ['code', 'message'],
        },
      },
      required: ['error'],
    },
  };

  const errorResponse = (description: string) => ({
    description,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  });

  const listParams = [
    { name: 'filter', in: 'query', description: 'JSON filter, e.g. {"title":{"$contains":"x"}}', schema: { type: 'string' } },
    { name: 'sort', in: 'query', description: 'Comma keys, "-" prefix for desc, e.g. -createdAt,title', schema: { type: 'string' } },
    { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
    { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
    { name: 'status', in: 'query', schema: { type: 'string', enum: ['draft', 'published'] } },
    { name: 'locale', in: 'query', schema: { type: 'string' } },
    { name: 'populate', in: 'query', description: 'Comma-separated relation fields', schema: { type: 'string' } },
    { name: 'fields', in: 'query', description: 'Comma-separated field projection', schema: { type: 'string' } },
    { name: 'count', in: 'query', schema: { type: 'string', enum: ['true'] } },
  ];

  for (const col of core.registry.list()) {
    const key = col.key;
    schemas[`${key}Doc`] = col.compiled.readSchema;
    schemas[`${key}Data`] = col.compiled.writeSchema;
    const docRef = { $ref: `#/components/schemas/${key}Doc` };
    const dataRef = { $ref: `#/components/schemas/${key}Data` };

    paths[`/v1/collections/${key}/docs`] = {
      get: {
        tags: [key],
        summary: `List ${key} documents`,
        parameters: listParams,
        responses: {
          '200': {
            description: 'Document list',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: docRef },
                    meta: { type: 'object', properties: { page: { type: 'integer' }, pageSize: { type: 'integer' }, total: { type: 'integer' } } },
                  },
                },
              },
            },
          },
          '400': errorResponse('Rejected plan (unknown/unreadable field, bad params)'),
        },
      },
      post: {
        tags: [key],
        summary: `Create a ${key} document (draft; publish:true to publish atomically)`,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  data: dataRef,
                  locale: { type: 'string' },
                  docId: { type: 'string', format: 'uuid' },
                  publish: { type: 'boolean' },
                },
                required: ['data'],
              },
            },
          },
        },
        responses: {
          '201': { description: 'Created', content: { 'application/json': { schema: { type: 'object', properties: { data: docRef } } } } },
          '422': errorResponse('Validation failed'),
          '409': errorResponse('Unique conflict or duplicate docId'),
        },
      },
    };

    paths[`/v1/collections/${key}/docs/{docId}`] = {
      parameters: [{ name: 'docId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      get: {
        tags: [key],
        summary: `Get one ${key} document`,
        parameters: listParams.filter((p) => ['status', 'locale', 'populate', 'fields'].includes(p.name)),
        responses: {
          '200': { description: 'Document', content: { 'application/json': { schema: { type: 'object', properties: { data: docRef } } } } },
          '404': errorResponse('Not found'),
        },
      },
      patch: {
        tags: [key],
        summary: `Patch the draft (RFC 7386 merge patch; null removes a key)`,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  patch: { type: 'object' },
                  locale: { type: 'string' },
                  ifVersion: { type: 'integer', description: 'Optimistic concurrency guard' },
                  upsertLocale: { type: 'boolean' },
                },
                required: ['patch'],
              },
            },
          },
        },
        responses: {
          '200': { description: 'Updated draft', content: { 'application/json': { schema: { type: 'object', properties: { data: docRef } } } } },
          '409': errorResponse('Version mismatch or unique conflict'),
          '422': errorResponse('Validation failed'),
        },
      },
      delete: {
        tags: [key],
        summary: `Delete a ${key} document (all locales, or one via ?locale=)`,
        responses: { '200': { description: 'Deleted' }, '404': errorResponse('Not found') },
      },
    };

    for (const action of ['publish', 'unpublish']) {
      paths[`/v1/collections/${key}/docs/{docId}/${action}`] = {
        post: {
          tags: [key],
          summary: `${action === 'publish' ? 'Publish (pointer move, not a copy)' : 'Unpublish'} a ${key} document`,
          parameters: [
            { name: 'docId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'locale', in: 'query', schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'Done' }, '404': errorResponse('Not found') },
        },
      };
    }

    paths[`/v1/collections/${key}/docs/{docId}/versions`] = {
      get: {
        tags: [key],
        summary: `Version history for a ${key} document`,
        parameters: [{ name: 'docId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Versions (newest first)' } },
      },
    };
    paths[`/v1/collections/${key}/docs/{docId}/versions/{version}/restore`] = {
      post: {
        tags: [key],
        summary: `Roll the draft back to a prior version (as a new version)`,
        parameters: [
          { name: 'docId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'version', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        responses: { '200': { description: 'Restored' } },
      },
    };
  }

  for (const query of core.queries.values()) {
    paths[`/v1/queries/${query.key}`] = {
      get: {
        tags: ['queries'],
        summary: query.description ?? `Saved query "${query.key}" on ${query.collection}`,
        parameters: [
          ...Object.entries(query.params ?? {}).map(([name, spec]) => ({
            name,
            in: 'query',
            required: !!spec.required && spec.default === undefined,
            description: spec.description,
            schema: { type: spec.type === 'text' ? 'string' : spec.type },
          })),
          { name: 'page', in: 'query', schema: { type: 'integer' } },
          { name: 'pageSize', in: 'query', schema: { type: 'integer' } },
          { name: 'count', in: 'query', schema: { type: 'string', enum: ['true'] } },
        ],
        responses: { '200': { description: 'Query result' } },
      },
    };
  }

  paths['/v1/collections'] = {
    get: { tags: ['meta'], summary: 'List collections readable by the caller', responses: { '200': { description: 'Collections' } } },
  };
  paths['/health'] = { get: { tags: ['meta'], summary: 'Health check', security: [], responses: { '200': { description: 'OK' } } } };

  return {
    openapi: '3.1.0',
    info: {
      title: 'APIck API',
      version: core.version,
      description:
        'Pure-headless, AI-first application platform. Authenticate with `Authorization: Bearer <api key>`. ' +
        'Scope requests to a tenant with the `x-apick-tenant` header (defaults to the install’s default tenant). ' +
        'MCP endpoint at /mcp. Machine-readable guides: /llms.txt and /llms-full.txt.',
    },
    servers: [{ url: '/' }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'APIck API key' } },
      schemas,
    },
    paths,
  };
}
