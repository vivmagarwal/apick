import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, eventually, type RunningApp } from './helpers.js';

/**
 * PROMISE: durable background jobs — retries with backoff, dead-letter with
 * replay over HTTP, idempotent enqueues; code-defined cron drives user queues.
 */
describe('durable jobs & cron', () => {
  let running: RunningApp;
  const runs: Array<{ queue: string; n: unknown; attempt: number }> = [];
  let failuresLeft = 0;

  beforeAll(async () => {
    running = await startApp({
      collections: [],
      jobs: {
        'flaky-work': async (payload, ctx) => {
          runs.push({ queue: 'flaky-work', n: payload['n'], attempt: ctx.attempts });
          if (failuresLeft > 0) {
            failuresLeft--;
            throw new Error('transient failure');
          }
        },
        'always-dies': async () => {
          throw new Error('permanent failure');
        },
        'cron-work': async (payload) => {
          runs.push({ queue: 'cron-work', n: payload['cronKey'], attempt: 1 });
        },
      },
      crons: [{ key: 'heartbeat', schedule: '@every:300', queue: 'cron-work' }],
    });
  });

  afterAll(() => running.stop());

  it('retries a failing job with backoff until it succeeds', async () => {
    failuresLeft = 2;
    await running.app.enqueue({ queue: 'flaky-work', payload: { n: 'retry-test' }, backoffMs: 30, maxAttempts: 5 });
    await eventually(() => {
      const attempts = runs.filter((r) => r.n === 'retry-test');
      if (attempts.length < 3) throw new Error(`only ${attempts.length} attempts`);
    });
    const attempts = runs.filter((r) => r.n === 'retry-test').map((r) => r.attempt);
    expect(attempts).toEqual([1, 2, 3]); // two failures, then success
  });

  it('dead-letters after max attempts, visible and replayable over HTTP', async () => {
    await running.app.enqueue({ queue: 'always-dies', payload: {}, backoffMs: 20, maxAttempts: 2 });
    let deadJob: { id: string; last_error: string } | undefined;
    await eventually(async () => {
      const res = await running.api.get('/v1/jobs?state=dead');
      deadJob = res.body.data.find((j: { queue: string }) => j.queue === 'always-dies');
      if (!deadJob) throw new Error('not dead yet');
    });
    expect(deadJob!.last_error).toContain('permanent failure');

    const replayed = await running.api.post(`/v1/jobs/${deadJob!.id}/replay`);
    expect(replayed.status).toBe(200);
    await eventually(async () => {
      const res = await running.api.get('/v1/jobs?state=dead');
      const again = res.body.data.find((j: { id: string }) => j.id === deadJob!.id);
      if (!again) throw new Error('replay not dead again yet');
    });
  });

  it('idempotency keys dedupe enqueues', async () => {
    const before = runs.filter((r) => r.n === 'idem').length;
    const a = await running.app.enqueue({ queue: 'flaky-work', payload: { n: 'idem' }, idempotencyKey: 'idem-1' });
    const b = await running.app.enqueue({ queue: 'flaky-work', payload: { n: 'idem' }, idempotencyKey: 'idem-1' });
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(true);
    await eventually(() => {
      if (runs.filter((r) => r.n === 'idem').length === before) throw new Error('not run');
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(runs.filter((r) => r.n === 'idem')).toHaveLength(before + 1);
  });

  it('code-defined cron drives user job queues on schedule', async () => {
    await eventually(
      () => {
        const beats = runs.filter((r) => r.queue === 'cron-work');
        if (beats.length < 2) throw new Error('cron has not fired twice yet');
      },
      { timeoutMs: 5000 },
    );
    expect(runs.filter((r) => r.queue === 'cron-work')[0]!.n).toBe('heartbeat');
  });

  it('rejects reserved queue names and unknown cron targets at startup', async () => {
    await expect(
      startApp({ collections: [], jobs: { 'apick.evil': async () => {} } }),
    ).rejects.toThrow(/reserved/);
    await expect(
      startApp({ collections: [], crons: [{ key: 'x', schedule: '@every:1000', queue: 'missing-handler' }] }),
    ).rejects.toThrow(/no job handler/);
  });
});
