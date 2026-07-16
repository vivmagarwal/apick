import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { del, get, patch, post, setToken, RequestError, type CollectionInfo, type Me } from './api.js';
import { navigate } from './router.js';


function useAsyncError(): [string, (err: unknown) => void, () => void] {
  const [error, setError] = useState('');
  return [error, (err: unknown) => setError(err instanceof RequestError ? err.error.message : String(err)), () => setError('')];
}

// ---- auth screens -------------------------------------------------------------

export function Login({ onAuthed }: { onAuthed: () => void }): unknown {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, showError] = useAsyncError();
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await post<{ data: { token: string } }>('/admin/api/login', { email, password });
      setToken(res.data.token);
      onAuthed();
      navigate('/admin');
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  return html`<div class="auth-screen" data-view="login">
    <form class="auth-card" onSubmit=${submit}>
      <div class="auth-brand">APIck <span>Admin</span></div>
      <h1>Sign in</h1>
      ${error && html`<div class="error-banner" data-error>${error}</div>`}
      <label>Email
        <input data-input="email" type="email" required value=${email}
          onInput=${(e: InputEvent) => setEmail((e.target as HTMLInputElement).value)} />
      </label>
      <label>Password
        <input data-input="password" type="password" required value=${password}
          onInput=${(e: InputEvent) => setPassword((e.target as HTMLInputElement).value)} />
      </label>
      <button class="btn btn-primary btn-block" disabled=${busy} data-action="login">Sign in</button>
    </form>
  </div>`;
}

export function Setup({ onAuthed }: { onAuthed: () => void }): unknown {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, showError] = useAsyncError();
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await post<{ data: { token: string } }>('/admin/api/setup', { name, email, password });
      setToken(res.data.token);
      onAuthed();
      navigate('/admin');
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  return html`<div class="auth-screen" data-view="setup">
    <form class="auth-card" onSubmit=${submit}>
      <div class="auth-brand">APIck <span>Admin</span></div>
      <h1>Welcome — create your admin account</h1>
      <p class="muted">This install has no users yet. This account gets the admin role.</p>
      ${error && html`<div class="error-banner" data-error>${error}</div>`}
      <label>Your name
        <input data-input="name" type="text" required value=${name}
          onInput=${(e: InputEvent) => setName((e.target as HTMLInputElement).value)} />
      </label>
      <label>Email
        <input data-input="email" type="email" required value=${email}
          onInput=${(e: InputEvent) => setEmail((e.target as HTMLInputElement).value)} />
      </label>
      <label>Password <span class="muted">(min 10 characters)</span>
        <input data-input="password" type="password" required value=${password}
          onInput=${(e: InputEvent) => setPassword((e.target as HTMLInputElement).value)} />
      </label>
      <button class="btn btn-primary btn-block" disabled=${busy} data-action="setup">Create account</button>
    </form>
  </div>`;
}

// ---- dashboard -------------------------------------------------------------------

export function Dashboard({ collections, me }: { collections: CollectionInfo[]; me: Me }): unknown {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [events, setEvents] = useState<Array<{ type: string; subject: Record<string, unknown>; created_at: string }>>([]);

  useEffect(() => {
    (async () => {
      const next: Record<string, number> = {};
      for (const col of collections) {
        try {
          const res = await get<{ meta: { total?: number } }>(
            `/v1/collections/${col.key}/docs?status=draft&pageSize=1&count=true`,
          );
          next[col.key] = res.meta.total ?? 0;
        } catch {
          /* not readable */
        }
      }
      setCounts(next);
      try {
        const res = await get<{ data: typeof events }>('/v1/events?types=doc.created,doc.updated,doc.published,doc.deleted&limit=200');
        setEvents(res.data.slice(-8).reverse());
      } catch {
        /* editors can't read events — fine */
      }
    })();
  }, [collections]);

  return html`<div data-view="dashboard">
    <div class="page-head"><h1>Welcome back, ${me.name.split(' ')[0]}</h1></div>
    <div class="cards">
      ${collections.map(
        (col) => html`<a class="card" href=${`/admin/c/${col.key}`} data-card=${col.key}>
          <div class="card-number">${counts[col.key] ?? '…'}</div>
          <div class="card-label">${col.key}</div>
        </a>`,
      )}
    </div>
    ${events.length > 0 &&
    html`<h2 class="section-title">Recent activity</h2>
    <table class="table">
      <tbody>
        ${events.map(
          (ev) => html`<tr>
            <td><span class="status">${ev.type.replace('doc.', '')}</span></td>
            <td>${String(ev.subject['collection'] ?? '')}</td>
            <td class="muted">${new Date(ev.created_at).toLocaleString()}</td>
          </tr>`,
        )}
      </tbody>
    </table>`}
  </div>`;
}

// ---- users ------------------------------------------------------------------------

interface CmsUser {
  docId: string;
  email: string;
  name: string;
  role: string;
  createdAt: string;
}

export function UsersPage({ me }: { me: Me }): unknown {
  const [users, setUsers] = useState<CmsUser[]>([]);
  const [error, showError, clearError] = useAsyncError();
  const [form, setForm] = useState<{ docId?: string; name: string; email: string; role: string; password: string } | null>(null);

  const load = () =>
    get<{ data: CmsUser[] }>('/admin/api/users')
      .then((res) => setUsers(res.data))
      .catch(showError);
  useEffect(() => {
    load();
  }, []);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!form) return;
    clearError();
    try {
      if (form.docId) {
        await patch(`/admin/api/users/${form.docId}`, {
          name: form.name,
          email: form.email,
          role: form.role,
          ...(form.password ? { password: form.password } : {}),
        });
      } else {
        await post('/admin/api/users', form);
      }
      setForm(null);
      await load();
    } catch (err) {
      showError(err);
    }
  };

  const remove = async (user: CmsUser) => {
    if (!confirm(`Delete ${user.email}?`)) return;
    clearError();
    try {
      await del(`/admin/api/users/${user.docId}`);
      await load();
    } catch (err) {
      showError(err);
    }
  };

  return html`<div data-view="users">
    <div class="page-head">
      <h1>Users</h1>
      <button class="btn btn-primary" data-action="new-user"
        onClick=${() => setForm({ name: '', email: '', role: 'editor', password: '' })}>+ New user</button>
    </div>
    ${error && html`<div class="error-banner" data-error>${error}</div>`}
    <table class="table" data-table="users">
      <thead><tr><th>name</th><th>email</th><th>role</th><th></th></tr></thead>
      <tbody>
        ${users.map(
          (user) => html`<tr data-user=${user.email}>
            <td>${user.name}</td>
            <td>${user.email}</td>
            <td><span class="status">${user.role}</span></td>
            <td class="row-actions">
              <button class="btn btn-small" data-action="edit-user"
                onClick=${() => setForm({ docId: user.docId, name: user.name, email: user.email, role: user.role, password: '' })}>Edit</button>
              ${user.docId !== me.docId &&
              html`<button class="btn btn-small btn-danger-ghost" data-action="delete-user" onClick=${() => remove(user)}>Delete</button>`}
            </td>
          </tr>`,
        )}
      </tbody>
    </table>
    ${form &&
    html`<div class="drawer" data-view="user-form">
      <div class="drawer-head">
        <h2>${form.docId ? 'Edit user' : 'New user'}</h2>
        <button class="btn btn-ghost" onClick=${() => setForm(null)}>✕</button>
      </div>
      <form onSubmit=${submit}>
        <div class="field"><label>Name</label>
          <input data-input="user-name" required value=${form.name}
            onInput=${(e: InputEvent) => setForm({ ...form, name: (e.target as HTMLInputElement).value })} /></div>
        <div class="field"><label>Email</label>
          <input data-input="user-email" type="email" required value=${form.email}
            onInput=${(e: InputEvent) => setForm({ ...form, email: (e.target as HTMLInputElement).value })} /></div>
        <div class="field"><label>Role</label>
          <select data-input="user-role" value=${form.role}
            onChange=${(e: Event) => setForm({ ...form, role: (e.target as HTMLSelectElement).value })}>
            <option value="admin" selected=${form.role === 'admin'}>admin — everything</option>
            <option value="editor" selected=${form.role === 'editor'}>editor — content only</option>
            <option value="viewer" selected=${form.role === 'viewer'}>viewer — read only</option>
          </select></div>
        <div class="field"><label>${form.docId ? 'New password (blank = unchanged)' : 'Password (min 10 chars)'}</label>
          <input data-input="user-password" type="password" value=${form.password}
            onInput=${(e: InputEvent) => setForm({ ...form, password: (e.target as HTMLInputElement).value })} /></div>
        <button class="btn btn-primary" data-action="save-user">${form.docId ? 'Save' : 'Create'}</button>
      </form>
    </div>`}
  </div>`;
}

// ---- API keys ---------------------------------------------------------------------

export function KeysPage(): unknown {
  const [keys, setKeys] = useState<Array<{ id: string; prefix: string; label: string; principal_name: string; revoked_at: string | null; last_used_at: string | null }>>([]);
  const [error, showError, clearError] = useAsyncError();
  const [created, setCreated] = useState<{ token: string } | null>(null);
  const [form, setForm] = useState<{ name: string; role: string } | null>(null);

  const load = () =>
    get<{ data: typeof keys }>('/v1/keys')
      .then((res) => setKeys(res.data))
      .catch(showError);
  useEffect(() => {
    load();
  }, []);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!form) return;
    clearError();
    try {
      const res = await post<{ data: { token: string } }>('/v1/keys', form);
      setCreated({ token: res.data.token });
      setForm(null);
      await load();
    } catch (err) {
      showError(err);
    }
  };

  const revoke = async (id: string) => {
    if (!confirm('Revoke this key? Anything using it stops working within seconds.')) return;
    try {
      await del(`/v1/keys/${id}`);
      await load();
    } catch (err) {
      showError(err);
    }
  };

  return html`<div data-view="keys">
    <div class="page-head">
      <h1>API keys</h1>
      <button class="btn btn-primary" data-action="new-key" onClick=${() => setForm({ name: '', role: 'content-editor' })}>+ New key</button>
    </div>
    <p class="muted">Keys are for services and AI agents — the same permissions system as everything else. MCP endpoint: <code>/mcp</code></p>
    ${error && html`<div class="error-banner" data-error>${error}</div>`}
    ${created &&
    html`<div class="notice" data-view="created-key">
      Copy this token now — it is shown once:
      <code class="token" data-token>${created.token}</code>
      <button class="btn btn-small" onClick=${() => setCreated(null)}>Done</button>
    </div>`}
    <table class="table">
      <thead><tr><th>label / service</th><th>prefix</th><th>last used</th><th></th></tr></thead>
      <tbody>
        ${keys.map(
          (key) => html`<tr>
            <td>${key.label || key.principal_name}</td>
            <td><code>${key.prefix}…</code></td>
            <td class="muted">${key.last_used_at ? new Date(key.last_used_at).toLocaleString() : 'never'}</td>
            <td class="row-actions">
              ${key.revoked_at
                ? html`<span class="status">revoked</span>`
                : html`<button class="btn btn-small btn-danger-ghost" onClick=${() => revoke(key.id)}>Revoke</button>`}
            </td>
          </tr>`,
        )}
      </tbody>
    </table>
    ${form &&
    html`<div class="drawer">
      <div class="drawer-head"><h2>New API key</h2>
        <button class="btn btn-ghost" onClick=${() => setForm(null)}>✕</button></div>
      <form onSubmit=${submit}>
        <div class="field"><label>Name (what will use it?)</label>
          <input data-input="key-name" required value=${form.name}
            onInput=${(e: InputEvent) => setForm({ ...form, name: (e.target as HTMLInputElement).value })} /></div>
        <div class="field"><label>Role</label>
          <select data-input="key-role" value=${form.role} onChange=${(e: Event) => setForm({ ...form, role: (e.target as HTMLSelectElement).value })}>
            <option value="content-reader">content-reader — read published</option>
            <option value="content-editor" selected>content-editor — full content CRUD</option>
            <option value="cms-editor">cms-editor — content CRUD except users</option>
            <option value="tenant-admin">tenant-admin — content + settings</option>
          </select></div>
        <button class="btn btn-primary" data-action="create-key">Create key</button>
      </form>
    </div>`}
  </div>`;
}

// ---- webhooks -----------------------------------------------------------------------

export function WebhooksPage(): unknown {
  const [hooks, setHooks] = useState<Array<{ id: string; name: string; url: string; events: string[]; enabled: boolean }>>([]);
  const [error, showError, clearError] = useAsyncError();
  const [created, setCreated] = useState<string | null>(null);
  const [form, setForm] = useState<{ name: string; url: string; events: string } | null>(null);
  const [deliveries, setDeliveries] = useState<{ hookId: string; rows: Array<{ state: string; attempts: number; last_status: number | null; created_at: string }> } | null>(null);

  const load = () =>
    get<{ data: typeof hooks }>('/v1/webhooks')
      .then((res) => setHooks(res.data))
      .catch(showError);
  useEffect(() => {
    load();
  }, []);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!form) return;
    clearError();
    try {
      const res = await post<{ data: { secret: string } }>('/v1/webhooks', {
        name: form.name,
        url: form.url,
        events: form.events.split(',').map((s) => s.trim()).filter(Boolean),
      });
      setCreated(res.data.secret);
      setForm(null);
      await load();
    } catch (err) {
      showError(err);
    }
  };

  return html`<div data-view="webhooks">
    <div class="page-head">
      <h1>Webhooks</h1>
      <button class="btn btn-primary" data-action="new-webhook" onClick=${() => setForm({ name: '', url: '', events: 'doc.published' })}>+ New webhook</button>
    </div>
    ${error && html`<div class="error-banner" data-error>${error}</div>`}
    ${created &&
    html`<div class="notice">Signing secret (shown once): <code class="token">${created}</code>
      <button class="btn btn-small" onClick=${() => setCreated(null)}>Done</button></div>`}
    <table class="table">
      <thead><tr><th>name</th><th>url</th><th>events</th><th>status</th><th></th></tr></thead>
      <tbody>
        ${hooks.map(
          (hook) => html`<tr>
            <td>${hook.name}</td>
            <td class="muted">${hook.url}</td>
            <td class="muted">${hook.events.join(', ')}</td>
            <td><span class="status">${hook.enabled ? 'enabled' : 'disabled'}</span></td>
            <td class="row-actions">
              <button class="btn btn-small" onClick=${async () => {
                const res = await get<{ data: NonNullable<typeof deliveries>['rows'] }>(`/v1/webhooks/${hook.id}/deliveries`);
                setDeliveries({ hookId: hook.id, rows: res.data });
              }}>Deliveries</button>
              <button class="btn btn-small" onClick=${async () => {
                await patch(`/v1/webhooks/${hook.id}`, { enabled: !hook.enabled });
                await load();
              }}>${hook.enabled ? 'Disable' : 'Enable'}</button>
              <button class="btn btn-small btn-danger-ghost" onClick=${async () => {
                if (confirm('Delete webhook?')) {
                  await del(`/v1/webhooks/${hook.id}`);
                  await load();
                }
              }}>Delete</button>
            </td>
          </tr>`,
        )}
      </tbody>
    </table>
    ${deliveries &&
    html`<div class="drawer">
      <div class="drawer-head"><h2>Deliveries</h2>
        <button class="btn btn-ghost" onClick=${() => setDeliveries(null)}>✕</button></div>
      <table class="table">
        <thead><tr><th>state</th><th>attempts</th><th>status</th><th>when</th></tr></thead>
        <tbody>
          ${deliveries.rows.map(
            (d) => html`<tr><td><span class="status">${d.state}</span></td><td>${d.attempts}</td>
              <td>${d.last_status ?? '—'}</td><td class="muted">${new Date(d.created_at).toLocaleString()}</td></tr>`,
          )}
        </tbody>
      </table>
    </div>`}
    ${form &&
    html`<div class="drawer">
      <div class="drawer-head"><h2>New webhook</h2>
        <button class="btn btn-ghost" onClick=${() => setForm(null)}>✕</button></div>
      <form onSubmit=${submit}>
        <div class="field"><label>Name</label>
          <input data-input="webhook-name" required value=${form.name}
            onInput=${(e: InputEvent) => setForm({ ...form, name: (e.target as HTMLInputElement).value })} /></div>
        <div class="field"><label>URL</label>
          <input data-input="webhook-url" type="url" required value=${form.url}
            onInput=${(e: InputEvent) => setForm({ ...form, url: (e.target as HTMLInputElement).value })} /></div>
        <div class="field"><label>Events (comma-separated: *, doc.*, doc.published:posts)</label>
          <input data-input="webhook-events" value=${form.events}
            onInput=${(e: InputEvent) => setForm({ ...form, events: (e.target as HTMLInputElement).value })} /></div>
        <button class="btn btn-primary" data-action="create-webhook">Create webhook</button>
      </form>
    </div>`}
  </div>`;
}
