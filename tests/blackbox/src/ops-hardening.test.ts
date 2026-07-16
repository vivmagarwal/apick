import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, silentLogger } from 'apick';
import { blogCollections } from './fixtures.js';
import { eventually, startApp, type RunningApp } from './helpers.js';

/**
 * PROMISES: production hardening —
 * - webhook targets cannot reach the private network (SSRF guard)
 * - retention prunes events/jobs/versions on schedule (no unbounded growth)
 * - the worker runs jobs concurrently
 * - readiness endpoint, request ids, PGlite single-process guard
 */
describe('SSRF guard on webhook targets', () => {
  let running: RunningApp;
  beforeAll(async () => {
    running = await startApp({
      collections: blogCollections().collections,
      webhooks: { allowPrivateTargets: false }, // production posture
    });
  });
  afterAll(() => running.stop());

  it('rejects private, loopback, link-local and metadata targets at creation', async () => {
    for (const url of [
      'http://127.0.0.1:9/hook',
      'http://10.0.0.5/hook',
      'http://192.168.1.1/hook',
      'http://172.16.3.4/hook',
      'http://169.254.169.254/latest/meta-data/', // cloud metadata
      'http://localhost:3000/hook',
      'http://foo.internal/hook',
      'http://[::1]:8080/hook',
      'ftp://example.com/hook',
    ]) {
      const res = await running.api.post('/v1/webhooks', { name: 'ssrf', url, events: ['*'] });
      expect(res.status, url).toBe(422);
    }
  });

  it('accepts public targets and blocks flipping them to private via PATCH', async () => {
    const ok = await running.api.post('/v1/webhooks', { name: 'pub', url: 'http://93.184.216.34/hook', events: ['*'] });
    expect(ok.status).toBe(201);
    const flip = await running.api.patch(`/v1/webhooks/${ok.body.data.id}`, { url: 'http://169.254.169.254/hook' });
    expect(flip.status).toBe(422);
  });

  it('dev default (embedded db) allows private targets so local webhooks just work', async () => {
    const dev = await startApp({ collections: [] });
    const res = await dev.api.post('/v1/webhooks', { name: 'local', url: 'http://127.0.0.1:9999/hook', events: ['*'] });
    expect(res.status).toBe(201);
    await dev.stop();
  });
});

describe('retention pruning', () => {
  let running: RunningApp;
  beforeAll(async () => {
    running = await startApp({
      collections: blogCollections().collections,
      tickIntervalMs: 100,
      retention: {
        events: { days: 0 }, // everything in the past is prunable
        jobs: { doneDays: 0, deadDays: 0 },
        versions: { keepLast: 2 },
        schedule: '@every:400',
      },
    });
  });
  afterAll(() => running.stop());

  it('prunes old events, finished jobs and deep version history on schedule', async () => {
    const created = await running.api.post('/v1/collections/articles/docs', { data: { title: 'v1', slug: 'ret' } });
    const docId = created.body.data.docId;
    for (let i = 2; i <= 5; i++) {
      await running.api.patch(`/v1/collections/articles/docs/${docId}`, { patch: { title: `v${i}` } });
    }

    await eventually(
      async () => {
        const events = await running.api.get('/v1/events?limit=1000');
        if (events.body.data.length > 0) throw new Error(`${events.body.data.length} events left`);
        const versions = await running.api.get(`/v1/collections/articles/docs/${docId}/versions`);
        if (versions.body.data.length > 2) throw new Error(`${versions.body.data.length} versions left`);
      },
      { timeoutMs: 8000, label: 'retention pruned' },
    );

    // the newest versions survive; the document itself is untouched
    const versions = await running.api.get(`/v1/collections/articles/docs/${docId}/versions`);
    expect(versions.body.data.map((v: { version: number }) => v.version)).toEqual([5, 4]);
    const doc = await running.api.get(`/v1/collections/articles/docs/${docId}?status=draft`);
    expect(doc.body.data.data.title).toBe('v5');
  });
});

describe('worker concurrency', () => {
  it('runs jobs in parallel up to the configured concurrency', async () => {
    let done = 0;
    const app = await startApp({
      collections: [],
      jobConcurrency: 4,
      pollIntervalMs: 20,
      jobs: {
        slow: async () => {
          await new Promise((r) => setTimeout(r, 400));
          done++;
        },
      },
    });
    const started = Date.now();
    for (let i = 0; i < 4; i++) await app.app.enqueue({ queue: 'slow', payload: { i } });
    await eventually(() => {
      if (done < 4) throw new Error(`${done}/4`);
    });
    const elapsed = Date.now() - started;
    // serial execution would need >= 1600ms; parallel should be well under half
    expect(elapsed).toBeLessThan(1200);
    await app.stop();
  });
});

describe('operational endpoints & headers', () => {
  let running: RunningApp;
  beforeAll(async () => {
    running = await startApp({ collections: [] });
  });
  afterAll(() => running.stop());

  it('readiness probes the database; liveness does not', async () => {
    const live = await fetch(`${running.url}/health`);
    expect(live.status).toBe(200);
    const ready = await fetch(`${running.url}/health/ready`);
    expect(ready.status).toBe(200);
    expect(((await ready.json()) as { ready: boolean }).ready).toBe(true);
  });

  it('every response carries a request id; caller ids are propagated, junk is replaced', async () => {
    const minted = await fetch(`${running.url}/health`);
    expect(minted.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);

    const echoed = await fetch(`${running.url}/health`, { headers: { 'x-request-id': 'trace-abc.123' } });
    expect(echoed.headers.get('x-request-id')).toBe('trace-abc.123');

    // header-legal but outside APIck's id format (too long) -> replaced with a fresh id
    const junk = await fetch(`${running.url}/health`, { headers: { 'x-request-id': 'x'.repeat(200) } });
    expect(junk.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('PGlite single-process guard', () => {
  it('refuses to open the same data directory twice, and recovers after close', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'apick-lock-')), 'db');
    const first = await createApp({ database: `pglite://${dir}`, logger: silentLogger, worker: false });
    await expect(createApp({ database: `pglite://${dir}`, logger: silentLogger, worker: false })).rejects.toThrow(
      /already open/,
    );
    await first.stop();
    const again = await createApp({ database: `pglite://${dir}`, logger: silentLogger, worker: false });
    await again.stop();
  });
});
