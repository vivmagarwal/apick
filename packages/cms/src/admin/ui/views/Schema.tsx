/**
 * Schema inspector (/admin/schema + /admin/schema/:key) — read-only, per
 * spec: per collection its description, admin hints, a fields table (name,
 * type badge, flags, enum values, default, description) and relations in/out
 * linking between schema pages. Content types are code; this view only reads
 * /v1/collections + /v1/collections/:key/schema.
 */
import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { ArrowLeft, ArrowRight, Braces } from 'lucide-react';
import * as api from '../api';
import type { FieldDef } from '../types';
import { Badge } from '../components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';

function errText(err: unknown): string {
  return err instanceof api.RequestError ? err.error.message : String(err);
}

/** Human-friendly compound type label, e.g. "list<text·slug>", "relation → posts[]". */
function typeLabel(def: FieldDef): string {
  switch (def.type) {
    case 'text':
      return def.format ? `text · ${def.format}` : 'text';
    case 'list':
      return def.of ? `list<${typeLabel(def.of)}>` : 'list';
    case 'relation':
      return `relation → ${def.to ?? '?'}${def.many ? '[]' : ''}`;
    case 'object':
      return `object (${Object.keys(def.fields ?? {}).length} fields)`;
    case 'blocks':
      return `blocks (${Object.keys(def.variants ?? {}).join(', ') || 'no variants'})`;
    default:
      return def.type;
  }
}

const FLAGS: Array<{ key: keyof FieldDef; label: string }> = [
  { key: 'required', label: 'required' },
  { key: 'unique', label: 'unique' },
  { key: 'private', label: 'private' },
  { key: 'indexed', label: 'indexed' },
  { key: 'immutable', label: 'immutable' },
];

function constraintText(def: FieldDef): string {
  const parts: string[] = [];
  if (def.type === 'enum' && def.values?.length) parts.push(def.values.join(' | '));
  if (def.minLength !== undefined) parts.push(`min ${def.minLength} chars`);
  if (def.maxLength !== undefined) parts.push(`max ${def.maxLength} chars`);
  if (def.min !== undefined) parts.push(`min ${def.min}`);
  if (def.max !== undefined) parts.push(`max ${def.max}`);
  if (def.pattern) parts.push(`pattern ${def.pattern}`);
  if (def.default !== undefined) parts.push(`default ${JSON.stringify(def.default)}`);
  return parts.join(' · ');
}

/** Outgoing relation edges: top-level relation fields (incl. lists of relations). */
function relationsOut(fields: Record<string, FieldDef>): Array<{ field: string; to: string; many: boolean }> {
  const out: Array<{ field: string; to: string; many: boolean }> = [];
  for (const [key, def] of Object.entries(fields)) {
    if (def.type === 'relation' && def.to) out.push({ field: key, to: def.to, many: def.many === true });
    else if (def.type === 'list' && def.of?.type === 'relation' && def.of.to) out.push({ field: key, to: def.of.to, many: true });
  }
  return out;
}

const CODE_LINE = (key?: string) => (
  <p className="text-xs text-muted-foreground">
    Content types are code — <code className="rounded bg-muted px-1 py-0.5 font-mono">collections/{key ?? '<key>'}.js</code> in your project.
  </p>
);

// ---- index ---------------------------------------------------------------------

export function SchemaIndexPage() {
  const collectionsQ = useQuery({ queryKey: ['collections'], queryFn: api.collections });

  return (
    <div className="mx-auto max-w-4xl" data-view="schema">
      <div className="mb-4 flex items-center gap-3">
        {CODE_LINE()}
      </div>
      {collectionsQ.isPending && (
        <div className="grid gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      )}
      {collectionsQ.isError && <p className="text-sm text-destructive">Couldn’t load collections: {errText(collectionsQ.error)}</p>}
      {collectionsQ.data && collectionsQ.data.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-md border py-14 text-center">
          <Braces className="size-8 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">No collections defined yet.</p>
        </div>
      )}
      <div className="grid gap-3">
        {collectionsQ.data?.map((col) => (
          <Link key={col.key} href={`/schema/${col.key}`} className="group" data-schema-card={col.key}>
            <Card className="transition-colors group-hover:border-ring/60">
              <CardContent className="flex items-center gap-3 p-4">
                <span className="text-xl" aria-hidden>
                  {col.admin.icon ?? '📄'}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {col.admin.label ?? col.key}
                    <code className="font-mono text-xs text-muted-foreground">{col.key}</code>
                    {col.publicRead && <Badge variant="outline">public read</Badge>}
                  </span>
                  {col.description && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{col.description}</span>}
                </span>
                <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}

// ---- per-collection detail --------------------------------------------------------

export function SchemaDetailPage({ collection }: { collection: string }) {
  const schemaQ = useQuery({ queryKey: ['schema', collection], queryFn: () => api.schema(collection) });

  if (schemaQ.isPending) {
    return (
      <div className="mx-auto max-w-4xl">
        <Skeleton className="mb-4 h-8 w-64" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }
  if (schemaQ.isError) {
    return (
      <Card className="mx-auto mt-12 max-w-lg">
        <CardHeader>
          <CardTitle>Couldn’t load this schema</CardTitle>
          <CardDescription>{errText(schemaQ.error)}</CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/schema" className="text-sm underline underline-offset-4">
            ← All collections
          </Link>
        </CardContent>
      </Card>
    );
  }

  const info = schemaQ.data;
  const fields = info.fields ?? null;
  const outgoing = fields ? relationsOut(fields) : [];
  const hints: Array<[string, string | undefined]> = [
    ['label', info.admin.label],
    ['icon', info.admin.icon],
    ['titleField', info.admin.titleField],
    ['orderField', info.admin.orderField],
  ];

  return (
    <div className="mx-auto max-w-4xl" data-view="schema-detail" data-schema={collection}>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Link
          href="/schema"
          title="All collections"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground [&_svg]:size-4"
        >
          <ArrowLeft />
        </Link>
        <span className="text-xl" aria-hidden>
          {info.admin.icon ?? '📄'}
        </span>
        <h2 className="text-xl font-semibold tracking-tight">{info.admin.label ?? info.key}</h2>
        <code className="font-mono text-sm text-muted-foreground">{info.key}</code>
      </div>

      {info.description && <p className="mb-4 text-sm text-muted-foreground">{info.description}</p>}

      <div className="mb-6 flex flex-wrap gap-1.5">
        {hints
          .filter((h): h is [string, string] => !!h[1])
          .map(([k, v]) => (
            <Badge key={k} variant="secondary" className="font-mono text-[11px]">
              admin.{k}: {v}
            </Badge>
          ))}
      </div>

      <section className="mb-8">
        <h3 className="mb-3 text-sm font-semibold text-muted-foreground">Fields</h3>
        {!fields && (
          <p className="rounded-md border px-3 py-2.5 text-sm text-muted-foreground">
            Field definitions are visible only to accounts with write access to this collection.
          </p>
        )}
        {fields && (
          <div className="overflow-x-auto rounded-md border">
            <Table data-table="schema-fields">
              <TableHeader>
                <TableRow>
                  <TableHead>Field</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Flags</TableHead>
                  <TableHead>Constraints / default</TableHead>
                  <TableHead>Description</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(fields).map(([name, def]) => (
                  <TableRow key={name} data-field={name}>
                    <TableCell className="font-mono text-xs font-medium">{name}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="whitespace-nowrap font-mono text-[11px]">
                        {typeLabel(def)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {FLAGS.filter((f) => def[f.key] === true).map((f) => (
                          <Badge key={f.label} variant="secondary" className="text-[11px]">
                            {f.label}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-52 text-xs text-muted-foreground">{constraintText(def) || '—'}</TableCell>
                    <TableCell className="max-w-56 text-xs text-muted-foreground">{def.description ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <section>
          <h3 className="mb-3 text-sm font-semibold text-muted-foreground">Relations out</h3>
          {outgoing.length === 0 && <p className="text-sm text-muted-foreground">{fields ? 'No relation fields.' : '—'}</p>}
          <ul className="grid gap-1.5">
            {outgoing.map((rel) => (
              <li key={rel.field} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                <code className="font-mono text-xs">{rel.field}</code>
                <ArrowRight className="size-3.5 text-muted-foreground" />
                <Link href={`/schema/${rel.to}`} className="underline underline-offset-4">
                  {rel.to}
                </Link>
                {rel.many && <Badge variant="outline">many</Badge>}
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3 className="mb-3 text-sm font-semibold text-muted-foreground">Referenced by</h3>
          {info.referencedBy.length === 0 && <p className="text-sm text-muted-foreground">Nothing points at this collection.</p>}
          <ul className="grid gap-1.5">
            {info.referencedBy.map((ref) => (
              <li key={`${ref.collection}.${ref.field}`} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                <Link href={`/schema/${ref.collection}`} className="underline underline-offset-4">
                  {ref.admin.label ?? ref.collection}
                </Link>
                <span className="text-muted-foreground">via</span>
                <code className="font-mono text-xs">{ref.field}</code>
                {ref.many && <Badge variant="outline">many</Badge>}
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className="mt-8">{CODE_LINE(info.key)}</div>
    </div>
  );
}

export default SchemaIndexPage;
