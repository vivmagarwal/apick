import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, silentLogger, type ApickApp } from 'apick';
import { blogCollections } from './fixtures.js';
import { ApiClient, eventually, freshPgDatabase, pgUrl, startReceiver } from './helpers.js';

/**
 * PROMISE: N replicas are safe — cron fires ONCE cluster-wide and a webhook
 * delivers ONCE, no matter how many workers poll the same database (the
 * structural fix for Strapi's per-replica double-fire). Real Postgres,
 * two full app instances, both with workers running.
 */
describe.skipIf(!pgUrl())('replica safety on real Postgres', () => {
  let replicaA: ApickApp;
  let replicaB: ApickApp;
  let api: ApiClient;
  const cronRuns: string[] = [];
  const jobRuns: string[] = [];
  const rootKey = `apick_pgtest_${randomBytes(8).toString('base64url')}`;

  beforeAll(async () => {
    const database = await freshPgDatabase();
    const mkConfig = (name: string) => {
      const { collections } = blogCollections();
      return {
        database,
        collections,
        rootKey,
        logger: silentLogger,
        migrate: 'apply' as const,
        pollIntervalMs: 25,
        tickIntervalMs: 100,
        // the receivers in this test are loopback; opt out of the SSRF guard
        webhooks: { retry: { maxAttempts: 3, backoffMs: 60 }, allowPrivateTargets: true },
        jobs: {
          'tick-counter': async (payload: Record<string, unknown>) => {
            cronRuns.push(`${name}:${String(payload['scheduledFor'])}`);
          },
          'one-off': async (payload: Record<string, unknown>) => {
            jobRuns.push(`${name}:${String(payload['n'])}`);
          },
        },
        crons: [{ key: 'counter', schedule: '@every:500', queue: 'tick-counter' }],
      };
    };
    replicaA = await createApp(mkConfig('A'));
    replicaB = await createApp(mkConfig('B'));
    const { url } = await replicaA.listen();
    api = new ApiClient(url, rootKey);
  }, 120_000);

  afterAll(async () => {
    await replicaA?.stop();
    await replicaB?.stop();
  });

  it('a cron schedule fires once cluster-wide, not once per replica', async () => {
    cronRuns.length = 0;
    await new Promise((r) => setTimeout(r, 2600));
    // ~5 ticks expected in 2.6s at 500ms cadence. With a per-replica double-fire
    // bug this would be ~10. Allow slop but fail hard on doubling.
    expect(cronRuns.length).toBeGreaterThanOrEqual(3);
    expect(cronRuns.length).toBeLessThanOrEqual(6);
    // every scheduled instant ran exactly once
    const perInstant = new Map<string, number>();
    for (const run of cronRuns) {
      const instant = run.split(':').slice(1).join(':');
      perInstant.set(instant, (perInstant.get(instant) ?? 0) + 1);
    }
    for (const [instant, count] of perInstant) {
      expect(count, `instant ${instant} ran ${count} times`).toBe(1);
    }
    // both replicas participated over enough ticks OR at least one did — but never both on the same instant
  });

  it('a webhook delivers exactly once with two live workers', async () => {
    const receiver = await startReceiver();
    await api.post('/v1/webhooks', { name: 'replica', url: receiver.url, events: ['doc.created:articles'] });
    await api.post('/v1/collections/articles/docs', { data: { title: 'Once', slug: 'exactly-once' } });
    await eventually(() => {
      if (receiver.requests.length === 0) throw new Error('no delivery');
    });
    await new Promise((r) => setTimeout(r, 500)); // give a double-fire time to show up
    expect(receiver.requests).toHaveLength(1);
    await receiver.close();
  });

  it('a job with an idempotency key is enqueued once even when both replicas enqueue it', async () => {
    jobRuns.length = 0;
    await Promise.all([
      replicaA.enqueue({ queue: 'one-off', payload: { n: 1 }, idempotencyKey: 'same-key' }),
      replicaB.enqueue({ queue: 'one-off', payload: { n: 1 }, idempotencyKey: 'same-key' }),
    ]);
    await eventually(() => {
      if (jobRuns.length === 0) throw new Error('job not run');
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(jobRuns).toHaveLength(1);
  });

  it('the full HTTP surface works identically on real Postgres', async () => {
    const created = await api.post('/v1/collections/articles/docs', {
      data: { title: 'PG', slug: 'on-postgres', seo: { metaKey: 'pg-1' }, tags: ['x'] },
      publish: true,
    });
    expect(created.status).toBe(201);
    const read = await api.get(`/v1/collections/articles/docs/${created.body.data.docId}`);
    expect(read.body.data.data.title).toBe('PG');
    const dup = await api.post('/v1/collections/articles/docs', { data: { title: 'dup', slug: 'on-postgres' } });
    expect(dup.status).toBe(409);
  });
});
