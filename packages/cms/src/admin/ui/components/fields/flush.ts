/**
 * Markdown-editor flush registry — ported from ui-legacy/flush.ts.
 *
 * edodo-write debounces its `change` event (~120ms), so React state lags the
 * last keystrokes. Each mounted markdown editor registers a synchronous getter
 * here; the form pulls every getter's current value into the write body at
 * save/autosave time, so no keystroke is ever lost — even a save fired
 * mid-debounce.
 *
 * Unlike the legacy module-global Map, the registry is INSTANCE-based: each
 * DocumentForm owns one (provided via FormContext), so a Sheet editor stacked
 * over the page editor can't flush its markdown into the wrong document.
 */

export interface FlushRegistry {
  /** Register a synchronous getter for a dotted path; returns an unregister fn. */
  register(path: string, get: () => string): () => void;
  /** A copy of `values` with every live markdown editor's current text merged in. */
  withFlushed(values: Record<string, unknown>): Record<string, unknown>;
}

/** Deep-set a dotted path (numeric segments are array indices). */
function setDeep(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

export function createFlushRegistry(): FlushRegistry {
  const getters = new Map<string, () => string>();
  return {
    register(path, get) {
      getters.set(path, get);
      return () => {
        if (getters.get(path) === get) getters.delete(path);
      };
    },
    withFlushed(values) {
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
    },
  };
}
