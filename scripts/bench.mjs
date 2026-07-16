// Micro-benchmark: boots a real app (embedded PGlite or $APICK_BENCH_DATABASE)
// and measures reads/writes through the full HTTP stack.
//   node scripts/bench.mjs [durationSecondsPerCase=5] [concurrency=16]
import { createApp, defineCollection, f, silentLogger } from '../packages/apick/dist/index.js';

const DURATION = (Number.parseFloat(process.argv[2]) || 5) * 1000;
const CONCURRENCY = Number.parseInt(process.argv[3], 10) || 16;

const articles = defineCollection('articles', {
  access: { publicRead: true },
  fields: {
    title: f.text({ required: true }),
    slug: f.slug(),
    views: f.integer({ default: 0 }),
    body: f.markdown(),
  },
});

const app = await createApp({
  database: process.env.APICK_BENCH_DATABASE ?? 'pglite://memory',
  collections: [articles],
  rootKey: 'apick_bench',
  logger: silentLogger,
  interactionLog: 'off', // measure the API itself, not the audit writes
  worker: false,
});
const { url } = await app.listen();
const H = { authorization: 'Bearer apick_bench', 'content-type': 'application/json' };

// seed
const ids = [];
for (let i = 0; i < 200; i++) {
  const res = await fetch(`${url}/v1/collections/articles/docs`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ data: { title: `Doc ${i}`, slug: `doc-${i}`, views: i, body: 'x'.repeat(500) }, publish: true }),
  });
  ids.push((await res.json()).data.docId);
}

async function bench(name, makeRequest) {
  const latencies = [];
  const deadline = Date.now() + DURATION;
  let errors = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (Date.now() < deadline) {
        const t0 = performance.now();
        const res = await makeRequest();
        if (!res.ok) errors++;
        latencies.push(performance.now() - t0);
      }
    }),
  );
  latencies.sort((a, b) => a - b);
  const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))].toFixed(1);
  const rps = (latencies.length / (DURATION / 1000)).toFixed(0);
  console.log(
    `${name.padEnd(28)} ${String(rps).padStart(7)} req/s   p50 ${pct(50)}ms  p95 ${pct(95)}ms  p99 ${pct(99)}ms` +
      (errors ? `  errors=${errors}` : ''),
  );
}

console.log(`apick bench — ${CONCURRENCY} concurrent, ${DURATION / 1000}s per case, db=${app.db.kind}\n`);
let n = 1000;
await bench('GET one (authed)', () => fetch(`${url}/v1/collections/articles/docs/${ids[n++ % ids.length]}`, { headers: H }));
await bench('GET one (anonymous)', () => fetch(`${url}/v1/collections/articles/docs/${ids[n++ % ids.length]}`));
await bench('GET list+filter (25 rows)', () =>
  fetch(`${url}/v1/collections/articles/docs?filter=${encodeURIComponent('{"views":{"$gte":50}}')}&sort=-views`, { headers: H }),
);
await bench('POST create', () =>
  fetch(`${url}/v1/collections/articles/docs`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ data: { title: 'bench', slug: `b-${n++}-${Date.now()}`, body: 'y'.repeat(500) } }),
  }),
);
await bench('PATCH draft', () =>
  fetch(`${url}/v1/collections/articles/docs/${ids[n++ % ids.length]}`, {
    method: 'PATCH',
    headers: H,
    body: JSON.stringify({ patch: { views: n } }),
  }),
);

await app.stop();
