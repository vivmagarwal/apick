// Bundles the admin SPA at PACKAGE build time — consumers of @apick/cms never
// run a frontend build. Output: dist/admin-assets/{app.js,admin.css}
//
// The SPA is React + Tailwind v4 (+ shadcn-style components in src/admin/ui).
// esbuild compiles/bundles the TSX; the Tailwind CLI generates the utility CSS
// by scanning the same sources; edodo-write's stylesheet is appended so the
// markdown editor styles ship too.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist', 'admin-assets');
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(root, 'src', 'admin', 'ui', 'main.tsx')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  jsx: 'automatic',
  outfile: join(outDir, 'app.js'),
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'silent',
});

// Tailwind: src/admin/ui/app.css declares the theme; the CLI scans sources.
// @tailwindcss/cli exports only ./package.json — resolve the bin through it.
const twCli = join(dirname(require.resolve('@tailwindcss/cli/package.json')), 'dist', 'index.mjs');
execFileSync(process.execPath, [twCli, '-i', join(root, 'src', 'admin', 'ui', 'app.css'), '-o', join(outDir, 'admin.css'), '--minify'], {
  cwd: root,
  stdio: ['ignore', 'ignore', 'inherit'],
});

// append edodo-write's stylesheet (markdown editor)
const edodoCss = readFileSync(require.resolve('edodo-write/styles.css'), 'utf8');
writeFileSync(join(outDir, 'admin.css'), readFileSync(join(outDir, 'admin.css'), 'utf8') + '\n/* --- edodo-write --- */\n' + edodoCss);
console.log('admin SPA bundled -> dist/admin-assets/ (react + tailwind + edodo-write css)');
