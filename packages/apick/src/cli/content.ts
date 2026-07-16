import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp, type ApickApp } from '../app/createApp.js';
import { silentLogger } from '../kernel/log.js';
import { sql } from '../kernel/sql.js';
import { hashToken } from '../auth/rbac.js';
import type { Collection } from '../schema/collection.js';
import type { FieldDef } from '../schema/fields.js';

/**
 * `apick content push|pull|check` — content as files (GitHub issue #4).
 *
 * Layout inside <dir>:
 *   <collection-key>/*.md    frontmatter = fields, body = the collection's
 *                            FIRST markdown field (type text + format markdown)
 *   <collection-key>.json    array of data objects (collections without markdown)
 *
 * Upsert identity: the collection's first top-level field with unique:true.
 * Relations may reference target documents by that human key instead of a
 * UUID; two passes resolve intra-directory references regardless of order.
 * `publish: false` leaves a doc as draft (default is publish). Existing
 * documents are never unpublished, and unchanged documents are not touched.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DUMMY_UUID = '00000000-0000-4000-8000-000000000000';

class ContentError extends Error {}

interface ContentEntry {
  collection: Collection;
  file: string;
  data: Record<string, unknown>;
  publish: boolean;
}

// ---------- strict frontmatter (key: scalar + "- item" string lists only) ----------

function unquote(raw: string): string {
  const t = raw.trim();
  const q = /^["'](.*)["']$/.exec(t);
  return q ? q[1]! : t;
}

function scalar(raw: string): unknown {
  const t = raw.trim();
  const q = /^["'](.*)["']$/.exec(t);
  if (q) return q[1]!; // quoted values are always strings, never coerced
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

export function parseFrontmatter(src: string, file: string): { meta: Record<string, unknown>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (!m) throw new ContentError(`${file}: missing frontmatter`);
  const meta: Record<string, unknown> = {};
  let listKey: string | null = null;
  for (const rawLine of m[1]!.split('\n')) {
    if (!rawLine.trim()) continue;
    const listItem = /^\s+-\s*(.*)$/.exec(rawLine);
    if (listItem && listKey) {
      (meta[listKey] as unknown[]).push(unquote(listItem[1]!));
      continue;
    }
    const kv = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(rawLine);
    if (!kv) throw new ContentError(`${file}: bad frontmatter line: ${rawLine}`);
    const key = kv[1]!;
    const value = kv[2]!;
    if (value === '') {
      meta[key] = [];
      listKey = key;
    } else {
      meta[key] = scalar(value);
      listKey = null;
    }
  }
  return { meta, body: src.slice(m[0].length) };
}

function quoteIfNeeded(s: string): string {
  const needs =
    s === '' || s !== s.trim() || s === 'true' || s === 'false' || /^-?\d+(\.\d+)?$/.test(s) || /^["'].*["']$/.test(s);
  return needs ? `"${s}"` : s;
}

function frontmatterLines(file: string, key: string, v: unknown): string[] {
  if (Array.isArray(v)) {
    for (const item of v) {
      if (typeof item !== 'string' || item.includes('\n')) {
        throw new ContentError(`${file}: cannot represent "${key}" in frontmatter (only string lists)`);
      }
    }
    return [`${key}:`, ...v.map((item) => `  - ${quoteIfNeeded(item as string)}`)];
  }
  if (typeof v === 'boolean' || typeof v === 'number') return [`${key}: ${String(v)}`];
  if (typeof v === 'string') {
    if (v.includes('\n')) throw new ContentError(`${file}: cannot represent multi-line "${key}" in frontmatter`);
    return [`${key}: ${quoteIfNeeded(v)}`];
  }
  throw new ContentError(`${file}: cannot represent "${key}" (${typeof v}) in frontmatter`);
}

// ---------- schema helpers ----------

function uniqueFieldOf(col: Collection): string | null {
  for (const [key, def] of Object.entries(col.compiled.fields)) if (def.unique === true) return key;
  return null;
}

function markdownFieldOf(col: Collection): string | null {
  for (const [key, def] of Object.entries(col.compiled.fields)) {
    if (def.type === 'text' && def.format === 'markdown') return key;
  }
  return null;
}

function topRelationFields(col: Collection): Array<[string, FieldDef]> {
  return Object.entries(col.compiled.fields).filter(([, def]) => def.type === 'relation');
}

/** `publish` is a directive, not a field — unless the schema really has a `publish` field. */
function takePublish(meta: Record<string, unknown>, col: Collection): boolean {
  if (col.compiled.fields['publish']) return true;
  const raw = meta['publish'];
  delete meta['publish'];
  return raw !== false;
}

// ---------- load a content directory ----------

function loadContent(dir: string, byKey: Map<string, Collection>, problems: string[]): ContentEntry[] {
  const entries: ContentEntry[] = [];
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    problems.push(`${dir}: not a directory`);
    return entries;
  }
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.') || name.startsWith('_')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      const col = byKey.get(name);
      if (!col) {
        problems.push(`${name}/: unknown collection "${name}"`);
        continue;
      }
      const mdField = markdownFieldOf(col);
      for (const f of readdirSync(full).sort()) {
        if (!f.endsWith('.md') || f.startsWith('_') || f === 'README.md') continue;
        const file = `${name}/${f}`;
        try {
          const { meta, body } = parseFrontmatter(readFileSync(join(full, f), 'utf8'), file);
          const publish = takePublish(meta, col);
          const data: Record<string, unknown> = { ...meta };
          const trimmed = body.trim();
          if (trimmed !== '') {
            if (!mdField) {
              problems.push(`${file}: collection "${name}" has no markdown field to hold the body`);
              continue;
            }
            data[mdField] = trimmed + '\n';
          }
          entries.push({ collection: col, file, data, publish });
        } catch (err) {
          problems.push(err instanceof Error ? err.message : String(err));
        }
      }
    } else if (name.endsWith('.json')) {
      const key = name.slice(0, -'.json'.length);
      const col = byKey.get(key);
      if (!col) {
        problems.push(`${name}: unknown collection "${key}"`);
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(full, 'utf8'));
      } catch (err) {
        problems.push(`${name}: invalid JSON (${err instanceof Error ? err.message : String(err)})`);
        continue;
      }
      if (!Array.isArray(parsed)) {
        problems.push(`${name}: expected a JSON array of data objects`);
        continue;
      }
      parsed.forEach((item, i) => {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
          problems.push(`${name}[${i}]: expected an object`);
          return;
        }
        const data = { ...(item as Record<string, unknown>) };
        const publish = takePublish(data, col);
        entries.push({ collection: col, file: `${name}[${i}]`, data, publish });
      });
    } else if (name.endsWith('.md')) {
      problems.push(`${name}: loose .md file — markdown docs go in <collection-key>/<name>.md`);
    }
  }
  return entries;
}

// ---------- validation (shared by check + push preflight) ----------

function validateEntries(
  entries: ContentEntry[],
  problems: string[],
  options: { offlineRelations: boolean },
): void {
  // unique keys present + no duplicates; collect local keys per collection
  const localKeys = new Map<string, Set<string>>();
  const seen = new Set<string>();
  for (const e of entries) {
    const keyField = uniqueFieldOf(e.collection);
    if (keyField === null) {
      problems.push(`${e.file}: collection "${e.collection.key}" has no unique field — mark one { unique: true } to use content files`);
      continue;
    }
    const keyValue = e.data[keyField];
    if (keyValue === undefined || keyValue === null || keyValue === '') {
      problems.push(`${e.file}: missing unique key "${keyField}"`);
      continue;
    }
    const id = `${e.collection.key} ${String(keyValue)}`;
    if (seen.has(id)) problems.push(`${e.file}: duplicate ${e.collection.key} key "${String(keyValue)}"`);
    seen.add(id);
    let set = localKeys.get(e.collection.key);
    if (!set) localKeys.set(e.collection.key, (set = new Set()));
    set.add(String(keyValue));
  }

  for (const e of entries) {
    // schema validation on a copy: defaults applied, human relation keys
    // stood in by a dummy uuid (resolution is checked separately)
    const copy: Record<string, unknown> = { ...e.data };
    for (const { field, value } of e.collection.compiled.defaults) {
      if (copy[field] === undefined) copy[field] = value;
    }
    for (const [fieldKey, def] of topRelationFields(e.collection)) {
      const v = copy[fieldKey];
      if (v === undefined || v === null) continue;
      const raws = def.many ? (Array.isArray(v) ? v : [v]) : [v];
      if (def.many && Array.isArray(v)) {
        copy[fieldKey] = v.map((x) => (typeof x === 'string' && !UUID_RE.test(x) ? DUMMY_UUID : x));
      } else if (typeof v === 'string' && !UUID_RE.test(v)) {
        copy[fieldKey] = DUMMY_UUID;
      }
      if (options.offlineRelations) {
        for (const raw of raws) {
          if (typeof raw !== 'string' || UUID_RE.test(raw)) continue;
          if (!localKeys.get(def.to!)?.has(raw)) {
            problems.push(`${e.file}: unknown ${def.to} key "${raw}" in "${fieldKey}"`);
          }
        }
      }
    }
    for (const issue of e.collection.compiled.validate(copy)) {
      problems.push(`${e.file}: ${issue.path || '(document)'} — ${issue.message}`);
    }
  }
}

// ---------- in-process app + fetch-handler API client ----------

type Api = (method: string, path: string, body?: unknown) => Promise<any>;

interface BootedApp {
  app: ApickApp;
  api: Api;
  cleanup: () => Promise<void>;
}

async function bootApp(collections: Collection[], args: string[]): Promise<BootedApp> {
  const database = argOf(args, '--database');
  const schema = argOf(args, '--schema');
  // Ephemeral configured root key: created at bootstrap, deleted on cleanup.
  const token = `apick_content_${randomBytes(18).toString('base64url')}`;
  const app = await createApp({
    collections,
    ...(database !== undefined ? { database } : {}),
    ...(schema !== undefined ? { databaseSchema: schema } : {}),
    rootKey: token,
    logger: silentLogger,
    worker: false,
  });
  const api: Api = async (method, path, body) => {
    const res = await app.fetch(
      new Request(`http://apick.cli${path}`, {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new ContentError(`${method} ${path} → ${res.status}: ${JSON.stringify(json?.error ?? json)}`);
    return json;
  };
  const cleanup = async (): Promise<void> => {
    try {
      // remove exactly the key row our ephemeral configured root key created
      await app.db.query(sql`delete from apick_api_keys where token_hash = ${hashToken(token)}`);
    } catch {
      /* best effort */
    }
    await app.stop();
  };
  return { app, api, cleanup };
}

// ---------- push ----------

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}
const normalized = (v: unknown): string => JSON.stringify(stable(v));

interface PushStats {
  created: number;
  updated: number;
  unchanged: number;
  published: number;
}

async function upsert(
  api: Api,
  colKey: string,
  keyField: string,
  keyValue: unknown,
  data: Record<string, unknown>,
  publish: boolean,
  stats: PushStats,
): Promise<string> {
  const filter = encodeURIComponent(JSON.stringify({ [keyField]: { $eq: keyValue } }));
  const existing = (await api('GET', `/v1/collections/${colKey}/docs?filter=${filter}&status=draft&pageSize=1`)).data[0];

  if (!existing) {
    const created = await api('POST', `/v1/collections/${colKey}/docs`, { data, ...(publish ? { publish: true } : {}) });
    stats.created++;
    if (publish) stats.published++;
    return created.data.docId as string;
  }

  const current: Record<string, unknown> = {};
  for (const k of Object.keys(data)) current[k] = existing.data[k];
  const changed = normalized(current) !== normalized(data);
  if (changed) {
    await api('PATCH', `/v1/collections/${colKey}/docs/${existing.docId}`, { patch: data });
    stats.updated++;
  } else {
    stats.unchanged++;
  }
  // Publish when requested and the draft moved (or was never published).
  // Never unpublish — an admin's unpublish decision wins over the files.
  if (publish && (changed || existing.publishedVersion == null)) {
    await api('POST', `/v1/collections/${colKey}/docs/${existing.docId}/publish`);
    stats.published++;
  }
  return existing.docId as string;
}

async function resolveRef(
  api: Api,
  byKey: Map<string, Collection>,
  idByKey: Map<string, string>,
  toKey: string,
  raw: string,
): Promise<string | null> {
  if (UUID_RE.test(raw)) return raw;
  const cacheKey = `${toKey} ${raw}`;
  const hit = idByKey.get(cacheKey);
  if (hit) return hit;
  const target = byKey.get(toKey);
  if (!target) throw new ContentError(`unknown relation target collection "${toKey}"`);
  const keyField = uniqueFieldOf(target);
  if (keyField === null) {
    throw new ContentError(`collection "${toKey}" has no unique field — cannot resolve relation key "${raw}"`);
  }
  const filter = encodeURIComponent(JSON.stringify({ [keyField]: { $eq: raw } }));
  const found = (await api('GET', `/v1/collections/${toKey}/docs?filter=${filter}&status=draft&pageSize=1`)).data[0];
  if (found) {
    idByKey.set(cacheKey, found.docId as string);
    return found.docId as string;
  }
  return null;
}

/** Resolve every relation key in an entry; null = defer (some target missing so far). */
async function resolveEntry(
  api: Api,
  byKey: Map<string, Collection>,
  idByKey: Map<string, string>,
  e: ContentEntry,
  misses?: string[],
): Promise<Record<string, unknown> | null> {
  let out: Record<string, unknown> | null = null;
  let deferred = false;
  for (const [fieldKey, def] of topRelationFields(e.collection)) {
    const v = e.data[fieldKey];
    if (v === undefined || v === null) continue;
    const raws = def.many ? (Array.isArray(v) ? v : [v]) : [v];
    const ids: string[] = [];
    for (const raw of raws) {
      if (typeof raw !== 'string') throw new ContentError(`${e.file}: relation "${fieldKey}" values must be strings`);
      const id = await resolveRef(api, byKey, idByKey, def.to!, raw);
      if (id === null) {
        if (misses) {
          misses.push(`${e.file}: unresolved ${def.to} key "${raw}" in "${fieldKey}"`);
          deferred = true;
          continue;
        }
        return null;
      }
      ids.push(id);
    }
    if (deferred) continue;
    out ??= { ...e.data };
    out[fieldKey] = def.many ? ids : ids[0]!;
  }
  if (deferred) return null;
  return out ?? e.data;
}

async function push(entries: ContentEntry[], byKey: Map<string, Collection>, api: Api): Promise<PushStats> {
  const stats: PushStats = { created: 0, updated: 0, unchanged: 0, published: 0 };
  const idByKey = new Map<string, string>();
  let queue = entries;
  while (queue.length > 0) {
    const deferred: ContentEntry[] = [];
    for (const e of queue) {
      const data = await resolveEntry(api, byKey, idByKey, e);
      if (data === null) {
        deferred.push(e);
        continue;
      }
      const keyField = uniqueFieldOf(e.collection)!;
      const docId = await upsert(api, e.collection.key, keyField, e.data[keyField], data, e.publish, stats);
      idByKey.set(`${e.collection.key} ${String(e.data[keyField])}`, docId);
    }
    if (deferred.length === queue.length) {
      const misses: string[] = [];
      for (const e of deferred) await resolveEntry(api, byKey, idByKey, e, misses);
      throw new ContentError(`unresolved relation keys:\n  - ${misses.join('\n  - ')}`);
    }
    queue = deferred;
  }
  return stats;
}

// ---------- pull ----------

interface DocEnvelope {
  docId: string;
  publishedVersion: number | null;
  data: Record<string, unknown>;
}

async function listAllDocs(api: Api, colKey: string): Promise<DocEnvelope[]> {
  const all: DocEnvelope[] = [];
  for (let page = 1; ; page++) {
    const res = await api('GET', `/v1/collections/${colKey}/docs?status=draft&page=${page}&pageSize=100&sort=createdAt`);
    all.push(...(res.data as DocEnvelope[]));
    if ((res.data as unknown[]).length < 100) break;
  }
  return all;
}

function mapRelationsToKeys(col: Collection, data: Record<string, unknown>, keyByDocId: Map<string, string>): Record<string, unknown> {
  const out = { ...data };
  for (const [fieldKey, def] of topRelationFields(col)) {
    const v = out[fieldKey];
    if (v === undefined || v === null) continue;
    if (def.many && Array.isArray(v)) {
      out[fieldKey] = v.map((id) => (typeof id === 'string' ? (keyByDocId.get(id) ?? id) : id));
    } else if (typeof v === 'string') {
      out[fieldKey] = keyByDocId.get(v) ?? v;
    }
  }
  return out;
}

function fileNameFor(keyValue: string): string {
  const safe = keyValue.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '');
  return safe === '' ? 'doc' : safe;
}

async function pull(dir: string, collections: Collection[], api: Api): Promise<number> {
  const docsByCol = new Map<string, DocEnvelope[]>();
  for (const col of collections) {
    const docs = await listAllDocs(api, col.key);
    if (docs.length > 0) docsByCol.set(col.key, docs);
  }

  // docId → human key, across every pulled collection (for relation export)
  const keyByDocId = new Map<string, string>();
  for (const col of collections) {
    const keyField = uniqueFieldOf(col);
    if (keyField === null) continue;
    for (const d of docsByCol.get(col.key) ?? []) {
      const kv = d.data[keyField];
      if (kv !== undefined && kv !== null) keyByDocId.set(d.docId, String(kv));
    }
  }

  mkdirSync(dir, { recursive: true });
  let count = 0;
  for (const col of collections) {
    const docs = docsByCol.get(col.key);
    if (!docs) continue;
    const keyField = uniqueFieldOf(col);
    if (keyField === null) {
      console.error(`content pull: skipping "${col.key}" (${docs.length} doc(s)) — no unique field`);
      continue;
    }
    const rows = docs
      .filter((d) => d.data[keyField] !== undefined && d.data[keyField] !== null)
      .sort((a, b) => String(a.data[keyField]).localeCompare(String(b.data[keyField])));
    const mdField = markdownFieldOf(col);

    if (mdField !== null) {
      const colDir = join(dir, col.key);
      mkdirSync(colDir, { recursive: true });
      for (const d of rows) {
        const data = mapRelationsToKeys(col, d.data, keyByDocId);
        const body = typeof data[mdField] === 'string' ? (data[mdField] as string) : '';
        const fm: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(data)) {
          if (k === mdField || v === undefined || v === null) continue;
          fm[k] = v;
        }
        if (d.publishedVersion == null) fm['publish'] = false;
        const file = `${col.key}/${fileNameFor(String(d.data[keyField]))}.md`;
        const lines = Object.keys(fm)
          .sort()
          .flatMap((k) => frontmatterLines(file, k, fm[k]));
        const md = `---\n${lines.join('\n')}\n---\n` + (body.trim() !== '' ? `\n${body.trimEnd()}\n` : '');
        writeFileSync(join(dir, file), md);
        count++;
      }
    } else {
      const arr = rows.map((d) => {
        const data = mapRelationsToKeys(col, d.data, keyByDocId);
        const obj: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(data)) {
          if (v === undefined || v === null) continue;
          obj[k] = v;
        }
        if (d.publishedVersion == null) obj['publish'] = false;
        return stable(obj);
      });
      writeFileSync(join(dir, `${col.key}.json`), JSON.stringify(arr, null, 2) + '\n');
      count += arr.length;
    }
  }
  return count;
}

// ---------- command entry ----------

function argOf(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const USAGE = `Usage:
  apick content push  <dir> --app ./app.js [--database url] [--schema name]
  apick content pull  <dir> --app ./app.js [--database url] [--schema name]
  apick content check <dir> --app ./app.js

<dir> holds <collection-key>/*.md (frontmatter fields + markdown body) and/or
<collection-key>.json (array of data objects). --app is a module exporting
"collections" (defineCollection results).`;

async function loadCollections(appModule: string): Promise<Collection[]> {
  const mod = (await import(pathToFileURL(resolve(process.cwd(), appModule)).href)) as {
    collections?: Collection[];
    default?: { collections?: Collection[] };
  };
  const collections = mod.collections ?? mod.default?.collections;
  if (!collections || !Array.isArray(collections)) {
    throw new ContentError(`--app module must export "collections" (an array of defineCollection results)`);
  }
  return collections;
}

export async function contentCommand(args: string[]): Promise<void> {
  const sub = args[0];
  const dirArg = args[1] !== undefined && !args[1].startsWith('--') ? args[1] : undefined;
  if ((sub !== 'push' && sub !== 'pull' && sub !== 'check') || dirArg === undefined) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const appModule = argOf(args, '--app');
  if (appModule === undefined) {
    console.error(`content ${sub} needs --app <module> (exports collections)\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  const dir = resolve(process.cwd(), dirArg);
  const collections = await loadCollections(appModule);
  const byKey = new Map(collections.map((c) => [c.key, c]));

  if (sub === 'pull') {
    const { api, cleanup } = await bootApp(collections, args);
    try {
      const count = await pull(dir, collections, api);
      console.log(`content pull: ${count} document(s) → ${dir}`);
    } finally {
      await cleanup();
    }
    return;
  }

  // push + check both parse and validate first
  const problems: string[] = [];
  const entries = loadContent(dir, byKey, problems);
  validateEntries(entries, problems, { offlineRelations: sub === 'check' });
  if (problems.length > 0) {
    console.error(`${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }

  if (sub === 'check') {
    console.log(`content check: ${entries.length} document(s) OK`);
    return;
  }

  const { api, cleanup } = await bootApp(collections, args);
  try {
    const stats = await push(entries, byKey, api);
    console.log(
      `content push: ${stats.created} created · ${stats.updated} updated · ${stats.unchanged} unchanged · ${stats.published} published`,
    );
  } finally {
    await cleanup();
  }
}
