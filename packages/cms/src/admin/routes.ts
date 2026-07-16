import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import type { HonoEnv } from '@apick/core';

/**
 * Serves the admin SPA (bundled at package build time — consumers never run a
 * frontend build). The SPA is a pure client of core's REST API: everything it
 * can do, an agent with the same session token can do via /v1 or /mcp.
 */

const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'admin-assets');

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
].join('; ');

const SHELL = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>APIck Admin</title>
<link rel="stylesheet" href="/admin/assets/admin.css" />
</head>
<body>
<div id="app"></div>
<script type="module" src="/admin/assets/app.js"></script>
</body>
</html>`;

export function adminRoutes(app: Hono<HonoEnv>): void {
  let appJs: string | null = null;
  let adminCss: string | null = null;
  const load = (file: string): string => readFileSync(join(ASSETS_DIR, file), 'utf8');

  app.get('/admin/assets/app.js', (c) => {
    appJs ??= load('app.js');
    return c.text(appJs, 200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
  });
  app.get('/admin/assets/admin.css', (c) => {
    adminCss ??= load('admin.css');
    return c.text(adminCss, 200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache' });
  });

  // The SPA uses history routing: any /admin path serves the shell
  // (except /admin/api/*, which are real endpoints registered elsewhere).
  const shell = (): Response =>
    new Response(SHELL, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': CSP,
        'x-frame-options': 'DENY',
        'cache-control': 'no-store',
      },
    });
  app.get('/admin', shell);
  app.get('/admin/*', (c) => {
    if (c.req.path.startsWith('/admin/api/') || c.req.path.startsWith('/admin/assets/')) {
      return c.json({ error: { code: 'not_found', message: `No route: GET ${c.req.path}`, details: null } }, 404);
    }
    return shell();
  });
}
