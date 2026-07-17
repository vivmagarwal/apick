#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The scaffold pins THIS CLI's own version, so `npm install` always resolves.
const CMS_VERSION: string = (() => {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;
  } catch {
    return 'latest';
  }
})();

/**
 * apick-cms init [dir] — scaffold a site with the conventional layout:
 * framework in node_modules (never touched, upgraded via npm), YOUR code in
 * clearly-owned directories. Drupal's conventions, npm's distribution.
 *
 *   my-site/
 *     server.js        wiring (yours, small)
 *     collections/     your content types
 *     theme/           your child theme
 *     plugins/         your plugins
 */

const FILES: Record<string, string> = {
  'package.json': `{
  "name": "my-apick-site",
  "private": true,
  "type": "module",
  "scripts": { "start": "node server.js" },
  "dependencies": { "@apick/cms": "^${CMS_VERSION}" }
}
`,

  'server.js': `import { createCms } from '@apick/cms';
import { collections } from './collections/index.js';
import { theme } from './theme/index.js';
import { plugins } from './plugins/index.js';

const app = await createCms({
  site: {
    title: 'My Site',
    description: 'Built with APIck CMS',
  },
  collections,
  theme,
  plugins,
  // Sharing a Postgres with other apps (or other APIck instances)? Give this
  // site its own schema — created automatically, nothing else is touched:
  // databaseSchema: 'apick_my_site',
});

if (app.rootKey) console.log('Root API key (shown once, save it):', app.rootKey);
// dev: port 3000 · PaaS: no-args listen() honors the injected PORT + binds 0.0.0.0
const { url } = await app.listen(process.env.PORT ? undefined : 3000);
console.log(\`
  Site   \${url}/
  Admin  \${url}/admin   ← first visit creates your account
  API    \${url}/v1/collections
  MCP    \${url}/mcp
\`);
`,

  'collections/index.js': `// Your content types. Pages + posts come built in; add your own here and
// they get an admin UI, REST + MCP endpoints and validation automatically.
// import { recipes } from './recipes.js';

export const collections = [
  // recipes,
];
`,

  'collections/recipes.example.js': `import { defineCollection, f } from '@apick/cms';

export const recipes = defineCollection('recipes', {
  description: 'Cooking recipes',
  access: { publicRead: true }, // anonymous visitors may read published docs
  fields: {
    name: f.text({ required: true }),
    slug: f.slug({ required: true, unique: true }),
    difficulty: f.enum(['easy', 'medium', 'hard'], { default: 'easy' }),
    minutes: f.integer({ min: 1 }),
    ingredients: f.list(f.text()),
    instructions: f.markdown({ required: true }),
  },
});
`,

  'theme/index.js': `// Your child theme. Anything you don't override comes from the default
// "quiet" theme — templates, block renderers and CSS merge independently.
// import { html, md, defaultTheme } from '@apick/cms';

export const theme = {
  name: 'my-theme',
  // css: defaultTheme.css + '\\n h1 { color: rebeccapurple; }',
  // templates: {
  //   home: ({ site, posts }) => html\`<h1>\${site.title}</h1> ...\`,
  // },
  // blocks: {
  //   quote: (props) => html\`<aside class="pull">\${props.text}</aside>\`,
  // },
};
`,

  'plugins/index.js': `// Your plugins: collections + saved queries + jobs + crons + custom routes +
// admin navigation + theme fragments, in one composable unit.
// import { myPlugin } from './my-plugin.js';

export const plugins = [
  // myPlugin,
];
`,

  '.gitignore': `node_modules/
.apick-data/
.apick-data.apick-lock
.env
`,

  'README.md': `# My APIck site

\`\`\`bash
npm install
npm start          # http://localhost:3000  ·  admin at /admin
\`\`\`

- **collections/** — your content types (schema = admin UI = API = MCP tools)
- **theme/** — your child theme (templates, blocks, css)
- **plugins/** — your plugins
- **server.js** — the wiring; deploy anywhere Node runs, point
  \`APICK_DATABASE_URL\` at Postgres in production

The framework lives in node_modules — upgrade with \`npm update @apick/cms\`.
Your directories are never touched by upgrades.
`,
};

function main(): void {
  const [, , command, dirArg] = process.argv;
  if (command !== 'init') {
    console.log('Usage: apick-cms init [dir]');
    if (command && command !== 'help' && command !== '--help') process.exitCode = 1;
    return;
  }
  const dir = resolve(process.cwd(), dirArg && !dirArg.startsWith('--') ? dirArg : '.');
  for (const [name, content] of Object.entries(FILES)) {
    const target = join(dir, name);
    if (existsSync(target)) {
      console.error(`refusing to overwrite ${target}`);
      process.exitCode = 1;
      return;
    }
  }
  for (const [name, content] of Object.entries(FILES)) {
    const target = join(dir, name);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
  console.log(`Scaffolded an APIck CMS site in ${dir}

  cd ${dir}
  npm install
  npm start          # site at :3000, admin at :3000/admin
`);
}

main();
