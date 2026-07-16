import { createApp, defineCollection, defineQuery, f } from '@apick/core';

// ---------------------------------------------------------------------------
// A multi-tenant publishing platform in one file: relations, composable
// blocks, private fields, saved queries, background jobs, cron, and a custom
// endpoint. Everything here is also reachable over MCP at /mcp.
// ---------------------------------------------------------------------------

const authors = defineCollection('authors', {
  description: 'People who write articles',
  fields: {
    name: f.text({ required: true }),
    email: f.email({ private: true }), // never leaves the server via any API
    bio: f.markdown(),
  },
});

const articles = defineCollection('articles', {
  description: 'Blog articles with composable content blocks',
  access: { publicRead: true }, // anonymous readers see published articles
  fields: {
    title: f.text({ required: true, maxLength: 200, indexed: true }),
    slug: f.slug({ unique: true }),
    category: f.enum(['engineering', 'product', 'company'] ),
    author: f.relation('authors'),
    related: f.relations('articles'),
    // "blocks" = composition as data: the frontend renders these however it likes
    body: f.blocks({
      prose: { markdown: f.markdown({ required: true }) },
      quote: { text: f.text({ required: true }), attribution: f.text() },
      hero: { heading: f.text({ required: true }), imageUrl: f.uri() },
    }),
    reviewNotes: f.text({ private: true }),
  },
});

// Saved queries = "views", headless: typed, bounded, permission-scoped.
const queries = [
  defineQuery('latest', {
    collection: 'articles',
    description: 'Latest published articles in a category',
    filter: { category: { $eq: { $param: 'category' } } },
    sort: '-createdAt',
    pageSize: 10,
    populate: ['author'],
    params: { category: { type: 'text', required: true } },
  }),
];

const app = await createApp({
  collections: [authors, articles],
  queries,

  // Durable background jobs (retries, backoff, dead-letter included):
  jobs: {
    'notify-editors': async (payload) => {
      console.log(`[job] would notify editors about ${payload.docId}`);
    },
    'nightly-digest': async () => {
      console.log('[cron] building the nightly digest');
    },
  },
  // Cluster-safe schedule: fires ONCE even with N replicas.
  crons: [{ key: 'digest', schedule: '0 2 * * *', queue: 'nightly-digest' }],

  // Custom endpoints on the same app (you own main(); apick is a library):
  extend: (hono) => {
    hono.get('/hello', (c) => c.json({ hello: 'from a custom route' }));
  },
});

if (app.rootKey) {
  console.log('Root API key (shown once):', app.rootKey);
}

const { url } = await app.listen(3000);
console.log(`
Blog API running at ${url}
  Public list    GET  ${url}/v1/collections/articles/docs        (anonymous works)
  Saved query    GET  ${url}/v1/queries/latest?category=engineering
  Webhooks       POST ${url}/v1/webhooks   {"name":"n","url":"https://...","events":["doc.published:articles"]}
  New tenant     POST ${url}/v1/tenants    {"slug":"acme","name":"Acme"}   (then use x-apick-tenant: acme)
  MCP            ${url}/mcp
  Full guide     ${url}/llms-full.txt
`);
