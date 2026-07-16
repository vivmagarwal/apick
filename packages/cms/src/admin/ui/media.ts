import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { del, get, getToken, RequestError } from './api.js';

/**
 * The media library: upload, browse, pick, delete. Uploads POST multipart to
 * /admin/api/media (which stores bytes + a `media` metadata doc); everything
 * is served from /media/:docId/:filename.
 */

export interface MediaItem {
  docId: string;
  url: string;
  filename: string;
  mime: string;
  size: number;
  alt: string;
}

function isImage(mime: string): boolean {
  return mime.startsWith('image/');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** POST a file to the media endpoint; returns the created item. */
export async function uploadFile(file: File, alt = ''): Promise<MediaItem> {
  const body = new FormData();
  body.set('file', file);
  if (alt) body.set('alt', alt);
  const token = getToken();
  const res = await fetch('/admin/api/media', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new RequestError(res.status, json?.error ?? { code: 'error', message: `HTTP ${res.status}`, details: null });
  return json.data as MediaItem;
}

async function listMedia(page: number, pageSize: number): Promise<{ items: MediaItem[]; total: number }> {
  const res = await get<{ data: Array<{ docId: string; data: MediaItem & { blobKey: string } }>; meta: { total?: number } }>(
    `/v1/collections/media/docs?status=draft&sort=-createdAt&page=${page}&pageSize=${pageSize}&count=true`,
  );
  return {
    items: res.data.map((d) => ({
      docId: d.docId,
      url: `/media/${d.docId}/${encodeURIComponent(d.data.filename)}`,
      filename: d.data.filename,
      mime: d.data.mime,
      size: d.data.size,
      alt: d.data.alt ?? '',
    })),
    total: res.meta.total ?? res.data.length,
  };
}

const PAGE_SIZE = 24;

/** Shared grid used by both the full page and the picker modal. */
function MediaGrid({
  onPick,
  selectable,
  refreshKey,
}: {
  onPick?: (item: MediaItem) => void;
  selectable: boolean;
  refreshKey: number;
}): unknown {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');

  const reload = () =>
    listMedia(page, PAGE_SIZE)
      .then(({ items, total }) => {
        setItems(items);
        setTotal(total);
        setError('');
      })
      .catch((e) => setError(String(e)));
  useEffect(() => {
    reload();
  }, [page, refreshKey]);

  const remove = async (item: MediaItem, e: Event) => {
    e.stopPropagation();
    if (!confirm(`Delete ${item.filename}? References to it will break.`)) return;
    try {
      await del(`/admin/api/media/${item.docId}`);
      reload();
    } catch (err) {
      setError(err instanceof RequestError ? err.error.message : String(err));
    }
  };

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return html`<div>
    ${error && html`<div class="error-banner">${error}</div>`}
    <div class="media-grid" data-media-grid>
      ${items.map(
        (item) => html`<div class=${`media-tile${selectable ? ' selectable' : ''}`} data-media=${item.filename}
          onClick=${() => onPick?.(item)}>
          <div class="media-thumb">
            ${isImage(item.mime)
              ? html`<img src=${item.url} alt=${item.alt} loading="lazy" />`
              : html`<div class="media-file-icon">${item.mime.split('/')[1]?.slice(0, 4).toUpperCase() ?? 'FILE'}</div>`}
          </div>
          <div class="media-meta">
            <div class="media-name" title=${item.filename}>${item.filename}</div>
            <div class="media-sub">${formatBytes(item.size)}</div>
          </div>
          <button type="button" class="media-del" title="Delete" data-action="delete-media" onClick=${(e: Event) => remove(item, e)}>✕</button>
        </div>`,
      )}
      ${items.length === 0 && html`<div class="empty media-empty">No files yet — upload one above.</div>`}
    </div>
    ${pages > 1 &&
    html`<div class="pager">
      <button class="btn btn-small" disabled=${page <= 1} onClick=${() => setPage(page - 1)}>← Prev</button>
      <span class="muted">page ${page} / ${pages}</span>
      <button class="btn btn-small" disabled=${page >= pages} onClick=${() => setPage(page + 1)}>Next →</button>
    </div>`}
  </div>`;
}

function UploadZone({ onUploaded, accept }: { onUploaded: () => void; accept?: string }): unknown {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [drag, setDrag] = useState(false);

  const doUpload = async (files: FileList | File[]) => {
    setBusy(true);
    setError('');
    try {
      for (const file of Array.from(files)) await uploadFile(file);
      onUploaded();
    } catch (err) {
      setError(err instanceof RequestError ? err.error.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return html`<div>
    <div class=${`upload-zone${drag ? ' dragging' : ''}`} data-upload-zone
      onClick=${() => inputRef.current?.click()}
      onDragOver=${(e: DragEvent) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave=${() => setDrag(false)}
      onDrop=${(e: DragEvent) => {
        e.preventDefault();
        setDrag(false);
        if (e.dataTransfer?.files.length) doUpload(e.dataTransfer.files);
      }}>
      <input ref=${inputRef} type="file" multiple accept=${accept ?? ''} data-input="media-file" style="display:none"
        onChange=${(e: Event) => {
          const files = (e.target as HTMLInputElement).files;
          if (files?.length) doUpload(files);
          (e.target as HTMLInputElement).value = '';
        }} />
      ${busy ? html`<span>Uploading…</span>` : html`<span><strong>Click to upload</strong> or drag files here</span>`}
    </div>
    ${error && html`<div class="field-error">${error}</div>`}
  </div>`;
}

export function MediaPage(): unknown {
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = () => setRefreshKey((k) => k + 1);
  return html`<div data-view="media">
    <div class="page-head"><h1>Media</h1></div>
    <${UploadZone} onUploaded=${bump} />
    <${MediaGrid} selectable=${false} refreshKey=${refreshKey} />
  </div>`;
}

/** Modal picker used by image fields. */
export function MediaPicker({ onPick, onClose }: { onPick: (item: MediaItem) => void; onClose: () => void }): unknown {
  const [refreshKey, setRefreshKey] = useState(0);
  return html`<div class="modal-backdrop" data-view="media-picker" onClick=${onClose}>
    <div class="modal" onClick=${(e: Event) => e.stopPropagation()}>
      <div class="drawer-head">
        <h2>Choose media</h2>
        <button class="btn btn-ghost" onClick=${onClose}>✕</button>
      </div>
      <${UploadZone} accept="image/*" onUploaded=${() => setRefreshKey((k) => k + 1)} />
      <${MediaGrid} selectable=${true} refreshKey=${refreshKey} onPick=${(item: MediaItem) => onPick(item)} />
    </div>
  </div>`;
}
