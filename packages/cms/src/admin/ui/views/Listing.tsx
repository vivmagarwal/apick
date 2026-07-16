/**
 * Collection listing (/admin/c/:key) — searchable, filterable, sortable table
 * with bulk actions, per the spec: FTS `?search=` with a titleField $icontains
 * fallback, client-side status filter, auto columns (titleField + next two
 * presentable scalars + status pill + updated), 25/page pagination, checkbox
 * multi-select with a Publish/Unpublish/Delete bulk bar (confirm dialog,
 * parallel calls, one summary toast), "+ New", and row click → editor.
 */
import * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, ArrowUpDown, FilePlus2, Plus, SearchX } from 'lucide-react';
import * as api from '../api';
import type { Envelope, FieldDef } from '../types';
import { cn, formatDateTime, timeAgo } from '../lib/utils';
import { useDebouncedValue } from '../lib/hooks';
import { StatusPill, statusOf, type DocStatus } from '../components/StatusPill';
import { fieldLabel, titleFieldFor } from '../components/fields/utils';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';

const PAGE_SIZE = 25;

/** Scalar types that read well in a table cell (and are sortable server-side). */
const PRESENTABLE = new Set(['text', 'enum', 'integer', 'number', 'boolean', 'datetime', 'date']);

/** titleField first, then the next two presentable scalars. */
function columnsFor(fields: Record<string, FieldDef>, titleField: string | null): string[] {
  const cols: string[] = titleField ? [titleField] : [];
  for (const [key, def] of Object.entries(fields)) {
    if (cols.length >= 3) break;
    if (key === titleField) continue;
    if (def.private || !PRESENTABLE.has(def.type)) continue;
    if (def.format === 'markdown') continue; // walls of prose don't belong in a cell
    cols.push(key);
  }
  return cols;
}

function cellText(value: unknown, def: FieldDef | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (def && (def.type === 'datetime' || def.type === 'date')) return formatDateTime(String(value));
  const text = String(value);
  return text.length > 64 ? `${text.slice(0, 61)}…` : text;
}

type StatusFilter = 'all' | DocStatus;

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'All statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'modified', label: 'Modified' },
  { value: 'published', label: 'Published' },
  { value: 'scheduled', label: 'Scheduled' },
];

interface SortState {
  key: string; // field key or "updatedAt"
  desc: boolean;
}

/** FTS first; on a 400 (collection not FTS-enabled) fall back to $icontains on the title field. */
async function fetchPage(
  collection: string,
  opts: { search: string; sort: string | undefined; page: number; titleField: string | null },
): Promise<api.ListResult & { fallback: boolean }> {
  const base: api.ListDocsParams = {
    status: 'draft',
    page: opts.page,
    pageSize: PAGE_SIZE,
    count: true,
    ...(opts.sort ? { sort: opts.sort } : {}),
  };
  if (!opts.search) return { ...(await api.listDocs(collection, { ...base, sort: opts.sort ?? '-updatedAt' })), fallback: false };
  try {
    return { ...(await api.listDocs(collection, { ...base, search: opts.search })), fallback: false };
  } catch (err) {
    if (err instanceof api.RequestError && err.status === 400 && opts.titleField) {
      const res = await api.listDocs(collection, {
        ...base,
        sort: opts.sort ?? '-updatedAt',
        filter: { [opts.titleField]: { $icontains: opts.search } },
      });
      return { ...res, fallback: true };
    }
    throw err;
  }
}

type BulkAction = 'publish' | 'unpublish' | 'delete';

const BULK_COPY: Record<BulkAction, { title: string; body: string; verb: string; done: string }> = {
  publish: { title: 'Publish selected?', body: 'The current draft of each selected document goes live.', verb: 'Publish', done: 'published' },
  unpublish: { title: 'Unpublish selected?', body: 'Each selected document is taken offline; drafts are kept.', verb: 'Unpublish', done: 'unpublished' },
  delete: { title: 'Delete selected?', body: 'Documents are deleted. Version history is kept for audit.', verb: 'Delete', done: 'deleted' },
};

export function ListingPage({ collection }: { collection: string }) {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search, 300);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [sort, setSort] = useState<SortState | null>(null); // null = default (rank while searching, else -updatedAt)
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState<BulkAction | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const schemaQ = useQuery({ queryKey: ['schema', collection], queryFn: () => api.schema(collection) });
  const fields = schemaQ.data?.fields ?? {};
  const admin = schemaQ.data?.admin;
  const canWrite = !!schemaQ.data?.fields;
  const label = admin?.label ?? collection;
  const titleField = useMemo(() => titleFieldFor(fields, admin), [fields, admin]);
  const columns = useMemo(() => columnsFor(fields, titleField), [fields, titleField]);

  const sortParam = sort ? `${sort.desc ? '-' : ''}${sort.key}` : undefined;

  const listQ = useQuery({
    queryKey: ['listing', collection, debounced, sortParam ?? '', page, titleField],
    queryFn: () => fetchPage(collection, { search: debounced, sort: sortParam, page, titleField }),
    enabled: !!schemaQ.data,
    placeholderData: (prev) => prev,
  });

  // New collection / new search / new filter → back to page 1, selection cleared.
  useEffect(() => {
    setPage(1);
    setSelected(new Set());
  }, [collection, debounced, status]);

  const rows = useMemo(() => {
    const all = listQ.data?.data ?? [];
    return status === 'all' ? all : all.filter((env) => statusOf(env) === status);
  }, [listQ.data, status]);

  const total = listQ.data?.meta.total ?? rows.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const toggleSort = (key: string) => {
    setSelected(new Set());
    setSort((prev) => (prev?.key === key ? (prev.desc ? { key, desc: false } : null) : { key, desc: true }));
  };
  const sortable = (key: string) => key === 'updatedAt' || PRESENTABLE.has(fields[key]?.type ?? '');

  const allOnPageSelected = rows.length > 0 && rows.every((r) => selected.has(r.docId));
  const toggleAll = () => {
    setSelected(allOnPageSelected ? new Set() : new Set(rows.map((r) => r.docId)));
  };
  const toggleOne = (docId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(docId)) next.delete(docId);
      else next.add(docId);
      return next;
    });
  };

  const runBulk = async (action: BulkAction) => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(
        ids.map((id) =>
          action === 'publish'
            ? api.publishDoc(collection, id)
            : action === 'unpublish'
              ? api.unpublishDoc(collection, id)
              : api.deleteDoc(collection, id),
        ),
      );
      const failed = results.filter((r) => r.status === 'rejected').length;
      const ok = ids.length - failed;
      const summary = `${ok} ${BULK_COPY[action].done}${failed ? `, ${failed} failed` : ''}`;
      if (failed === 0) toast.success(summary);
      else if (ok === 0) toast.error(summary);
      else toast.warning(summary);
      setSelected(new Set());
      setConfirming(null);
      await queryClient.invalidateQueries({ queryKey: ['listing', collection] });
      await queryClient.invalidateQueries({ queryKey: ['dashboard-count', collection] });
    } finally {
      setBulkBusy(false);
    }
  };

  // ---- render ---------------------------------------------------------------------

  if (schemaQ.isPending) {
    return (
      <div data-view="listing">
        <div className="mb-4 flex items-center gap-3">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-9 w-36" />
          <Skeleton className="ml-auto h-9 w-24" />
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (schemaQ.isError) {
    return (
      <Card className="mx-auto mt-12 max-w-lg">
        <CardContent className="p-6 text-sm">
          <p className="font-medium">Couldn’t load this collection</p>
          <p className="mt-1 text-muted-foreground">{schemaQ.error instanceof api.RequestError ? schemaQ.error.error.message : String(schemaQ.error)}</p>
        </CardContent>
      </Card>
    );
  }

  const loading = listQ.isPending;
  const emptyBecauseFilter = !loading && rows.length === 0 && (debounced !== '' || status !== 'all');
  const emptyCollection = !loading && rows.length === 0 && debounced === '' && status === 'all';
  const colSpan = columns.length + 3; // checkbox + status + updated

  return (
    <div data-view="listing" data-table={collection}>
      {/* ---- toolbar ------------------------------------------------------------- */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Input
          type="search"
          placeholder={`Search ${label}…`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-64"
          aria-label={`Search ${label}`}
        />
        <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
          <SelectTrigger className="w-40" aria-label="Filter by status" data-input="status-filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground">
          {listQ.data ? `${total} ${total === 1 ? 'entry' : 'entries'}` : ''}
          {listQ.data?.fallback ? ' · title match' : ''}
        </span>
        {canWrite && (
          <Button size="sm" className="ml-auto gap-1.5" data-action="new" onClick={() => navigate(`/c/${collection}/new`)}>
            <Plus /> New
          </Button>
        )}
      </div>

      {/* ---- bulk bar -------------------------------------------------------------- */}
      {selected.size > 0 && (
        <div className="mb-3 flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm" data-bulk-bar>
          <span className="font-medium">{selected.size} selected</span>
          <span className="flex-1" />
          <Button variant="outline" size="sm" disabled={bulkBusy} data-action="bulk-publish" onClick={() => setConfirming('publish')}>
            Publish
          </Button>
          <Button variant="outline" size="sm" disabled={bulkBusy} data-action="bulk-unpublish" onClick={() => setConfirming('unpublish')}>
            Unpublish
          </Button>
          <Button variant="destructive" size="sm" disabled={bulkBusy} data-action="bulk-delete" onClick={() => setConfirming('delete')}>
            Delete
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      {/* ---- table ------------------------------------------------------------------ */}
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  aria-label="Select all on this page"
                  checked={allOnPageSelected}
                  onChange={toggleAll}
                  disabled={rows.length === 0}
                />
              </TableHead>
              {columns.map((col) => (
                <TableHead key={col}>
                  {sortable(col) ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 hover:text-foreground [&_svg]:size-3.5"
                      data-sort={col}
                      onClick={() => toggleSort(col)}
                    >
                      {fieldLabel(col)}
                      {sort?.key === col ? sort.desc ? <ArrowDown /> : <ArrowUp /> : <ArrowUpDown className="opacity-40" />}
                    </button>
                  ) : (
                    fieldLabel(col)
                  )}
                </TableHead>
              ))}
              <TableHead>Status</TableHead>
              <TableHead>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 hover:text-foreground [&_svg]:size-3.5"
                  data-sort="updatedAt"
                  onClick={() => toggleSort('updatedAt')}
                >
                  Updated
                  {sort?.key === 'updatedAt' ? sort.desc ? <ArrowDown /> : <ArrowUp /> : <ArrowUpDown className="opacity-40" />}
                </button>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading &&
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={colSpan}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {!loading && listQ.isError && (
              <TableRow>
                <TableCell colSpan={colSpan} className="py-10 text-center text-sm text-destructive">
                  Couldn’t load documents: {listQ.error instanceof api.RequestError ? listQ.error.error.message : String(listQ.error)}
                </TableCell>
              </TableRow>
            )}
            {emptyCollection && (
              <TableRow>
                <TableCell colSpan={colSpan}>
                  <div className="flex flex-col items-center gap-3 py-12 text-center">
                    <FilePlus2 className="size-8 text-muted-foreground/50" />
                    <p className="text-sm text-muted-foreground">Nothing in {label} yet.</p>
                    {canWrite && (
                      <Button size="sm" className="gap-1.5" onClick={() => navigate(`/c/${collection}/new`)}>
                        <Plus /> Create the first one
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            )}
            {emptyBecauseFilter && (
              <TableRow>
                <TableCell colSpan={colSpan}>
                  <div className="flex flex-col items-center gap-3 py-12 text-center">
                    <SearchX className="size-8 text-muted-foreground/50" />
                    <p className="text-sm text-muted-foreground">No documents match{debounced ? ` “${debounced}”` : ''}{status !== 'all' ? ` with status “${status}”` : ''}.</p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setSearch('');
                        setStatus('all');
                      }}
                    >
                      Clear search & filters
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            )}
            {!loading &&
              rows.map((env: Envelope) => (
                <TableRow
                  key={env.docId}
                  data-doc={env.docId}
                  className={cn('cursor-pointer', selected.has(env.docId) && 'bg-accent/40')}
                  onClick={() => navigate(`/c/${collection}/${env.docId}`)}
                >
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      aria-label={`Select ${env.docId}`}
                      checked={selected.has(env.docId)}
                      onChange={() => toggleOne(env.docId)}
                    />
                  </TableCell>
                  {columns.map((col, i) => (
                    <TableCell key={col} className={cn(i === 0 && 'font-medium')}>
                      {cellText(env.data[col], fields[col])}
                    </TableCell>
                  ))}
                  <TableCell>
                    <StatusPill env={env} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground" title={formatDateTime(env.updatedAt)}>
                    {timeAgo(env.updatedAt)}
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </div>

      {/* ---- pagination ---------------------------------------------------------------- */}
      {pages > 1 && (
        <div className="mt-4 flex items-center justify-end gap-3 text-sm">
          <span className="text-muted-foreground">
            Page {page} of {pages}
          </span>
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            ← Prev
          </Button>
          <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            Next →
          </Button>
        </div>
      )}

      {/* ---- bulk confirm ----------------------------------------------------------------- */}
      <Dialog open={confirming !== null} onOpenChange={(o) => !o && setConfirming(null)}>
        <DialogContent className="max-w-sm" data-view="bulk-confirm">
          {confirming && (
            <>
              <DialogHeader>
                <DialogTitle>{BULK_COPY[confirming].title}</DialogTitle>
                <DialogDescription>
                  {selected.size} {selected.size === 1 ? 'document' : 'documents'} — {BULK_COPY[confirming].body}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" disabled={bulkBusy} onClick={() => setConfirming(null)}>
                  Cancel
                </Button>
                <Button
                  variant={confirming === 'delete' ? 'destructive' : 'default'}
                  disabled={bulkBusy}
                  data-action="bulk-confirm"
                  onClick={() => void runBulk(confirming)}
                >
                  {bulkBusy ? 'Working…' : `${BULK_COPY[confirming].verb} ${selected.size}`}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default ListingPage;
