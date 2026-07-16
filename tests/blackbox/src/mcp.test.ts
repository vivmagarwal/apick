import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { blogCollections, recentArticles } from './fixtures.js';
import { startApp, type RunningApp } from './helpers.js';

/**
 * PROMISE: first-class MCP — a real MCP SDK client (not hand-rolled JSON-RPC)
 * connects over streamable HTTP, discovers schema-derived tools, and every
 * operation is least-privilege and attributable in the audit log.
 */
describe('MCP server', () => {
  let running: RunningApp;

  async function connect(token: string | null): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`), {
      requestInit: { headers: token ? { authorization: `Bearer ${token}` } : {} },
    });
    const client = new Client({ name: 'blackbox', version: '1.0.0' });
    await client.connect(transport);
    return client;
  }

  beforeAll(async () => {
    const { collections } = blogCollections();
    running = await startApp({ collections, queries: [recentArticles] });
  });

  afterAll(() => running.stop());

  it('a real MCP client connects, lists tools, and round-trips create → get → list → publish', async () => {
    const client = await connect(running.rootKey);
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain('list_collections');
    expect(names).toContain('create_document');
    expect(names).toContain('query_recent_articles'); // saved queries become tools

    const schemas = (await client.callTool({ name: 'list_collections', arguments: {} })) as {
      structuredContent: { collections: Array<{ key: string; readSchema: unknown; writeSchema?: unknown }> };
    };
    const articleSchema = schemas.structuredContent.collections.find((c) => c.key === 'articles')!;
    expect(articleSchema.writeSchema).toBeTruthy();
    expect(JSON.stringify(articleSchema.readSchema)).not.toContain('secretNotes'); // private stays private in MCP too

    const created = (await client.callTool({
      name: 'create_document',
      arguments: { collection: 'articles', data: { title: 'Via MCP', slug: 'via-mcp', category: 'tech' }, publish: true },
    })) as { isError?: boolean; structuredContent: { data: { docId: string } } };
    expect(created.isError).toBeFalsy();
    const docId = created.structuredContent.data.docId;

    const got = (await client.callTool({ name: 'get_document', arguments: { collection: 'articles', docId } })) as {
      structuredContent: { data: { data: { title: string } } };
    };
    expect(got.structuredContent.data.data.title).toBe('Via MCP');

    const listed = (await client.callTool({
      name: 'list_documents',
      arguments: { collection: 'articles', filter: { category: { $eq: 'tech' } }, count: true },
    })) as { structuredContent: { data: unknown[]; meta: { total: number } } };
    expect(listed.structuredContent.meta.total).toBeGreaterThan(0);

    const viaQuery = (await client.callTool({
      name: 'query_recent_articles',
      arguments: { category: 'tech' },
    })) as { structuredContent: { data: Array<{ data: { title: string } }> } };
    expect(viaQuery.structuredContent.data.map((d) => d.data.title)).toContain('Via MCP');

    await client.close();
  });

  it('least privilege: a reader key gets tool errors on mutations, not silent success', async () => {
    const keyRes = await running.api.post('/v1/keys', { role: 'content-reader', name: 'mcp reader' });
    const client = await connect(keyRes.body.data.token);

    const denied = (await client.callTool({
      name: 'create_document',
      arguments: { collection: 'articles', data: { title: 'nope', slug: 'nope' } },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(denied.isError).toBe(true);
    expect(denied.content[0]!.text).toContain('forbidden');

    const draftDenied = (await client.callTool({
      name: 'list_documents',
      arguments: { collection: 'articles', status: 'draft' },
    })) as { isError?: boolean };
    expect(draftDenied.isError).toBe(true);

    // private-field filter probe is rejected through MCP exactly like REST
    const oracle = (await client.callTool({
      name: 'list_documents',
      arguments: { collection: 'articles', filter: { secretNotes: { $startsWith: 'a' } } },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(oracle.isError).toBe(true);
    expect(oracle.content[0]!.text).toContain('plan_rejected');

    await client.close();
  });

  it('anonymous MCP clients only reach public data', async () => {
    const client = await connect(null);
    const schemas = (await client.callTool({ name: 'list_collections', arguments: {} })) as {
      structuredContent: { collections: Array<{ key: string }> };
    };
    expect(schemas.structuredContent.collections.map((c) => c.key)).toEqual(['articles']);
    await client.close();
  });

  it('every MCP mutation is attributed in the event log (principal + via + key)', async () => {
    const events = await running.api.get('/v1/events?types=doc.created&limit=1000');
    const mcpEvent = events.body.data.find(
      (e: { actor: { via: string }; payload: { data?: { title?: string } } }) =>
        e.actor.via === 'mcp' && e.payload.data?.title === 'Via MCP',
    );
    expect(mcpEvent).toBeTruthy();
    expect(mcpEvent.actor.principalId).toBeTruthy();
    expect(mcpEvent.actor.keyId).toBeTruthy();

    const calls = await running.api.get('/v1/events?types=mcp.call&limit=1000');
    expect(calls.body.data.length).toBeGreaterThan(0);
    const call = calls.body.data[0];
    expect(call.subject.tool).toBeTruthy();
    expect(call.payload.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
