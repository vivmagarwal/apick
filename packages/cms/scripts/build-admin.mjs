// Bundles the admin SPA at PACKAGE build time — consumers of @apick/cms never
// run a frontend build. Output: dist/admin-assets/{app.js,admin.css}
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist', 'admin-assets');
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(root, 'src', 'admin', 'ui', 'main.ts')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  outfile: join(outDir, 'app.js'),
  define: { 'process.env.NODE_ENV': '"production"' },
});

// admin.css = editor styles + edodo-write's stylesheet (so the markdown editor
// looks right without the consumer importing anything).
const edodoCss = readFileSync(require.resolve('edodo-write/styles.css'), 'utf8');
const adminCss = readFileSync(join(root, 'src', 'admin', 'styles.css'), 'utf8');
writeFileSync(join(outDir, 'admin.css'), adminCss + '\n/* --- edodo-write --- */\n' + edodoCss);
console.log('admin SPA bundled -> dist/admin-assets/ (with edodo-write css)');
