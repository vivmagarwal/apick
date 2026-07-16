import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { get, labelField, type CollectionInfo, type FieldDef } from './api.js';
import { navigate } from './router.js';


interface Row {
  docId: string;
  version: number;
  publishedVersion: number | null;
  updatedAt: string;
  data: Record<string, unknown>;
}

const PAGE_SIZE = 20;

/** Pick up to three presentable scalar columns from the schema. */
function columnsFor(fields: Record<string, FieldDef> | null): string[] {
  if (!fields) return [];
  const scalars = Object.entries(fields)
    .filter(([, def]) => !def.private && ['text', 'enum', 'integer', 'number', 'boolean', 'datetime', 'date'].includes(def.type))
    .map(([key]) => key);
  return scalars.slice(0, 3);
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  const text = String(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

function statusOf(row: Row): 'draft' | 'modified' | 'published' {
  if (row.publishedVersion === null) return 'draft';
  return row.publishedVersion < row.version ? 'modified' : 'published';
}

export function CollectionListing({ collection, info }: { collection: string; info: CollectionInfo }): unknown {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const columns = columnsFor(info.fields);
  const searchField = labelField(info.fields);

  useEffect(() => {
    setPage(1);
    setSearch('');
  }, [collection]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const params = new URLSearchParams({
          status: 'draft',
          page: String(page),
          pageSize: String(PAGE_SIZE),
          count: 'true',
          sort: '-updatedAt',
        });
        if (search && searchField) {
          params.set('filter', JSON.stringify({ [searchField]: { $icontains: search } }));
        }
        const res = await get<{ data: Row[]; meta: { total?: number } }>(`/v1/collections/${collection}/docs?${params}`);
        if (!alive) return;
        setRows(res.data);
        setTotal(res.meta.total ?? res.data.length);
        setError('');
      } catch (err) {
        if (alive) setError(String(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, [collection, page, search]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return html`<div data-view="listing">
    <div class="page-head">
      <h1>${collection} <span class="muted">${total}</span></h1>
      <div class="actions">
        ${searchField &&
        html`<input class="search" type="search" placeholder=${`Search ${searchField}…`} value=${search}
          onInput=${(e: InputEvent) => {
            setSearch((e.target as HTMLInputElement).value);
            setPage(1);
          }} />`}
        ${info.fields &&
        html`<button class="btn btn-primary" data-action="new" onClick=${() => navigate(`/admin/c/${collection}/new`)}>
          + New
        </button>`}
      </div>
    </div>
    ${error && html`<div class="error-banner">${error}</div>`}
    <table class="table table-hover" data-table=${collection}>
      <thead>
        <tr>
          ${columns.map((col) => html`<th>${col}</th>`)}
          <th>status</th>
          <th>updated</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => {
          const status = statusOf(row);
          return html`<tr data-doc=${row.docId} onClick=${() => navigate(`/admin/c/${collection}/${row.docId}`)}>
            ${columns.map((col) => html`<td>${cell(row.data[col])}</td>`)}
            <td><span class=${`status status-${status}`}>${status}</span></td>
            <td class="muted">${new Date(row.updatedAt).toLocaleDateString()}</td>
          </tr>`;
        })}
        ${rows.length === 0 && html`<tr><td colspan=${columns.length + 2} class="empty">Nothing here yet.</td></tr>`}
      </tbody>
    </table>
    ${pages > 1 &&
    html`<div class="pager">
      <button class="btn btn-small" disabled=${page <= 1} onClick=${() => setPage(page - 1)}>← Prev</button>
      <span class="muted">page ${page} / ${pages}</span>
      <button class="btn btn-small" disabled=${page >= pages} onClick=${() => setPage(page + 1)}>Next →</button>
    </div>`}
  </div>`;
}
