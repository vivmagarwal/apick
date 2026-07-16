import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { del, get, patch, post, RequestError, type CollectionInfo, type FieldDef } from './api.js';
import { Field } from './fields.js';
import { withFlushedMarkdown } from './flush.js';
import { navigate } from './router.js';

/** Slugify a title for slug auto-generation. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** The field a slug should be derived from: title/name/headline, else first required text. */
function titleFieldFor(fields: Record<string, FieldDef>): string | null {
  for (const key of ['title', 'name', 'headline']) {
    if (fields[key]?.type === 'text' && fields[key]?.format !== 'slug') return key;
  }
  for (const [key, def] of Object.entries(fields)) {
    if (def.type === 'text' && def.format !== 'slug' && def.required) return key;
  }
  return null;
}

function slugFieldFor(fields: Record<string, FieldDef>): string | null {
  for (const [key, def] of Object.entries(fields)) if (def.format === 'slug') return key;
  return null;
}

const AUTOSAVE_DELAY_MS = 1500;


interface Doc {
  docId: string;
  version: number;
  publishedVersion: number | null;
  status: string;
  updatedAt: string;
  data: Record<string, unknown>;
}

/** Build the write body from form values: blanks on optional fields vanish. */
function cleanForWrite(fields: Record<string, FieldDef>, values: Record<string, unknown>, mode: 'create' | 'patch'): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(fields)) {
    let v = values[key];
    if (typeof v === 'string' && v === '') v = null;
    if (def.private && (v === null || v === undefined)) continue; // write-only: blank = keep
    if (v === undefined) continue;
    if (v === null) {
      if (mode === 'patch') out[key] = null; // explicit removal
      continue;
    }
    out[key] = v;
  }
  return out;
}

function errorMap(err: unknown): { message: string; fields: Record<string, string> } {
  if (err instanceof RequestError) {
    const fields: Record<string, string> = {};
    const issues = (err.error.details as { issues?: Array<{ path: string; message: string }> } | null)?.issues;
    for (const issue of issues ?? []) fields[issue.path] = issue.message;
    const fieldDetail = (err.error.details as { field?: string } | null)?.field;
    if (fieldDetail) fields[fieldDetail] = err.error.message;
    return { message: err.error.message, fields };
  }
  return { message: String(err), fields: {} };
}

export function DocEditor({ collection, docId, info }: { collection: string; docId: string | null; info: CollectionInfo }): unknown {
  const fields = info.fields ?? {};
  const titleField = titleFieldFor(fields);
  const slugField = slugFieldFor(fields);

  const [values, setValues] = useState<Record<string, unknown>>({});
  const [doc, setDoc] = useState<Doc | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [versions, setVersions] = useState<Array<{ version: number; op: string; createdAt: string }>>([]);
  const [showVersions, setShowVersions] = useState(false);
  const [autosaveState, setAutosaveState] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle');

  // Refs so the debounced autosave sees current data without re-subscribing.
  const savedSnapshot = useRef<string>(''); // JSON of last-persisted draft body
  const slugTouched = useRef(false); // user manually edited the slug
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const valuesRef = useRef(values);
  valuesRef.current = values;

  const load = async () => {
    if (!docId) return;
    const res = await get<{ data: Doc }>(`/v1/collections/${collection}/docs/${docId}?status=draft`);
    setDoc(res.data);
    setValues(res.data.data);
    savedSnapshot.current = JSON.stringify(res.data.data);
    slugTouched.current = !!(slugField && res.data.data[slugField]); // existing slug = leave it alone
    setAutosaveState('idle');
  };
  useEffect(() => {
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    setValues({});
    setDoc(null);
    setError('');
    setFieldErrors({});
    savedSnapshot.current = '';
    slugTouched.current = false;
    setAutosaveState('idle');
    load().catch((e) => setError(String(e)));
  }, [collection, docId]);

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(''), 2500);
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setFieldErrors({});
    try {
      await fn();
    } catch (err) {
      const mapped = errorMap(err);
      setError(mapped.message);
      setFieldErrors(mapped.fields);
    } finally {
      setBusy(false);
    }
  };

  /** Change a field; auto-derive the slug from the title until the slug is touched. */
  const changeField = (name: string, v: unknown) => {
    setValues((prev) => {
      const next = { ...prev, [name]: v };
      if (name === slugField) slugTouched.current = true;
      if (name === titleField && slugField && !slugTouched.current && typeof v === 'string') {
        next[slugField] = slugify(v);
      }
      return next;
    });
    setAutosaveState('dirty');
  };

  // Debounced autosave (existing docs only; never publishes). New docs save on
  // the explicit button so required-field errors surface before anything persists.
  useEffect(() => {
    if (!docId) return;
    if (autosaveState !== 'dirty') return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      const flushed = withFlushedMarkdown(valuesRef.current);
      const body = cleanForWrite(fields, flushed, 'patch');
      const snapshot = JSON.stringify(flushed);
      setAutosaveState('saving');
      patch(`/v1/collections/${collection}/docs/${docId}`, { patch: body })
        .then(() => {
          savedSnapshot.current = snapshot;
          setAutosaveState((s) => (s === 'saving' ? 'saved' : s));
          setFieldErrors({});
        })
        .catch((err) => {
          const mapped = errorMap(err);
          setFieldErrors(mapped.fields);
          setError(mapped.message);
          setAutosaveState('error');
        });
    }, AUTOSAVE_DELAY_MS);
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
  }, [autosaveState, values, docId, collection]);

  // Warn before leaving with unsaved changes (dirty or a pending autosave).
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (autosaveState === 'dirty' || autosaveState === 'saving') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [autosaveState]);

  const save = (publish: boolean) =>
    run(async () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
      const flushed = withFlushedMarkdown(values);
      if (!docId) {
        const body = cleanForWrite(fields, flushed, 'create');
        const res = await post<{ data: Doc }>(`/v1/collections/${collection}/docs`, { data: body, publish });
        flash(publish ? 'Created & published' : 'Draft created');
        navigate(`/admin/c/${collection}/${res.data.docId}`);
      } else {
        const body = cleanForWrite(fields, flushed, 'patch');
        await patch(`/v1/collections/${collection}/docs/${docId}`, { patch: body });
        savedSnapshot.current = JSON.stringify(flushed);
        setAutosaveState('idle');
        if (publish) await post(`/v1/collections/${collection}/docs/${docId}/publish`);
        flash(publish ? 'Saved & published' : 'Draft saved');
        await load();
      }
    });

  const unpublish = () =>
    run(async () => {
      await post(`/v1/collections/${collection}/docs/${docId}/unpublish`);
      flash('Unpublished');
      await load();
    });

  const remove = () =>
    run(async () => {
      if (!confirm('Delete this document? Version history is kept for audit.')) return;
      await del(`/v1/collections/${collection}/docs/${docId}`);
      navigate(`/admin/c/${collection}`);
    });

  const loadVersions = async () => {
    const res = await get<{ data: Array<{ version: number; op: string; createdAt: string }> }>(
      `/v1/collections/${collection}/docs/${docId}/versions`,
    );
    setVersions(res.data);
    setShowVersions(true);
  };

  const restore = (version: number) =>
    run(async () => {
      await post(`/v1/collections/${collection}/docs/${docId}/versions/${version}/restore`);
      flash(`Restored v${version} as a new draft version`);
      setShowVersions(false);
      await load();
    });

  const status = !doc
    ? 'new'
    : doc.publishedVersion === null
      ? 'draft'
      : doc.publishedVersion < doc.version
        ? 'modified'
        : 'published';

  const autosaveLabel: Record<typeof autosaveState, string> = {
    idle: '',
    dirty: 'Unsaved changes',
    saving: 'Saving…',
    saved: 'All changes saved',
    error: 'Autosave failed',
  };

  return html`<div class="editor" data-view="editor">
    <div class="page-head">
      <div>
        <h1>${docId ? 'Edit' : 'New'} <span class="muted">/ ${collection}</span></h1>
        ${doc ? html`<span class=${`status status-${status}`} data-status=${status}>${status}</span>` : ''}
        ${docId && autosaveState !== 'idle'
          ? html`<span class=${`autosave autosave-${autosaveState}`} data-autosave=${autosaveState}>${autosaveLabel[autosaveState]}</span>`
          : ''}
      </div>
      <div class="actions">
        ${docId && html`<button class="btn btn-ghost" onClick=${loadVersions} data-action="versions">History</button>`}
        ${docId && doc?.publishedVersion !== null && doc
          ? html`<button class="btn btn-ghost" disabled=${busy} onClick=${unpublish} data-action="unpublish">Unpublish</button>`
          : ''}
        ${docId && html`<button class="btn btn-danger-ghost" disabled=${busy} onClick=${remove} data-action="delete">Delete</button>`}
        <button class="btn" disabled=${busy} onClick=${() => save(false)} data-action="save">Save draft</button>
        <button class="btn btn-primary" disabled=${busy} onClick=${() => save(true)} data-action="publish">
          ${docId ? 'Save & publish' : 'Create & publish'}
        </button>
      </div>
    </div>

    ${notice && html`<div class="notice" data-notice>${notice}</div>`}
    ${error && html`<div class="error-banner" data-error>${error}</div>`}

    <form class="doc-form" onSubmit=${(e: Event) => e.preventDefault()}>
      ${Object.entries(fields).map(
        ([name, def]) => html`<${Field} name=${name} path=${name} def=${def} value=${values[name]} errors=${fieldErrors}
          onChange=${(v: unknown) => changeField(name, v)} />`,
      )}
    </form>

    ${showVersions &&
    html`<div class="drawer" data-view="versions">
      <div class="drawer-head">
        <h2>History</h2>
        <button class="btn btn-ghost" onClick=${() => setShowVersions(false)}>✕</button>
      </div>
      <table class="table">
        <thead><tr><th>v</th><th>op</th><th>when</th><th></th></tr></thead>
        <tbody>
          ${versions.map(
            (v) => html`<tr>
              <td>v${v.version}</td>
              <td>${v.op}</td>
              <td>${new Date(v.createdAt).toLocaleString()}</td>
              <td>
                ${v.version !== doc?.version
                  ? html`<button class="btn btn-small" data-restore=${v.version} onClick=${() => restore(v.version)}>Restore</button>`
                  : html`<span class="muted">current</span>`}
              </td>
            </tr>`,
          )}
        </tbody>
      </table>
    </div>`}
  </div>`;
}
