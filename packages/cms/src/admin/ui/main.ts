import { h, render, type ComponentType } from 'preact';
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { clearToken, fetchMe, fetchStatus, getToken, loadCollections, type AdminStatus, type CollectionInfo, type Me } from './api.js';
import { currentPath, navigate, onRouteChange } from './router.js';
import { Login, Setup, Dashboard, UsersPage, KeysPage, WebhooksPage } from './pages.js';
import { CollectionListing } from './listing.js';
import { MediaPage } from './media.js';
import { DocEditor } from './editor.js';

const HIDDEN_COLLECTIONS = new Set(['cms-users', 'media']);

function Shell({ me, status, collections, children }: { me: Me; status: AdminStatus; collections: CollectionInfo[]; children: unknown }): unknown {
  const path = currentPath();
  const contentCollections = collections.filter((c) => !HIDDEN_COLLECTIONS.has(c.key));
  const isAdmin = me.role === 'admin';
  const active = (href: string) => (path === href || (href !== '/admin' && path.startsWith(href)) ? 'active' : '');

  return html`<div class="shell">
    <aside class="sidebar">
      <div class="sidebar-brand">
        <span class="logo">APIck</span>
        <span class="site-name">${status.site.title}</span>
      </div>
      <nav>
        <div class="nav-section">General</div>
        <a class=${active('/admin')} href="/admin" data-nav="dashboard">Dashboard</a>
        <div class="nav-section">Content</div>
        ${contentCollections.map(
          (col) => html`<a class=${active(`/admin/c/${col.key}`)} href=${`/admin/c/${col.key}`} data-nav=${col.key}>${col.key}</a>`,
        )}
        ${collections.some((c) => c.key === 'media')
          ? html`<a class=${active('/admin/media')} href="/admin/media" data-nav="media">Media</a>`
          : ''}
        ${isAdmin &&
        html`<div class="nav-section">Settings</div>
          <a class=${active('/admin/users')} href="/admin/users" data-nav="users">Users</a>
          <a class=${active('/admin/keys')} href="/admin/keys" data-nav="keys">API keys</a>
          <a class=${active('/admin/webhooks')} href="/admin/webhooks" data-nav="webhooks">Webhooks</a>`}
        ${status.adminNav.length > 0 &&
        html`<div class="nav-section">Plugins</div>
          ${status.adminNav.map((item) => html`<a href=${item.href} data-external>${item.label}</a>`)}`}
      </nav>
      <div class="sidebar-footer">
        <a href="/" target="_blank" data-external>View site ↗</a>
        <div class="whoami">
          <span title=${me.email}>${me.name}</span>
          <button class="btn btn-ghost" data-action="logout" onClick=${() => {
            clearToken();
            window.location.href = '/admin/login';
          }}>Sign out</button>
        </div>
      </div>
    </aside>
    <section class="content">${children}</section>
  </div>`;
}

function App(): unknown {
  const [, setTick] = useState(0);
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [collections, setCollections] = useState<CollectionInfo[] | null>(null);
  const [ready, setReady] = useState(false);

  const refreshSession = async () => {
    const nextStatus = await fetchStatus();
    setStatus(nextStatus);
    const nextMe = await fetchMe();
    setMe(nextMe);
    if (nextMe) setCollections(await loadCollections(true));
    setReady(true);
  };

  useEffect(() => {
    const off = onRouteChange(() => setTick((t) => t + 1));
    refreshSession().catch(() => setReady(true));
    return off;
  }, []);

  if (!ready || !status) return html`<div class="boot">Loading…</div>`;

  const path = currentPath();
  if (status.needsSetup) return html`<${Setup} onAuthed=${refreshSession} />`;
  if (!me || !getToken()) {
    if (path !== '/admin/login') history.replaceState(null, '', '/admin/login');
    return html`<${Login} onAuthed=${refreshSession} />`;
  }
  if (path === '/admin/login' || path === '/admin/setup') {
    history.replaceState(null, '', '/admin');
  }

  const cols = collections ?? [];
  let view: unknown;
  const editorMatch = path.match(/^\/admin\/c\/([a-z0-9_-]+)\/(new|[0-9a-f-]{36})$/);
  const listMatch = path.match(/^\/admin\/c\/([a-z0-9_-]+)$/);
  if (editorMatch) {
    const info = cols.find((c) => c.key === editorMatch[1]);
    view = info
      ? html`<${DocEditor} collection=${editorMatch[1]} docId=${editorMatch[2] === 'new' ? null : editorMatch[2]} info=${info} />`
      : html`<div class="error-banner">Unknown collection</div>`;
  } else if (listMatch) {
    const info = cols.find((c) => c.key === listMatch[1]);
    view = info
      ? html`<${CollectionListing} collection=${listMatch[1]} info=${info} />`
      : html`<div class="error-banner">Unknown collection</div>`;
  } else if (path === '/admin/media') {
    view = html`<${MediaPage} />`;
  } else if (path === '/admin/users') {
    view = html`<${UsersPage} me=${me} />`;
  } else if (path === '/admin/keys') {
    view = html`<${KeysPage} />`;
  } else if (path === '/admin/webhooks') {
    view = html`<${WebhooksPage} />`;
  } else {
    view = html`<${Dashboard} collections=${cols.filter((c) => !HIDDEN_COLLECTIONS.has(c.key))} me=${me} />`;
  }

  return html`<${Shell} me=${me} status=${status} collections=${cols}>${view}<//>`;
}

render(h(App as ComponentType, {}), document.getElementById('app')!);
