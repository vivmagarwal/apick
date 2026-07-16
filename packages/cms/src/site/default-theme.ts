import { html } from './html.js';
import { defineTheme, md, type Theme } from './theme.js';

/**
 * "Quiet" — the default theme. Editorial, fast, no JavaScript, dark-mode
 * aware. Deliberately restrained so real sites replace or extend it.
 */

const CSS = `
:root {
  --bg: #faf9f7; --fg: #1c1b1a; --muted: #6f6a63; --accent: #c73e1d;
  --line: #e5e1da; --card: #ffffff; --max: 44rem;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #171614; --fg: #ece9e4; --muted: #98928a; --accent: #ff6b45; --line: #2c2a27; --card: #1f1e1b; }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 17px/1.7 ui-serif, Georgia, 'Times New Roman', serif;
  -webkit-font-smoothing: antialiased;
}
header.site, main, footer.site { max-width: var(--max); margin: 0 auto; padding: 0 1.25rem; }
header.site {
  display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap;
  gap: 0.5rem 1.5rem; padding-top: 2.5rem; padding-bottom: 1.5rem; border-bottom: 1px solid var(--line);
  font-family: ui-sans-serif, system-ui, sans-serif;
}
header.site .brand { font-weight: 700; font-size: 1.05rem; letter-spacing: -0.01em; color: var(--fg); text-decoration: none; }
header.site nav { display: flex; gap: 1.1rem; }
header.site nav a { color: var(--muted); text-decoration: none; font-size: 0.9rem; }
header.site nav a:hover { color: var(--accent); }
main { padding-top: 2.5rem; padding-bottom: 4rem; min-height: 60vh; }
h1, h2, h3 { font-family: ui-sans-serif, system-ui, sans-serif; letter-spacing: -0.02em; line-height: 1.25; }
h1 { font-size: 2rem; margin: 0 0 0.5rem; }
a { color: var(--accent); }
img { max-width: 100%; border-radius: 6px; }
pre { background: var(--card); border: 1px solid var(--line); padding: 1rem; border-radius: 8px; overflow-x: auto; font-size: 0.85em; }
code { font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 0.9em; }
blockquote { margin: 1.5rem 0; padding: 0.25rem 0 0.25rem 1.25rem; border-left: 3px solid var(--accent); color: var(--muted); font-style: italic; }
.meta { color: var(--muted); font-size: 0.85rem; font-family: ui-sans-serif, system-ui, sans-serif; }
.post-list { list-style: none; padding: 0; margin: 0; }
.post-list li { padding: 1.4rem 0; border-bottom: 1px solid var(--line); }
.post-list h2 { margin: 0 0 0.25rem; font-size: 1.25rem; }
.post-list h2 a { color: var(--fg); text-decoration: none; }
.post-list h2 a:hover { color: var(--accent); }
.post-list p { margin: 0.35rem 0 0; color: var(--muted); font-size: 0.95rem; }
.tags { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-top: 0.6rem; }
.tags span { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 0.72rem; background: var(--card); border: 1px solid var(--line); border-radius: 99px; padding: 0.1rem 0.6rem; color: var(--muted); }
.hero { padding: 3rem 0 2rem; }
.hero h1 { font-size: 2.6rem; margin: 0; }
.hero p { color: var(--muted); font-size: 1.1rem; font-family: ui-sans-serif, system-ui, sans-serif; }
.pagination { display: flex; justify-content: space-between; margin-top: 2rem; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 0.9rem; }
footer.site { border-top: 1px solid var(--line); padding-top: 1.25rem; padding-bottom: 2.5rem; color: var(--muted); font-size: 0.8rem; font-family: ui-sans-serif, system-ui, sans-serif; }
`;

export const defaultTheme: Theme = defineTheme({
  name: 'quiet',
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
