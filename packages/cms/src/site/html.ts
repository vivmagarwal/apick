/**
 * Server-side HTML templating: escaped by default, `raw()` for trusted HTML
 * (rendered markdown). Interpolated arrays are joined, null/undefined vanish.
 */

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}

export class RawHtml {
  constructor(readonly value: string) {}
}

/** Mark a string as pre-sanitized/trusted HTML. */
export function raw(value: string): RawHtml {
  return new RawHtml(value);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): RawHtml {
  let out = '';
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) out += renderValue(values[i]);
  }
  return new RawHtml(out);
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof RawHtml) return value.value;
  if (Array.isArray(value)) return value.map(renderValue).join('');
  return escapeHtml(value);
}
