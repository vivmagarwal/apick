import { createApp, defineCollection, f } from '@apick/core';

// One collection. That's the whole schema definition — it drives validation,
// the REST API, OpenAPI, MCP tools and llms.txt all at once.
const todos = defineCollection('todos', {
  fields: {
    title: f.text({ required: true }),
    done: f.boolean({ default: false }),
  },
});

// No database setup: an embedded Postgres (PGlite) lives in ./.apick-data.
// Point `database` at postgres://… when you deploy.
const app = await createApp({ collections: [todos] });

if (app.rootKey) {
  console.log('Your root API key (shown once, save it):');
  console.log('  ' + app.rootKey);
}

const { url } = await app.listen(3000);
console.log(`
APIck is running:
  API      ${url}/v1/collections/todos/docs
  OpenAPI  ${url}/openapi.json
  MCP      ${url}/mcp
  Guide    ${url}/llms-full.txt
`);
