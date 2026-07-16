/**
 * Schema-driven form helpers, ported from ui-legacy/editor.ts (slugify, title/
 * slug field discovery, write-body cleaning, 422 error mapping) and shared by
 * DocumentForm, RelationPicker and RelatedContent.
 */
import { RequestError } from '../../api';
import type { AdminHints, Envelope, FieldDef } from '../../types';

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
export function titleFieldFor(fields: Record<string, FieldDef>, admin?: AdminHints): string | null {
  if (admin?.titleField && fields[admin.titleField]) return admin.titleField;
  for (const key of ['title', 'name', 'headline']) {
    const def = fields[key];
    if (def?.type === 'text' && def.format !== 'slug') return key;
  }
  for (const [key, def] of Object.entries(fields)) {
    if (def.type === 'text' && def.format !== 'slug' && def.required) return key;
  }
  for (const [key, def] of Object.entries(fields)) {
    if (def.type === 'text' && def.format !== 'slug' && !def.private) return key;
  }
  return null;
}

export function slugFieldFor(fields: Record<string, FieldDef>): string | null {
  for (const [key, def] of Object.entries(fields)) if (def.format === 'slug') return key;
  return null;
}

/** Human title of a document envelope (falls back to a docId stub). */
export function docTitle(env: Pick<Envelope, 'docId' | 'data'>, titleField: string | null): string {
  const value = titleField ? env.data[titleField] : null;
  return typeof value === 'string' && value.trim() ? value : env.docId.slice(0, 8);
}

/** Build the write body from form values: blanks on optional fields vanish. */
export function cleanForWrite(
  fields: Record<string, FieldDef>,
  values: Record<string, unknown>,
  mode: 'create' | 'patch',
): Record<string, unknown> {
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

/** Map an API error to a banner message + per-field (dotted path) messages. */
export function errorMap(err: unknown): { message: string; fields: Record<string, string> } {
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

/** "publishedAt" → "Published at". */
export function fieldLabel(name: string): string {
  const pretty = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ');
  return pretty.charAt(0).toUpperCase() + pretty.slice(1);
}

/** ISO string → value for `<input type="datetime-local">` (local timezone). */
export function isoToLocal(value: unknown): string {
  if (typeof value !== 'string') return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `<input type="datetime-local">` value → ISO string (or null when blank/invalid). */
export function localToIso(raw: string): string | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
