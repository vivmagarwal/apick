import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blogCollections } from './fixtures.js';
import { startApp, type RunningApp } from './helpers.js';

/**
 * PROMISE: browser frontends are first-class consumers. CORS is on by default
 * (safe: auth is bearer-token, not cookie), restrictable per install.
 */
describe('CORS', () => {
  describe('default (open)', () => {
    let running: RunningApp;
    beforeAll(async () => {
      running = await startApp({ collections: blogCollections().collections });
    });
    afterAll(() => running.stop());

    it('answers preflight with permissive headers', async () => {
      const res = await fetch(`${running.url}/v1/collections/articles/docs`, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://frontend.example.com',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type,x-apick-tenant',
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(res.headers.get('access-control-allow-methods')).toContain('PATCH');
      expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization');
      expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('x-apick-tenant');
    });

    it('sets allow-origin on actual requests', async () => {
      const res = await fetch(`${running.url}/v1/collections/articles/docs`, {
        headers: { origin: 'https://frontend.example.com' },
      });
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(res.headers.get('access-control-expose-headers')?.toLowerCase()).toContain('x-request-id');
    });
  });

  describe('restricted origins', () => {
    let running: RunningApp;
    beforeAll(async () => {
      running = await startApp({
        collections: blogCollections().collections,
        cors: { origins: ['https://app.example.com'] },
      });
    });
    afterAll(() => running.stop());

    it('allows the configured origin and no other', async () => {
      const ok = await fetch(`${running.url}/health`, { headers: { origin: 'https://app.example.com' } });
      expect(ok.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
      const blocked = await fetch(`${running.url}/health`, { headers: { origin: 'https://evil.example.com' } });
      expect(blocked.headers.get('access-control-allow-origin')).toBeNull();
    });
  });

  describe('disabled', () => {
    let running: RunningApp;
    beforeAll(async () => {
      running = await startApp({ collections: [], cors: false });
    });
    afterAll(() => running.stop());

    it('emits no CORS headers at all', async () => {
      const res = await fetch(`${running.url}/health`, { headers: { origin: 'https://app.example.com' } });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });
  });
});
