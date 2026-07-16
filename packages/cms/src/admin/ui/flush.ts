/**
 * Markdown-editor flush registry. edodo-write debounces its `change` event
 * (~120ms), so `values` state lags the last keystrokes. Each mounted markdown
 * editor registers a synchronous getter here; the editor pulls every getter's
 * current value into the write body at save/autosave time, so no keystroke is
 * ever lost — even a save fired mid-debounce.
 */
const getters = new Map<string, () => string>();

export function registerMarkdownGetter(path: string, get: () => string): () => void {
  getters.set(path, get);
  return () => {
    if (getters.get(path) === get) getters.delete(path);
  };
}

/** Deep-set a dotted path (numeric segments are array indices). */
function setDeep(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let node: any = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const nextIsIndex = /^\d+$/.test(parts[i + 1]!);
    const idx: string | number = /^\d+$/.test(key) ? Number(key) : key;
    if (node[idx] === null || node[idx] === undefined || typeof node[idx] !== 'object') {
      node[idx] = nextIsIndex ? [] : {};
    }
    node = node[idx];
  }
  node[parts[parts.length - 1]!] = value;
}

/** Return a copy of `values` with every live markdown editor's current text merged in. */
export function withFlushedMarkdown(values: Record<string, unknown>): Record<string, unknown> {
  if (getters.size === 0) return values;
  const merged: Record<string, unknown> = structuredClone(values);
  for (const [path, get] of getters) {
    try {
      setDeep(merged, path, get());
    } catch {
      /* an editor path no longer maps into values (mid-reorder) — skip */
    }
  }
  return merged;
}
