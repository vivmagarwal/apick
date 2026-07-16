// Bundles the admin SPA at PACKAGE build time — consumers of @apick/cms never
// run a frontend build. Output: dist/admin-assets/{app.js,admin.css}
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

copyFileSync(join(root, 'src', 'admin', 'styles.css'), join(outDir, 'admin.css'));
console.log('admin SPA bundled -> dist/admin-assets/');
