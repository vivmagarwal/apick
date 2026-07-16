import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from 'apick';
import { blogCollections } from './fixtures.js';
import { eventually, startApp, startReceiver, type RunningApp } from './helpers.js';

/**
 * PROMISE: webhooks are reliable, not fire-and-forget — signed payloads,
 * retries with backoff, dead-letter + replay, at-least-once with an
 * idempotency key for consumers.
 */
describe('reliable webhooks', () => {
  let running: RunningApp;

  beforeAll(async () => {
    const { collections } = blogCollections();
    running = await startApp({
      collections,
      webhookRetry: { maxAttempts: 3, backoffMs: 60 }, // fast retries for tests
    });
  });

  afterAll(() => running.stop());

  it('delivers a signed payload the consumer can verify with the shared secret', async () => {
    const receiver = await startReceiver();
    const hook = await running.api.post('/v1/webhooks', { name: 'sig', url: receiver.url, events: ['doc.created:articles'] });
    const secret = hook.body.data.secret;
    expect(secret).toMatch(/^whsec_/);

    await running.api.post('/v1/collections/articles/docs', { data: { title: 'Signed', slug: 'signed' } });
    await eventually(() => {
      if (receiver.requests.length === 0) throw new Error('no delivery');
    });

    const req = receiver.requests[0]!;
    const signature = req.headers['apick-signature'] as string;
    expect(verifyWebhookSignature(secret, req.body, signature)).toBe(true);
    expect(verifyWebhookSignature('whsec_wrong', req.body, signature)).toBe(false);
    expect(verifyWebhookSignature(secret, req.body + 'tampered', signature)).toBe(false);
    // stale timestamp rejected
    expect(verifyWebhookSignature(secret, req.body, signature, { now: Date.now() + 10 * 60_000 })).toBe(false);

    const payload = JSON.parse(req.body);
    expect(payload.type).toBe('doc.created');
    expect(payload.payload.data.title).toBe('Signed');
    expect(req.headers['apick-delivery-id']).toBeTruthy();
    expect(req.headers['apick-event-type']).toBe('doc.created');
    await receiver.close();
    await running.api.delete(`/v1/webhooks/${hook.body.data.id}`);
  });

  it('retries failed deliveries with backoff until success', async () => {
    const receiver = await startReceiver();
    receiver.respondWith(500);
    const hook = await running.api.post('/v1/webhooks', { name: 'retry', url: receiver.url, events: ['doc.created:articles'] });

    await running.api.post('/v1/collections/articles/docs', { data: { title: 'Retry me', slug: 'retry-me' } });
    await eventually(() => {
      if (receiver.requests.length < 1) throw new Error('no first attempt');
    });
    receiver.respondWith(200); // heal the receiver

    await eventually(async () => {
      const deliveries = await running.api.get(`/v1/webhooks/${hook.body.data.id}/deliveries?state=success`);
      if (deliveries.body.data.length === 0) throw new Error('not delivered yet');
    });
    expect(receiver.requests.length).toBeGreaterThanOrEqual(2);
    // all attempts carried the SAME delivery id (consumer-side idempotency)
    const ids = new Set(receiver.requests.map((r) => r.headers['apick-delivery-id']));
    expect(ids.size).toBe(1);
    await receiver.close();
    await running.api.delete(`/v1/webhooks/${hook.body.data.id}`);
  });

  it('dead-letters after max attempts and supports replay', async () => {
    const receiver = await startReceiver();
    receiver.respondWith(503);
    const hook = await running.api.post('/v1/webhooks', { name: 'dead', url: receiver.url, events: ['doc.created:articles'] });

    await running.api.post('/v1/collections/articles/docs', { data: { title: 'Doomed', slug: 'doomed-delivery' } });

    let deadDelivery: { id: string; attempts: number } | undefined;
    await eventually(async () => {
      const dead = await running.api.get(`/v1/webhooks/${hook.body.data.id}/deliveries?state=dead`);
      deadDelivery = dead.body.data[0];
      if (!deadDelivery) throw new Error('not dead yet');
    });
    expect(deadDelivery!.attempts).toBe(3);
    expect(receiver.requests.length).toBe(3);

    // replay after the receiver recovers
    receiver.respondWith(200);
    const replay = await running.api.post(`/v1/deliveries/${deadDelivery!.id}/replay`);
    expect(replay.status).toBe(200);
    await eventually(async () => {
      const ok = await running.api.get(`/v1/webhooks/${hook.body.data.id}/deliveries?state=success`);
      if (ok.body.data.length === 0) throw new Error('replay not delivered');
    });
    await receiver.close();
    await running.api.delete(`/v1/webhooks/${hook.body.data.id}`);
  });

  it('honors event patterns and disabled state', async () => {
    const receiver = await startReceiver();
    const hook = await running.api.post('/v1/webhooks', { name: 'pat', url: receiver.url, events: ['doc.published:authors'] });

    // non-matching events don't deliver
    await running.api.post('/v1/collections/articles/docs', { data: { title: 'No match', slug: 'no-match' }, publish: true });
    // matching event delivers
    await running.api.post('/v1/collections/authors/docs', { data: { name: 'Match' }, publish: true });
    await eventually(() => {
      if (receiver.requests.length === 0) throw new Error('no delivery');
    });
    expect(receiver.requests).toHaveLength(1);
    expect(JSON.parse(receiver.requests[0]!.body).subject.collection).toBe('authors');

    // disable → no more deliveries
    await running.api.patch(`/v1/webhooks/${hook.body.data.id}`, { enabled: false });
    await running.api.post('/v1/collections/authors/docs', { data: { name: 'After disable' }, publish: true });
    await new Promise((r) => setTimeout(r, 400));
    expect(receiver.requests).toHaveLength(1);
    await receiver.close();
  });
});
