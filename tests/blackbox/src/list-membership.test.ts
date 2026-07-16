import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineCollection, f } from '@apick/core';
import { filterQs, startApp, type RunningApp } from './helpers.js';

/**
 * PROMISE: lists of text/enum scalars support membership filtering —
 * `{"tags":{"$contains":"x"}}` matches documents whose list holds "x",
 * exactly like $contains on to-many relations. Everything else about
 * composite fields stays non-filterable, and the bounded-read and
 * literal-matching guarantees are unchanged.
 */
describe('list membership filtering', () => {
  let running: RunningApp;

  const cases = defineCollection('cases', {
    access: { publicRead: true },
    fields: {
      title: f.text({ required: true }),
      themes: f.list(f.enum(['rights', 'development', 'peace'])),
      tags: f.list(f.text()),
      sections: f.list(f.object({ heading: f.text() })),
      meta: f.object({ keywords: f.list(f.text()) }),
    },
  });

  beforeAll(async () => {
    running = await startApp({ collections: [cases] });
    const docs = [
      { title: 'South China Sea', themes: ['peace'], tags: ['borders', 'security'] },
      { title: 'Grameen Bank', themes: ['development'], tags: ['poverty'], meta: { keywords: ['microfinance'] } },
      { title: 'Rohingya', themes: ['rights', 'peace'], tags: ['identity', 'borders'] },
      { title: 'Untagged' },
    ];
    for (const data of docs) {
      await running.api.post('/v1/collections/cases/docs', { data, publish: true });
    }
  });

  afterAll(() => running.stop());

  const titles = (body: any): string[] => body.data.map((d: { data: { title: string } }) => d.data.title).sort();

  it('$contains matches list membership (enum and text items)', async () => {
    const peace = await running.api.get(`/v1/collections/cases/docs?${filterQs({ themes: { $contains: 'peace' } })}`);
    expect(peace.status).toBe(200);
    expect(titles(peace.body)).toEqual(['Rohingya', 'South China Sea']);

    const borders = await running.api.get(`/v1/collections/cases/docs?${filterQs({ tags: { $contains: 'borders' } })}`);
    expect(titles(borders.body)).toEqual(['Rohingya', 'South China Sea']);
  });

  it('$contains combines with $and/$or like any predicate', async () => {
    const both = await running.api.get(
      `/v1/collections/cases/docs?${filterQs({ $and: [{ themes: { $contains: 'peace' } }, { tags: { $contains: 'identity' } }] })}`,
    );
    expect(titles(both.body)).toEqual(['Rohingya']);
  });

  it('$contains is exact membership, not substring', async () => {
    const partial = await running.api.get(`/v1/collections/cases/docs?${filterQs({ tags: { $contains: 'border' } })}`);
    expect(partial.body.data).toHaveLength(0);
  });

  it('$null distinguishes documents without the list', async () => {
    const missing = await running.api.get(`/v1/collections/cases/docs?${filterQs({ themes: { $null: true } })}`);
    expect(titles(missing.body)).toEqual(['Untagged']);
  });

  it('works on lists nested inside objects (dotted path)', async () => {
    const nested = await running.api.get(
      `/v1/collections/cases/docs?${filterQs({ 'meta.keywords': { $contains: 'microfinance' } })}`,
    );
    expect(nested.status).toBe(200);
    expect(titles(nested.body)).toEqual(['Grameen Bank']);
  });

  it('rejects every other operator on scalar lists', async () => {
    for (const predicate of [{ $eq: 'peace' }, { $icontains: 'pea' }, { $in: ['peace'] }, { $startsWith: 'p' }]) {
      const res = await running.api.get(`/v1/collections/cases/docs?${filterQs({ themes: predicate })}`);
      expect(res.status, JSON.stringify(predicate)).toBe(400);
      expect(res.body.error.code).toBe('plan_rejected');
    }
  });

  it('rejects non-string $contains values', async () => {
    const res = await running.api.get(`/v1/collections/cases/docs?${filterQs({ themes: { $contains: 5 } })}`);
    expect(res.status).toBe(400);
  });

  it('lists of objects stay non-filterable', async () => {
    const res = await running.api.get(`/v1/collections/cases/docs?${filterQs({ sections: { $contains: 'x' } })}`);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('not filterable');
  });

  it('scalar lists stay unsortable', async () => {
    const res = await running.api.get('/v1/collections/cases/docs?sort=tags');
    expect(res.status).toBe(400);
  });
});
