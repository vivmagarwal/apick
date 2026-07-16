import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { EdodoWrite } from 'edodo-write';
import { get, docLabel, loadCollections, type CollectionInfo, type FieldDef } from './api.js';
import { MediaPicker, uploadFile, type MediaItem } from './media.js';
import { registerMarkdownGetter, withFlushedMarkdown } from './flush.js';


/**
 * The schema-driven form engine: every APIck field type gets an editor,
 * derived entirely from the FieldDef the server publishes. Values are kept in
 * a plain JS object mirroring the document body.
 */

export interface FieldProps {
  name: string;
  path: string; // dotted, for test selectors
  def: FieldDef;
  value: unknown;
  onChange: (value: unknown) => void;
  errors?: Record<string, string>;
}

function labelText(name: string, def: FieldDef): string {
  const pretty = name.replace(/([a-z])([A-Z])/g, '$1 $2');
  return pretty.charAt(0).toUpperCase() + pretty.slice(1) + (def.required ? ' *' : '');
}

export function Field(props: FieldProps): unknown {
  const { def } = props;
  return html`
    <div class="field" data-field=${props.path}>
      <label>
        <span class="field-label">
          ${labelText(props.name, def)}
          ${def.private ? html`<em class="badge badge-private" title="Write-only: never returned by the API">write-only</em>` : ''}
          ${def.unique ? html`<em class="badge">unique</em>` : ''}
        </span>
        ${def.description ? html`<span class="field-help">${def.description}</span>` : ''}
      </label>
      <${FieldInput} ...${props} />
      ${props.errors?.[props.path] ? html`<div class="field-error">${props.errors[props.path]}</div>` : ''}
    </div>
  `;
}

function FieldInput(props: FieldProps): unknown {
  const { def, value, onChange, path } = props;
  const set = (v: unknown) => onChange(v);

  switch (def.type) {
    case 'text': {
      if (def.format === 'markdown') {
        return html`<${MarkdownField} path=${path} value=${value} onChange=${set} />`;
      }
      if (def.format === 'image') {
        return html`<${ImageField} path=${path} value=${value} onChange=${set} />`;
      }
      return html`<input data-input=${path} type=${def.format === 'email' ? 'email' : def.format === 'uri' ? 'url' : 'text'}
        value=${(value as string) ?? ''}
        placeholder=${def.private ? '(leave blank to keep the current value)' : ''}
        onInput=${(e: InputEvent) => set((e.target as HTMLInputElement).value)} />`;
    }
    case 'integer':
    case 'number':
      return html`<input data-input=${path} type="number" step=${def.type === 'integer' ? '1' : 'any'}
        value=${value === null || value === undefined ? '' : String(value)}
        min=${def.min ?? ''} max=${def.max ?? ''}
        onInput=${(e: InputEvent) => {
          const raw = (e.target as HTMLInputElement).value;
          set(raw === '' ? null : def.type === 'integer' ? Number.parseInt(raw, 10) : Number.parseFloat(raw));
        }} />`;
    case 'boolean':
      return html`<label class="toggle">
        <input data-input=${path} type="checkbox" checked=${value === true}
          onChange=${(e: Event) => set((e.target as HTMLInputElement).checked)} />
        <span>${value === true ? 'Yes' : 'No'}</span>
      </label>`;
    case 'datetime':
      return html`<input data-input=${path} type="datetime-local"
        value=${isoToLocal(value)}
        onInput=${(e: InputEvent) => {
          const raw = (e.target as HTMLInputElement).value;
          set(raw ? new Date(raw).toISOString() : null);
        }} />`;
    case 'date':
      return html`<input data-input=${path} type="date" value=${(value as string) ?? ''}
        onInput=${(e: InputEvent) => set((e.target as HTMLInputElement).value || null)} />`;
    case 'enum':
      return html`<select data-input=${path} value=${(value as string) ?? ''}
        onChange=${(e: Event) => set((e.target as HTMLSelectElement).value || null)}>
        ${def.required ? '' : html`<option value="">—</option>`}
        ${(def.values ?? []).map((v) => html`<option value=${v} selected=${value === v}>${v}</option>`)}
      </select>`;
    case 'json':
      return html`<${JsonInput} path=${path} value=${value} onChange=${set} />`;
    case 'object':
      return html`<fieldset class="nested">
        ${Object.entries(def.fields ?? {}).map(([key, sub]) => {
          const obj = (value ?? {}) as Record<string, unknown>;
          return html`<${Field} name=${key} path=${`${path}.${key}`} def=${sub} value=${obj[key]}
            errors=${props.errors}
            onChange=${(v: unknown) => set({ ...obj, [key]: v })} />`;
        })}
      </fieldset>`;
    case 'list':
      return html`<${ListInput} ...${props} />`;
    case 'relation':
      return def.many ? html`<${RelationManyInput} ...${props} />` : html`<${RelationInput} ...${props} />`;
    case 'blocks':
      return html`<${BlocksInput} ...${props} />`;
    default:
      return html`<div class="field-help">Unsupported field type: ${def.type}</div>`;
  }
}

/**
 * Markdown editing via edodo-write (Notion/Medium-style, Markdown IS the
 * value). The editor is created ONCE per mount (its registries resolve at
 * construction); external value changes after mount are pushed with
 * setMarkdown(silent). Pasted/dropped images upload to the media library.
 */
function MarkdownField({ path, value, onChange }: { path: string; value: unknown; onChange: (v: unknown) => void }): unknown {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<InstanceType<typeof EdodoWrite> | null>(null);
  const valueRef = useRef<string>(typeof value === 'string' ? value : '');
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!hostRef.current) return;
    const editor = new EdodoWrite(hostRef.current, {
      value: valueRef.current,
      // "fill" = full-width embedded composer (vs the centered document look).
      layout: 'fill',
      placeholder: 'Write… type “/” for blocks',
      onChange: (md: string) => {
        valueRef.current = md;
        onChangeRef.current(md);
      },
      uploadImage: async (file: File) => {
        const item = await uploadFile(file, file.name);
        return { src: item.url, alt: item.alt || item.filename };
      },
    });
    editorRef.current = editor;
    return () => {
      editor.destroy();
      editorRef.current = null;
    };
  }, []);

  // Register a synchronous getter under the CURRENT path so saves capture the
  // latest text even inside edodo's ~120ms change debounce; re-registers when
  // the path changes (e.g. a markdown block reordered).
  useEffect(() => registerMarkdownGetter(path, () => editorRef.current?.getMarkdown() ?? ''), [path]);

  // Reflect external resets (load, restore) without clobbering local typing.
  useEffect(() => {
    const incoming = typeof value === 'string' ? value : '';
    if (editorRef.current && incoming !== valueRef.current) {
      valueRef.current = incoming;
      editorRef.current.setMarkdown(incoming, { silent: true });
    }
  }, [value]);

  return html`<div class="markdown-field" data-input=${path} data-markdown=${path} ref=${hostRef}></div>`;
}

/** Image URL field with a media-library picker + preview. */
function ImageField({ path, value, onChange }: { path: string; value: unknown; onChange: (v: unknown) => void }): unknown {
  const [picking, setPicking] = useState(false);
  const url = typeof value === 'string' ? value : '';
  return html`<div class="image-field" data-input=${path}>
    <div class="image-field-row">
      <input type="text" data-input=${`${path}.url`} value=${url} placeholder="/media/… or https://…"
        onInput=${(e: InputEvent) => onChange((e.target as HTMLInputElement).value || null)} />
      <button type="button" class="btn btn-small" data-action="pick-media" onClick=${() => setPicking(true)}>Media…</button>
      ${url && html`<button type="button" class="btn btn-small btn-ghost" onClick=${() => onChange(null)}>Clear</button>`}
    </div>
    ${url && html`<div class="image-preview"><img src=${url} alt="" /></div>`}
    ${picking &&
    html`<${MediaPicker}
      onClose=${() => setPicking(false)}
      onPick=${(item: MediaItem) => {
        onChange(item.url);
        setPicking(false);
      }} />`}
  </div>`;
}

function isoToLocal(value: unknown): string {
  if (typeof value !== 'string') return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function JsonInput({ path, value, onChange }: FieldProps): unknown {
  const [text, setText] = useState(value === undefined || value === null ? '' : JSON.stringify(value, null, 2));
  const [bad, setBad] = useState(false);
  return html`<div>
    <textarea data-input=${path} rows="6" class="mono" value=${text}
      onInput=${(e: InputEvent) => {
        const raw = (e.target as HTMLTextAreaElement).value;
        setText(raw);
        if (!raw.trim()) {
          setBad(false);
          onChange(null);
          return;
        }
        try {
          onChange(JSON.parse(raw));
          setBad(false);
        } catch {
          setBad(true);
        }
      }}></textarea>
    ${bad ? html`<div class="field-error">Invalid JSON (not saved until fixed)</div>` : ''}
  </div>`;
}

function ListInput({ path, def, value, onChange, errors }: FieldProps): unknown {
  const items = Array.isArray(value) ? value : [];
  const itemDef = def.of ?? { type: 'text' };
  // Same flush-before-structural-edit guard as blocks (in case of markdown list items).
  const currentItems = (): unknown[] => {
    const merged = withFlushedMarkdown({ [path]: items });
    return Array.isArray(merged[path]) ? (merged[path] as unknown[]) : items;
  };
  const update = (i: number, v: unknown) => onChange(currentItems().map((item, j) => (j === i ? v : item)));
  const emptyItem = () => (itemDef.type === 'object' ? {} : '');
  return html`<div class="list-input" data-list=${path}>
    ${items.map(
      (item, i) => html`<div class="list-item">
        <div class="list-item-body">
          <${FieldInput} name=${String(i)} path=${`${path}.${i}`} def=${itemDef} value=${item} errors=${errors}
            onChange=${(v: unknown) => update(i, v)} />
        </div>
        <button type="button" class="btn btn-ghost" title="Remove"
          onClick=${() => onChange(currentItems().filter((_, j) => j !== i))}>✕</button>
      </div>`,
    )}
    <button type="button" class="btn btn-small" data-add=${path} onClick=${() => onChange([...currentItems(), emptyItem()])}>+ Add item</button>
  </div>`;
}

function useTargetDocs(collection: string | undefined): Array<{ docId: string; label: string }> {
  const [docs, setDocs] = useState<Array<{ docId: string; label: string }>>([]);
  useEffect(() => {
    if (!collection) return;
    let alive = true;
    (async () => {
      try {
        const cols = await loadCollections();
        const info = cols.find((c: CollectionInfo) => c.key === collection) ?? null;
        const res = await get<{ data: Array<{ docId: string; data: Record<string, unknown> }> }>(
          `/v1/collections/${collection}/docs?status=draft&pageSize=100&sort=-updatedAt`,
        );
        if (alive) setDocs(res.data.map((d) => ({ docId: d.docId, label: docLabel(info?.fields ?? null, d) })));
      } catch {
        if (alive) setDocs([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [collection]);
  return docs;
}

function RelationInput({ path, def, value, onChange }: FieldProps): unknown {
  const docs = useTargetDocs(def.to);
  return html`<select data-input=${path} value=${(value as string) ?? ''}
    onChange=${(e: Event) => onChange((e.target as HTMLSelectElement).value || null)}>
    <option value="">— none —</option>
    ${docs.map((d) => html`<option value=${d.docId} selected=${value === d.docId}>${d.label}</option>`)}
  </select>`;
}

function RelationManyInput({ path, def, value, onChange }: FieldProps): unknown {
  const docs = useTargetDocs(def.to);
  const selected = Array.isArray(value) ? (value as string[]) : [];
  const available = docs.filter((d) => !selected.includes(d.docId));
  const labelOf = (id: string) => docs.find((d) => d.docId === id)?.label ?? id.slice(0, 8);
  return html`<div class="chips" data-list=${path}>
    ${selected.map(
      (id, i) => html`<span class="chip">
        ${labelOf(id)}
        <button type="button" title="Remove" onClick=${() => onChange(selected.filter((_, j) => j !== i))}>✕</button>
      </span>`,
    )}
    <select data-add=${path} value=""
      onChange=${(e: Event) => {
        const id = (e.target as HTMLSelectElement).value;
        if (id) onChange([...selected, id]);
        (e.target as HTMLSelectElement).value = '';
      }}>
      <option value="">+ Add…</option>
      ${available.map((d) => html`<option value=${d.docId}>${d.label}</option>`)}
    </select>
  </div>`;
}

function BlocksInput({ path, def, value, onChange, errors }: FieldProps): unknown {
  const blocks = Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
  const variants = def.variants ?? {};

  // Reordering/removing a block can destroy a markdown editor whose latest
  // text is still inside edodo's change debounce; flush every editor's current
  // value into the block data FIRST, so structural edits never lose content.
  const currentBlocks = (): Array<Record<string, unknown>> => {
    const merged = withFlushedMarkdown({ [path]: blocks });
    const out = merged[path];
    return Array.isArray(out) ? (out as Array<Record<string, unknown>>) : blocks;
  };

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= blocks.length) return;
    const next = currentBlocks().slice();
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  const removeBlock = (i: number) => onChange(currentBlocks().filter((_, j) => j !== i));
  return html`<div class="blocks" data-list=${path}>
    ${blocks.map((block, i) => {
      const type = block['__type'] as string;
      const shape = variants[type] ?? {};
      return html`<div class="block-card" data-block=${`${path}.${i}`}>
        <div class="block-head">
          <span class="block-type">${type}</span>
          <span class="block-actions">
            <button type="button" class="btn btn-ghost" title="Move up" onClick=${() => move(i, -1)}>↑</button>
            <button type="button" class="btn btn-ghost" title="Move down" onClick=${() => move(i, 1)}>↓</button>
            <button type="button" class="btn btn-ghost" title="Remove"
              onClick=${() => removeBlock(i)}>✕</button>
          </span>
        </div>
        ${Object.entries(shape).map(
          ([key, sub]) => html`<${Field} name=${key} path=${`${path}.${i}.${key}`} def=${sub} value=${block[key]} errors=${errors}
            onChange=${(v: unknown) => onChange(currentBlocks().map((b, j) => (j === i ? { ...b, [key]: v } : b)))} />`,
        )}
      </div>`;
    })}
    <select class="add-block" data-add=${path} value=""
      onChange=${(e: Event) => {
        const type = (e.target as HTMLSelectElement).value;
        if (type) onChange([...currentBlocks(), { __type: type }]);
        (e.target as HTMLSelectElement).value = '';
      }}>
      <option value="">+ Add block…</option>
      ${Object.keys(variants).map((v) => html`<option value=${v}>${v}</option>`)}
    </select>
  </div>`;
}
