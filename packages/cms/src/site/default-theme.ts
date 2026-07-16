import { html } from './html.js';
import { defineTheme, md, type Theme } from './theme.js';

/**
 * "Barebones" — the default theme. Minimal opinionated black & white
 * (shadcn-flavored: zinc neutrals, Inter/system sans, hairline borders,
 * 8px radius), no JavaScript, dark-mode aware. Deliberately restrained so
 * real sites replace or extend it — a clean sheet, not a design to fight.
 */

const CSS = `
:root {
  --bg: #ffffff; --fg: #09090b; --muted: #71717a; --line: #e4e4e7;
  --card: #fafafa; --radius: 8px; --max: 42rem;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #09090b; --fg: #fafafa; --muted: #a1a1aa; --line: #27272a; --card: #18181b; }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.65 Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
  -webkit-font-smoothing: antialiased;
}
header.site, main, footer.site { max-width: var(--max); margin: 0 auto; padding: 0 1.5rem; }
header.site {
  display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap;
  gap: 0.5rem 1.5rem; padding-top: 2rem; padding-bottom: 1.25rem; border-bottom: 1px solid var(--line);
}
header.site .brand { font-weight: 600; font-size: 0.95rem; letter-spacing: -0.01em; color: var(--fg); text-decoration: none; }
header.site nav { display: flex; gap: 1.25rem; }
header.site nav a { color: var(--muted); text-decoration: none; font-size: 0.875rem; }
header.site nav a:hover { color: var(--fg); }
main { padding-top: 3rem; padding-bottom: 5rem; min-height: 60vh; }
h1, h2, h3 { letter-spacing: -0.025em; line-height: 1.2; font-weight: 600; }
h1 { font-size: 1.875rem; margin: 0 0 0.75rem; }
h2 { font-size: 1.25rem; margin: 2rem 0 0.5rem; }
p, li { color: color-mix(in srgb, var(--fg) 92%, var(--muted)); }
a { color: var(--fg); text-underline-offset: 3px; }
a:hover { color: var(--muted); }
img { max-width: 100%; border-radius: var(--radius); border: 1px solid var(--line); }
pre { background: var(--card); border: 1px solid var(--line); padding: 1rem; border-radius: var(--radius); overflow-x: auto; font-size: 0.85em; }
code { font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 0.9em; background: var(--card); padding: 0.1em 0.35em; border-radius: 4px; }
pre code { background: none; padding: 0; }
blockquote { margin: 1.5rem 0; padding: 0.25rem 0 0.25rem 1.25rem; border-left: 2px solid var(--fg); color: var(--muted); }
hr { border: 0; border-top: 1px solid var(--line); margin: 2.5rem 0; }
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
th { text-align: left; border-bottom: 1px solid var(--fg); padding: 0.5rem 0.75rem 0.5rem 0; font-weight: 600; }
td { border-bottom: 1px solid var(--line); padding: 0.5rem 0.75rem 0.5rem 0; }
.meta { color: var(--muted); font-size: 0.8rem; }
.post-list { list-style: none; padding: 0; margin: 0; }
.post-list li { padding: 1.25rem 0; border-bottom: 1px solid var(--line); }
.post-list h2 { margin: 0 0 0.2rem; font-size: 1.05rem; }
.post-list h2 a { color: var(--fg); text-decoration: none; }
.post-list h2 a:hover { color: var(--muted); }
.post-list p { margin: 0.3rem 0 0; color: var(--muted); font-size: 0.9rem; }
.tags { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-top: 0.6rem; }
.tags span { font-size: 0.7rem; border: 1px solid var(--line); border-radius: 99px; padding: 0.1rem 0.6rem; color: var(--muted); }
.hero { padding: 2rem 0 1.5rem; }
.hero h1 { font-size: 2.25rem; margin: 0; }
.hero p { color: var(--muted); font-size: 1.05rem; }
.pagination { display: flex; justify-content: space-between; margin-top: 2.5rem; font-size: 0.875rem; }
footer.site { border-top: 1px solid var(--line); padding-top: 1.25rem; padding-bottom: 2.5rem; color: var(--muted); font-size: 0.8rem; }
:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; border-radius: 2px; }
`;

export const defaultTheme: Theme = defineTheme({
  name: 'barebones',
  css: CSS,
  templates: {
    layout: ({ site, title, description, content }) => html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title ? `${title} — ${site.title}` : site.title}</title>
${description ? html`<meta name="description" content="${description}" />` : ''}
<link rel="stylesheet" href="/theme.css" />
</head>
<body>
<header class="site">
  <a class="brand" href="/">${site.title}</a>
  <nav>
    ${site.nav.map((item) => html`<a href="${item.href}">${item.label}</a>`)}
  </nav>
</header>
<main>${content}</main>
<footer class="site">${site.description}</footer>
</body>
</html>`,

    home: ({ site, homePage, posts, renderBlocks }) =>
      homePage
        ? html`<article>${renderBlocks(homePage.data['body'])}</article>`
        : html`
<div class="hero">
  <h1>${site.title}</h1>
  <p>${site.description}</p>
</div>
<ul class="post-list">
  ${posts.map(
    (post) => html`
  <li>
    <h2><a href="/blog/${post.data['slug']}">${post.data['title']}</a></h2>
    ${post.data['excerpt'] ? html`<p>${post.data['excerpt']}</p>` : ''}
  </li>`,
  )}
</ul>`,

    page: ({ page, renderBlocks }) => html`
<article>
  <h1>${page.data['title']}</h1>
  ${renderBlocks(page.data['body'])}
</article>`,

    post: ({ post }) => html`
<article>
  <h1>${post.data['title']}</h1>
  <p class="meta">${formatDate((post.data['publishDate'] as string) ?? post.publishedAt)}</p>
  ${post.data['coverImageUrl'] ? html`<img src="${post.data['coverImageUrl']}" alt="" />` : ''}
  ${md(post.data['body'])}
  ${Array.isArray(post.data['tags']) && (post.data['tags'] as unknown[]).length > 0
    ? html`<div class="tags">${(post.data['tags'] as string[]).map((t) => html`<span>${t}</span>`)}</div>`
    : ''}
</article>`,

    postList: ({ posts, page, hasMore }) => html`
<h1>Blog</h1>
<ul class="post-list">
  ${posts.map(
    (post) => html`
  <li>
    <h2><a href="/blog/${post.data['slug']}">${post.data['title']}</a></h2>
    <p class="meta">${formatDate((post.data['publishDate'] as string) ?? post.publishedAt)}</p>
    ${post.data['excerpt'] ? html`<p>${post.data['excerpt']}</p>` : ''}
  </li>`,
  )}
</ul>
<div class="pagination">
  <span>${page > 1 ? html`<a href="/blog?page=${page - 1}">&larr; Newer</a>` : ''}</span>
  <span>${hasMore ? html`<a href="/blog?page=${page + 1}">Older &rarr;</a>` : ''}</span>
</div>`,

    notFound: ({ path }) => html`
<h1>Not found</h1>
<p class="meta">Nothing lives at <code>${path}</code>.</p>
<p><a href="/">Back to the front page</a></p>`,
  },

  blocks: {
    prose: (props) => html`${md(props['markdown'])}`,
    hero: (props) => html`
<div class="hero">
  <h1>${props['heading']}</h1>
  ${props['subheading'] ? html`<p>${props['subheading']}</p>` : ''}
  ${props['imageUrl'] ? html`<img src="${props['imageUrl']}" alt="" />` : ''}
</div>`,
    quote: (props) => html`
<blockquote>
  ${props['text']}
  ${props['attribution'] ? html`<footer class="meta">— ${props['attribution']}</footer>` : ''}
</blockquote>`,
  },
});

function formatDate(iso: unknown): string {
  if (typeof iso !== 'string') return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}
