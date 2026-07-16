import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { blogCollections } from './fixtures.js';
import { eventually, startApp, type RunningApp } from './helpers.js';

/**
 * PROMISE: OpenTelemetry out of the box. APIck instruments against the OTel
 * API; when the HOST registers an SDK (as this test does), spans flow — with
 * no SDK it's all no-ops. This is the standard library pattern.
 */
describe('OpenTelemetry integration', () => {
  const exporter = new InMemorySpanExporter();
  let running: RunningApp;

  beforeAll(async () => {
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    provider.register();
    running = await startApp({
      collections: blogCollections().collections,
      jobs: { noop: async () => {} },
    });
  });

  afterAll(() => running.stop());

  it('emits http.request spans with method, path, status and tenant', async () => {
    exporter.reset();
    const res = await running.api.post('/v1/collections/articles/docs', { data: { title: 'traced', slug: 'traced' } });
    expect(res.status).toBe(201);

    const span = exporter.getFinishedSpans().find((s) => s.name === 'apick.http.request');
    expect(span).toBeTruthy();
    expect(span!.attributes['http.request.method']).toBe('POST');
    expect(span!.attributes['url.path']).toBe('/v1/collections/articles/docs');
    expect(span!.attributes['http.response.status_code']).toBe(201);
    expect(span!.attributes['apick.tenant']).toBe('default');
  });

  it('emits job.run spans for background work', async () => {
    exporter.reset();
    await running.app.enqueue({ queue: 'noop', payload: {} });
    await eventually(() => {
      const span = exporter.getFinishedSpans().find((s) => s.name === 'apick.job.run');
      if (!span) throw new Error('no job span yet');
      expect(span.attributes['apick.queue']).toBe('noop');
    });
  });

  it('emits mcp.tool_call spans', async () => {
    exporter.reset();
    await fetch(`${running.url}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${running.rootKey}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_collections', arguments: {} } }),
    });
    const span = exporter.getFinishedSpans().find((s) => s.name === 'apick.mcp.tool_call');
    expect(span).toBeTruthy();
    expect(span!.attributes['apick.tool']).toBe('list_collections');
  });
});
