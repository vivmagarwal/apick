/**
 * RelatedContent — the inverse-relation panels (THE differentiator, per spec):
 * one panel per `referencedBy` entry, listing documents whose relation field
 * points at THIS document. Rows drag-reorder (persisted by PATCHing evenly
 * spaced values 10,20,30… into their admin.orderField), edit in a Sheet,
 * unlink with confirm, and "+ Add" opens a Sheet on a NEW doc with the
 * relation pre-filled. Hidden on unsaved new docs (the caller guards that).
 */
import * as React from 'react';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { GripVertical, Pencil, Plus, Unlink } from 'lucide-react';
import * as api from '../api';
import type { Envelope, ReferencedBy } from '../types';
import { cn } from '../lib/utils';
import { docTitle, titleFieldFor } from './fields/utils';
import { StatusPill } from './StatusPill';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Skeleton } from './ui/skeleton';
import { DocSheet } from './DocSheet';

export function RelatedContent({ collection, docId, referencedBy }: { collection: string; docId: string; referencedBy: ReferencedBy[] }) {
  if (referencedBy.length === 0) return null;
  return (
    <section className="grid gap-4" data-related-content={collection}>
      {referencedBy.map((ref) => (
        <RelatedPanel key={`${ref.collection}.${ref.field}`} docId={docId} refBy={ref} />
      ))}
    </section>
  );
}

function RelatedPanel({ docId, refBy }: { docId: string; refBy: ReferencedBy }) {
  const { collection: theirs, field, many } = refBy;
  const label = refBy.admin.label ?? theirs;
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [reordering, setReordering] = useState(false);
  const queryClient = useQueryClient();

  const schemaQ = useQuery({ queryKey: ['schema', theirs], queryFn: () => api.schema(theirs) });
  const orderField = refBy.admin.orderField ?? schemaQ.data?.admin.orderField;
  const titleField = refBy.admin.titleField ?? (schemaQ.data ? titleFieldFor(schemaQ.data.fields ?? {}, schemaQ.data.admin) : null);

  const listKey = ['related', theirs, field, docId];
  const listQ = useQuery({
    queryKey: listKey,
    queryFn: () =>
      api.listDocs(theirs, {
        status: 'draft',
        filter: many ? { [field]: { $contains: docId } } : { [field]: docId },
        sort: orderField ?? '-updatedAt',
        pageSize: 100,
        count: true,
      }),
    enabled: !schemaQ.isPending, // wait so orderField-based sort is stable
  });

  const rows = listQ.data?.data ?? [];
  const total = listQ.data?.meta.total ?? rows.length;

  const refresh = () => queryClient.invalidateQueries({ queryKey: listKey });

  const unlink = async (row: Envelope) => {
    const title = docTitle(row, titleField);
    if (!window.confirm(`Unlink “${title}”? The document itself is kept.`)) return;
    try {
      if (many) {
        const current = Array.isArray(row.data[field]) ? (row.data[field] as string[]) : [];
        await api.patchDoc(theirs, row.docId, { [field]: current.filter((id) => id !== docId) });
      } else {
        await api.patchDoc(theirs, row.docId, { [field]: null });
      }
      toast.success(`Unlinked ${title}`);
      void refresh();
    } catch (err) {
      toast.error(err instanceof api.RequestError ? err.error.message : String(err));
    }
  };

  /** Persist a new visual order as evenly spaced orderField values (10, 20, 30…). */
  const persistOrder = async (next: Envelope[]) => {
    if (!orderField) return;
    // Optimistic: show the new order immediately.
    queryClient.setQueryData(listKey, (prev: { data: Envelope[]; meta: { page: number; pageSize: number; total?: number } } | undefined) =>
      prev ? { ...prev, data: next } : prev,
    );
    setReordering(true);
    const patches = next
      .map((row, i) => ({ row, target: (i + 1) * 10 }))
      .filter(({ row, target }) => row.data[orderField] !== target);
    const results = await Promise.allSettled(patches.map(({ row, target }) => api.patchDoc(theirs, row.docId, { [orderField]: target })));
    setReordering(false);
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) toast.error(`Reorder: ${failed} of ${patches.length} updates failed`);
    void refresh();
  };

  const onDropRow = (to: number) => {
    if (dragIndex === null || dragIndex === to) return;
    const next = rows.slice();
    const [moved] = next.splice(dragIndex, 1);
    next.splice(to, 0, moved!);
    void persistOrder(next);
  };

  return (
    <Card data-related-panel={`${theirs}.${field}`}>
      <CardHeader className="flex-row items-center justify-between space-y-0 py-4">
        <CardTitle className="text-sm font-semibold">
          {label} <span className="font-normal text-muted-foreground">— {total}</span>
        </CardTitle>
        <Button variant="outline" size="sm" className="gap-1.5" data-action={`add-related:${theirs}`} onClick={() => setAdding(true)}>
          <Plus /> Add {label}
        </Button>
      </CardHeader>
      <CardContent className="pb-4 pt-0">
        {listQ.isPending && (
          <div className="grid gap-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        )}
        {listQ.isError && <p className="text-sm text-destructive">Couldn’t load related {label}.</p>}
        {listQ.data && rows.length === 0 && (
          <p className="py-2 text-sm text-muted-foreground">Nothing links here yet — add the first one.</p>
        )}
        {rows.length > 0 && (
          <ul className={cn('grid gap-1.5', reordering && 'pointer-events-none opacity-60')}>
            {rows.map((row, i) => (
              <li
                key={row.docId}
                data-related-row={row.docId}
                className={cn(
                  'flex items-center gap-2 rounded-md border bg-card px-2 py-1.5 text-sm',
                  dropIndex === i && dragIndex !== null && dragIndex !== i && 'border-dashed border-ring',
                  dragIndex === i && 'opacity-60',
                )}
                onDragOver={(e) => {
                  if (dragIndex === null) return;
                  e.preventDefault();
                  setDropIndex(i);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  onDropRow(i);
                  setDragIndex(null);
                  setDropIndex(null);
                }}
              >
                {orderField && rows.length > 1 && (
                  <span
                    draggable
                    title="Drag to reorder"
                    className="cursor-grab rounded p-0.5 text-muted-foreground hover:bg-accent active:cursor-grabbing"
                    onDragStart={(e) => {
                      setDragIndex(i);
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', String(i));
                    }}
                    onDragEnd={() => {
                      setDragIndex(null);
                      setDropIndex(null);
                    }}
                  >
                    <GripVertical className="size-4" />
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">{docTitle(row, titleField)}</span>
                <StatusPill env={row} />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground"
                  title="Edit"
                  data-action={`edit-related:${row.docId}`}
                  onClick={() => setEditing(row.docId)}
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  title="Unlink"
                  data-action={`unlink-related:${row.docId}`}
                  onClick={() => void unlink(row)}
                >
                  <Unlink className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <DocSheet
        collection={theirs}
        docId={editing}
        open={editing !== null}
        onOpenChange={(o) => {
          if (!o) setEditing(null);
        }}
        onSaved={() => void refresh()}
      />
      <DocSheet
        collection={theirs}
        docId={null}
        initial={{ [field]: many ? [docId] : docId }}
        open={adding}
        onOpenChange={setAdding}
        onSaved={() => void refresh()}
      />
    </Card>
  );
}
