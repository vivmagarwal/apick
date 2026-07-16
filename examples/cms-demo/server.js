import { createCms } from '@apick/cms';
import { collections } from './collections/index.js';
import { theme } from './theme/index.js';
import { plugins } from './plugins/index.js';

// The conventional layout (scaffolded by `npx apick-cms init`):
// framework in node_modules — never touched; YOUR site in these directories.
const app = await createCms({
  site: {
    title: 'The Test Kitchen',
    description: 'Recipes, notes and experiments — powered by APIck CMS.',
  },
  collections,
  theme,
  plugins,
  preview: {
    pathFor: (collection, doc) => (collection === 'recipes' && doc.data.slug ? `/recipes/${doc.data.slug}` : null),
  },
});

if (app.rootKey) console.log('Root API key (shown once):', app.rootKey);
const { url } = await app.listen(process.env.PORT ? Number(process.env.PORT) : 3000);
console.log(`
The Test Kitchen is running:
  Site     ${url}/
  Admin    ${url}/admin        ← first visit walks you through creating your account
  API      ${url}/v1/collections/recipes/docs
  MCP      ${url}/mcp
`);
