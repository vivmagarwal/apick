import { describe, expect, it } from 'vitest';
import { createApp, defineCollection, f, silentLogger } from 'apick';

/**
 * PROMISE: zero to API in under a minute. This test IS the hello world — the
 * exact code from the README, timed end-to-end: define a schema, create the
 * app, get a working authenticated API with validation, publish flow, MCP
 * and OpenAPI. No database setup, no Docker, no scaffolder.
 */
describe('zero to API', () => {
  it('goes from nothing to a working authenticated API in well under a minute', async () => {
    const startedAt = Date.now();

    // --- the entire hello world ---
    const todos = defineCollection('todos', {
      fields: {
        title: f.text({ required: true }),
        done: f.boolean({ default: false }),
      },
    });
    const app = await createApp({ database: 'pglite://memory', collections: [todos], logger: silentLogger });
    const { url } = await app.listen();
    // -------------------------------

    const rootKey = app.rootKey!; // generated on first boot, shown once
    expect(rootKey).toBeTruthy();
    const headers = { authorization: `Bearer ${rootKey}`, 'content-type': 'application/json' };

    const created = await fetch(`${url}/v1/collections/todos/docs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ data: { title: 'Ship v1' }, publish: true }),
    });
    expect(created.status).toBe(201);
    const doc = (await created.json()) as { data: { docId: string; data: { done: boolean } } };
    expect(doc.data.data.done).toBe(false); // default applied

    const list = await fetch(`${url}/v1/collections/todos/docs`, { headers });
    expect(((await list.json()) as { data: unknown[] }).data).toHaveLength(1);

    // validation is on by default
    const invalid = await fetch(`${url}/v1/collections/todos/docs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ data: { done: 'not-a-boolean' } }),
    });
    expect(invalid.status).toBe(422);

    // the AI surface is already there
    expect((await fetch(`${url}/openapi.json`)).status).toBe(200);
    expect((await fetch(`${url}/llms.txt`)).status).toBe(200);
    const mcpInit = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { ...headers, accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }),
    });
    expect(mcpInit.status).toBe(200);

    const elapsed = Date.now() - startedAt;
    await app.stop();

    // the promise is < 60s; in practice this must be a few seconds
    expect(elapsed).toBeLessThan(60_000);
    console.log(`zero-to-api took ${elapsed}ms`);
  });
});
