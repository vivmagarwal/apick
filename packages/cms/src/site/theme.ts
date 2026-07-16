import { marked } from 'marked';
import { html, raw, type RawHtml } from './html.js';

/**
 * A theme is CODE — a set of template functions plus block renderers, exactly
 * like collections and roles are code. Child themes are object spreads:
 *
 *   const myTheme = defineTheme({ ...defaultTheme, templates: {
 *     ...defaultTheme.templates, home: (ctx) => html`...` } });
 *
 * All templates receive escaped-by-default `html` output; markdown is
 * rendered with `md()` (editors are trusted authors, as in WordPress).
 */

export interface SiteInfo {
  title: string;
  description: string;
  nav: Array<{ label: string; href: string }>;
}

export interface DocView {
  docId: string;
  data: Record<string, unknown>;
  publishedAt: string | null;
}

export interface LayoutContext {
  site: SiteInfo;
  title: string;
  description?: string | undefined;
  content: RawHtml;
}

export interface HomeContext {
  site: SiteInfo;
  homePage: DocView | null;
  posts: DocView[];
  renderBlocks: (blocks: unknown) => RawHtml;
}

export interface PageContext {
  site: SiteInfo;
  page: DocView;
  renderBlocks: (blocks: unknown) => RawHtml;
}

export interface PostContext {
  site: SiteInfo;
  post: DocView;
}

export interface PostListContext {
  site: SiteInfo;
  posts: DocView[];
  page: number;
  hasMore: boolean;
}

export interface NotFoundContext {
  site: SiteInfo;
  path: string;
}

export type BlockRenderer = (props: Record<string, unknown>) => RawHtml;

export interface Theme {
  name: string;
  /** Served at /theme.css and linked by the default layout. */
  css: string;
  templates: {
    layout(ctx: LayoutContext): RawHtml;
    home(ctx: HomeContext): RawHtml;
    page(ctx: PageContext): RawHtml;
    post(ctx: PostContext): RawHtml;
    postList(ctx: PostListContext): RawHtml;
    notFound(ctx: NotFoundContext): RawHtml;
  };
  /** Renderers for f.blocks variants; unknown variants fall back to a comment. */
  blocks: Record<string, BlockRenderer>;
}

export type PartialTheme = Partial<Omit<Theme, 'templates' | 'blocks'>> & {
  templates?: Partial<Theme['templates']>;
  blocks?: Record<string, BlockRenderer>;
};

export function defineTheme(theme: Theme): Theme {
  return theme;
}

/** Merge a partial theme over a base (child-theme semantics). */
export function mergeTheme(base: Theme, override?: PartialTheme): Theme {
  if (!override) return base;
  return {
    name: override.name ?? base.name,
    css: override.css ?? base.css,
    templates: { ...base.templates, ...(override.templates ?? {}) },
    blocks: { ...base.blocks, ...(override.blocks ?? {}) },
  };
}

/** Markdown → trusted HTML (authors are trusted, like WordPress editors). */
export function md(markdown: unknown): RawHtml {
  if (typeof markdown !== 'string' || markdown.length === 0) return raw('');
  return raw(marked.parse(markdown, { async: false }) as string);
}

export function makeBlockRenderer(theme: Theme): (blocks: unknown) => RawHtml {
  return (blocks: unknown): RawHtml => {
    if (!Array.isArray(blocks)) return raw('');
    const parts = blocks.map((block) => {
      if (!block || typeof block !== 'object') return raw('');
      const type = (block as Record<string, unknown>)['__type'];
      const renderer = typeof type === 'string' ? theme.blocks[type] : undefined;
      if (!renderer) return raw(`<!-- unknown block: ${typeof type === 'string' ? type : '?'} -->`);
      return renderer(block as Record<string, unknown>);
    });
    return html`${parts}`;
  };
}
