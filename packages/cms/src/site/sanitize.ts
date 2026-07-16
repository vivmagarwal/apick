import { Marked } from 'marked';

/**
 * Hardened markdown → HTML rendering. The security boundary for user content
 * is HERE (the server-side render), not the editor: content also arrives via
 * the REST API and MCP, which never touch the editor. Markdown's attack
 * surface is narrow and well understood, so we harden it precisely rather than
 * post-processing arbitrary HTML:
 *
 *   1. raw HTML tokens are dropped (no <script>, <iframe>, <img onerror=…>)
 *   2. link/image URLs are protocol allow-listed (no javascript:/vbscript:/
 *      data: — relative, http(s), mailto, tel only; images also allow
 *      data:image/<raster>)
 *
 * Markdown's own syntax cannot express event handlers or scripts, so with
 * these two rules the rendered HTML is safe. `sanitize: false` restores the
 * permissive renderer for trusted setups that deliberately want raw HTML.
 */

const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const SAFE_IMAGE_DATA = /^data:image\/(png|jpeg|jpg|gif|webp|avif);/i;

function safeUrl(href: unknown, opts: { allowImageData?: boolean } = {}): string | null {
  if (typeof href !== 'string') return null;
  const url = href.trim();
  if (url === '') return null;
  // Relative / anchor / protocol-relative-to-same-origin: always safe.
  if (url.startsWith('/') || url.startsWith('./') || url.startsWith('../') || url.startsWith('#')) return url;
  // A scheme is present only if ":" appears before any "/", "?" or "#".
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  if (!schemeMatch) return url; // no scheme → relative path
  const scheme = `${schemeMatch[1]!.toLowerCase()}:`;
  if (SAFE_LINK_PROTOCOLS.has(scheme)) return url;
  if (opts.allowImageData && scheme === 'data:' && SAFE_IMAGE_DATA.test(url)) return url;
  return null; // javascript:, vbscript:, data:text/html, file:, etc.
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const safeMarked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    // Drop raw HTML entirely (both block and inline).
    html: () => '',
    link(token: { href: string; title?: string | null; tokens?: unknown[]; text: string }) {
      const href = safeUrl(token.href);
      const inner = token.tokens ? (this as any).parser.parseInline(token.tokens) : escapeAttr(token.text);
      if (!href) return inner; // unsafe URL → keep the text, drop the link
      const title = token.title ? ` title="${escapeAttr(token.title)}"` : '';
      return `<a href="${escapeAttr(href)}"${title} rel="nofollow ugc">${inner}</a>`;
    },
    image(token: { href: string; title?: string | null; text: string }) {
      const src = safeUrl(token.href, { allowImageData: true });
      if (!src) return escapeAttr(token.text ?? ''); // unsafe src → alt text only
      const title = token.title ? ` title="${escapeAttr(token.title)}"` : '';
      return `<img src="${escapeAttr(src)}" alt="${escapeAttr(token.text ?? '')}"${title} loading="lazy" />`;
    },
  },
});

const permissiveMarked = new Marked({ gfm: true, breaks: false });

export function renderMarkdown(value: unknown, sanitize: boolean): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  const engine = sanitize ? safeMarked : permissiveMarked;
  return engine.parse(value, { async: false }) as string;
}
