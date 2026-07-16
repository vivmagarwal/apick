import type { Hono } from 'hono';
import { makeBlockRenderer, type DocView, type SiteInfo, type Theme } from './theme.js';

/**
 * The public site. Every read goes through core's own REST API in-process as
 * the ANONYMOUS principal — the site can only ever show what an anonymous API
 * caller could fetch (publicRead + published). No privileged side door.
 */

export interface SiteOptions {
  title: string;
  description: string;
  theme: Theme;
  postsPageSize: number;
}

const RESERVED = new Set(['v1', 'mcp', 'admin', 'health', 'openapi.json', 'llms.txt', 'llms-full.txt', 'theme.css', 'blog', 'media', 'favicon.ico']);

interface ListResponse {
  data: Array<{ docId: string; publishedAt: string | null; data: Record<string, unknown> }>;
  meta: { total?: number };
}

export function siteRoutes(app: Hono<never>, options: SiteOptions): void {
  const theme = options.theme;
  const renderBlocks = makeBlockRenderer(theme);

  const api = async (path: string): Promise<ListResponse | null> => {
    const res = await app.fetch(new Request(`http://cms.internal${path}`));
    if (!res.ok) return null;
    return (await res.json()) as ListResponse;
  };

  const docView = (row: { docId: string; publishedAt: string | null; data: Record<string, unknown> }): DocView => ({
    docId: row.docId,
    data: row.data,
    publishedAt: row.publishedAt,
  });

  const siteInfo = async (): Promise<SiteInfo> => {
    const nav: SiteInfo['nav'] = [{ label: 'Blog', href: '/blog' }];
    const navPages = await api(
      `/v1/collections/pages/docs?filter=${encodeURIComponent(JSON.stringify({ showInNav: { $eq: true } }))}&sort=navOrder&pageSize=20`,
    );
    for (const page of navPages?.data ?? []) {
      nav.push({ label: String(page.data['title'] ?? page.data['slug']), href: `/${page.data['slug']}` });
    }
    return { title: options.title, description: options.description, nav };
  };

  const page = (site: SiteInfo, title: string, description: string | undefined, content: ReturnType<Theme['templates']['home']>) =>
    theme.templates.layout({ site, title, description, content }).value;

  const htmlResponse = (body: string, status = 200): Response =>
    new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

  const notFound = async (path: string): Promise<Response> => {
    const site = await siteInfo();
    return htmlResponse(page(site, 'Not found', undefined, theme.templates.notFound({ site, path })), 404);
  };

  app.get('/theme.css', (c) => c.text(theme.css, 200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=300' }));

  app.get('/', async () => {
    const site = await siteInfo();
    const homeRes = await api(
      `/v1/collections/pages/docs?filter=${encodeURIComponent(JSON.stringify({ slug: { $eq: 'home' } }))}&pageSize=1`,
    );
    const homePage = homeRes?.data[0] ? docView(homeRes.data[0]) : null;
    const postsRes = await api(`/v1/collections/posts/docs?sort=-publishDate,-createdAt&pageSize=${options.postsPageSize}`);
    const posts = (postsRes?.data ?? []).map(docView);
    return htmlResponse(page(site, '', options.description, theme.templates.home({ site, homePage, posts, renderBlocks })));
  });

  app.get('/blog', async (c) => {
    const site = await siteInfo();
    const pageNum = Math.max(1, Number.parseInt(c.req.query('page') ?? '1', 10) || 1);
    const res = await api(
      `/v1/collections/posts/docs?sort=-publishDate,-createdAt&page=${pageNum}&pageSize=${options.postsPageSize}&count=true`,
    );
    const posts = (res?.data ?? []).map(docView);
    const total = res?.meta.total ?? posts.length;
    const hasMore = pageNum * options.postsPageSize < total;
    return htmlResponse(page(site, 'Blog', undefined, theme.templates.postList({ site, posts, page: pageNum, hasMore })));
  });

  app.get('/blog/:slug', async (c) => {
    const slug = c.req.param('slug');
    const res = await api(
      `/v1/collections/posts/docs?filter=${encodeURIComponent(JSON.stringify({ slug: { $eq: slug } }))}&pageSize=1`,
    );
    const row = res?.data[0];
    if (!row) return notFound(`/blog/${slug}`);
    const site = await siteInfo();
    const post = docView(row);
    return htmlResponse(
      page(
        site,
        String(post.data['title'] ?? ''),
        typeof post.data['excerpt'] === 'string' ? post.data['excerpt'] : undefined,
        theme.templates.post({ site, post }),
      ),
    );
  });

  // pages + themed 404 catch-all (GET only; API paths keep their JSON 404s)
  app.get('/:slug', async (c) => {
    const slug = c.req.param('slug');
    if (RESERVED.has(slug)) return notFound(`/${slug}`);
    const res = await api(
      `/v1/collections/pages/docs?filter=${encodeURIComponent(JSON.stringify({ slug: { $eq: slug } }))}&pageSize=1`,
    );
    const row = res?.data[0];
    if (!row) return notFound(`/${slug}`);
    const site = await siteInfo();
    const pageDoc = docView(row);
    return htmlResponse(
      page(
        site,
        String(pageDoc.data['title'] ?? ''),
        typeof pageDoc.data['seoDescription'] === 'string' ? pageDoc.data['seoDescription'] : undefined,
        theme.templates.page({ site, page: pageDoc, renderBlocks }),
      ),
    );
  });

  app.get('*', async (c) => {
    const path = new URL(c.req.url).pathname;
    if (path.startsWith('/v1/') || path.startsWith('/mcp') || path.startsWith('/admin')) {
      return c.json({ error: { code: 'not_found', message: `No route: GET ${path}`, details: null } }, 404);
    }
    return notFound(path);
  });
}
