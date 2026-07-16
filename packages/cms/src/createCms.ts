import { createHash, createHmac } from 'node:crypto';
import {
  createApiKey,
  createApp,
  createPrincipal,
  grantRole,
  sql,
  type ApickApp,
  type ApickConfig,
  type Collection,
  type CronDefinition,
  type ExternalIdentity,
  type SavedQuery,
  type UserJobHandler,
} from '@apick/core';
import { cmsUsers, media, pages, posts, recentPosts, CMS_USERS_KEY } from './content.js';
import { createContextBox, type CmsContext } from './context.js';
import { cmsRoleDefinitions, coreRoleForCmsRole } from './roles.js';
import { authRoutes, findUserById } from './auth/routes.js';
import { usersRoutes } from './auth/users-routes.js';
import { passwordVersion, resolveCmsSecret, verifySession } from './auth/session.js';
import { adminRoutes } from './admin/routes.js';
import { mediaRoutes, DEFAULT_MEDIA_OPTIONS, type MediaStorage } from './media/routes.js';
import { siteRoutes } from './site/routes.js';
import { previewRoutes, type PreviewConfig } from './site/preview.js';
import { defaultTheme } from './site/default-theme.js';
import { configureMarkdown, mergeTheme, type PartialTheme } from './site/theme.js';

export interface CmsPlugin {
  name: string;
  collections?: Collection[];
  queries?: SavedQuery[];
  jobs?: Record<string, UserJobHandler>;
  crons?: CronDefinition[];
  /** Custom endpoints, registered before the site's catch-all. */
  routes?: Parameters<NonNullable<ApickConfig['extend']>>['0'] extends never ? never : NonNullable<ApickConfig['extend']>;
  /** Extra links in the admin sidebar. */
  adminNav?: Array<{ label: string; href: string }>;
  /** Template/block overrides layered onto the theme. */
  theme?: PartialTheme;
}

export interface CmsConfig
  extends Omit<ApickConfig, 'collections' | 'roles' | 'auth' | 'extend' | 'rootIndex' | 'queries'> {
  /** Your content collections (merged with the defaults and plugins'). */
  collections?: Collection[];
  queries?: SavedQuery[];
  /** Include the opinionated pages+posts model (default true). */
  defaultContent?: boolean;
  site?: { title?: string; description?: string; postsPageSize?: number };
  /** Media library: size/type limits and (optionally) your own storage driver (e.g. S3). */
  media?: { maxFileSizeMB?: number; allowedTypes?: string[]; storage?: MediaStorage };
  /** Content rendering policy. `sanitize` (default true) hardens markdown→HTML
   * on the public site: raw HTML dropped, link/image URL protocols allow-listed.
   * Set false only for trusted setups that deliberately want raw HTML. */
  content?: { sanitize?: boolean };
  /** Child-theme overrides on the default theme, or a whole different theme. */
  theme?: PartialTheme;
  /** Draft preview: map a document to its site path (defaults cover pages+posts). */
  preview?: PreviewConfig;
  plugins?: CmsPlugin[];
  session?: { ttlHours?: number; secret?: string };
  /** Extra routes, same as core's extend (runs before the site catch-all). */
  extend?: ApickConfig['extend'];
}

export interface CmsApp extends ApickApp {
  adminPath: string;
  siteTitle: string;
}

export async function createCms(config: CmsConfig = {}): Promise<CmsApp> {
  const plugins = config.plugins ?? [];
  const collections: Collection[] = [
    cmsUsers,
    media,
    ...(config.defaultContent !== false ? [pages, posts] : []),
    ...(config.collections ?? []),
    ...plugins.flatMap((p) => p.collections ?? []),
  ];
  const queries: SavedQuery[] = [
    ...(config.defaultContent !== false ? [recentPosts] : []),
    ...(config.queries ?? []),
    ...plugins.flatMap((p) => p.queries ?? []),
  ];
  const jobs: Record<string, UserJobHandler> = { ...(config.jobs ?? {}) };
  for (const plugin of plugins) {
    for (const [queue, handler] of Object.entries(plugin.jobs ?? {})) {
      if (jobs[queue]) throw new Error(`Plugin "${plugin.name}" redefines job queue "${queue}"`);
      jobs[queue] = handler;
    }
  }
  const crons: CronDefinition[] = [...(config.crons ?? []), ...plugins.flatMap((p) => p.crons ?? [])];

  let theme = mergeTheme(defaultTheme, undefined);
  for (const plugin of plugins) theme = mergeTheme(theme, plugin.theme);
  theme = mergeTheme(theme, config.theme);

  const site = {
    title: config.site?.title ?? 'My APIck Site',
    description: config.site?.description ?? 'Published with APIck CMS',
    postsPageSize: config.site?.postsPageSize ?? 10,
  };
  const adminNav = plugins.flatMap((p) => p.adminNav ?? []);
  configureMarkdown({ sanitize: config.content?.sanitize ?? true });
  const box = createContextBox();

  // The CMS is its own IdP on top of core's hook: session token -> user ->
  // core role for this request. Password changes invalidate sessions (pv).
  const verifyToken = async (token: string): Promise<ExternalIdentity | null> => {
    const ctx = box.ctx;
    if (!ctx || !token.startsWith('cms1.')) return null;
    const payload = verifySession(ctx.secret, token);
    if (!payload) return null;
    const user = await findUserById(ctx, payload.sub);
    if (!user || passwordVersion(user.draft_data.passwordHash) !== payload.pv) return null;
    return {
      externalId: `cms:${user.doc_id}`,
      kind: 'user',
      name: user.draft_data.name,
      email: user.draft_data.email,
      roles: [coreRoleForCmsRole(user.draft_data.role)],
    };
  };

  const mediaOptions = {
    maxFileSizeMB: config.media?.maxFileSizeMB ?? DEFAULT_MEDIA_OPTIONS.maxFileSizeMB,
    allowedTypes: config.media?.allowedTypes ?? DEFAULT_MEDIA_OPTIONS.allowedTypes,
    storage: config.media?.storage ?? null,
  };

  const {
    defaultContent: _dc,
    site: _site,
    theme: _theme,
    plugins: _plugins,
    session: _session,
    media: _mediaCfg,
    content: _content,
    extend: userExtend,
    collections: _cols,
    queries: _queries,
    jobs: _jobs,
    crons: _crons,
    ...passthrough
  } = config;

  const app = await createApp({
    ...passthrough,
    // uploads need headroom over the JSON default (multipart overhead is small)
    maxBodyBytes: Math.max(passthrough.maxBodyBytes ?? 5 * 1024 * 1024, Math.ceil(mediaOptions.maxFileSizeMB * 1.2 * 1024 * 1024)),
    collections,
    queries,
    jobs,
    crons,
    roles: cmsRoleDefinitions(collections),
    rootIndex: false,
    auth: { verifyToken },
    extend: (hono, core) => {
      authRoutes(hono, box);
      usersRoutes(hono, box);
      mediaRoutes(hono, box, mediaOptions);
      adminRoutes(hono);
      previewRoutes(hono as never, box, config.preview);
      for (const plugin of plugins) plugin.routes?.(hono, core);
      userExtend?.(hono, core);
      // the themable site owns everything that's left — register it LAST
      siteRoutes(hono as never, { title: site.title, description: site.description, theme, postsPageSize: site.postsPageSize });
      // fill the context box (createCms completes this before listen())
      box.ctx = {
        db: core.db,
        core,
        log: core.log,
        tenantId: '', // set below once the default tenant is known
        secret: '',
        internalToken: '',
        sessionTtlMs: (config.session?.ttlHours ?? 72) * 3_600_000,
        site: { title: site.title, description: site.description },
        theme,
        adminNav,
        fetchApi: (path, init = {}) => {
          const { token, ...rest } = init;
          const headers = new Headers(rest.headers);
          headers.set('content-type', 'application/json');
          if (token) headers.set('authorization', `Bearer ${token}`);
          return Promise.resolve(hono.fetch(new Request(`http://cms.internal${path}`, { ...rest, headers })));
        },
      };
    },
  });

  // finish initializing the context (no requests until the caller listens)
  const ctx = box.ctx as CmsContext;
  ctx.tenantId = app.defaultTenant.id;
  ctx.secret = await resolveCmsSecret(app.db, app.defaultTenant.id, config.session?.secret);
  ctx.internalToken = await ensureInternalKey(app, ctx.secret);

  return { ...app, adminPath: '/admin', siteTitle: site.title };
}

/**
 * Deterministic internal service key (derived from the CMS secret, so every
 * replica agrees without coordination). Its principal holds cms-admin in the
 * default tenant — used only for the CMS's own server-side API calls.
 */
async function ensureInternalKey(app: ApickApp, secret: string): Promise<string> {
  const token = `apick_cms_${createHmac('sha256', secret).update('internal-service-key').digest('base64url').slice(0, 40)}`;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const { rows: existing } = await app.db.query(sql`select 1 from apick_api_keys where token_hash = ${tokenHash}`);
  if (existing.length > 0) return token;

  let principalId = (
    await app.db.query<{ id: string }>(sql`select id from apick_principals where kind = 'service' and name = '__cms'`)
  ).rows[0]?.id;
  if (!principalId) {
    principalId = (await createPrincipal(app.db, { kind: 'service', name: '__cms' })).id;
  }
  await grantRole(app.db, { principalId, roleKey: 'cms-admin', tenantId: app.defaultTenant.id });
  await createApiKey(app.db, { principalId, label: 'cms internal (derived from secret)', token });
  return token;
}

export { CMS_USERS_KEY };
