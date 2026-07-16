/**
 * DocSheet — a Sheet (drawer) hosting DocumentForm for create/edit-in-place:
 * the same form as the page editor, in a second container. Used by
 * RelationPicker ("Create new" auto-connect) and RelatedContent (edit/add
 * inverse-related docs). Save + optional publish live inside the sheet.
 */
import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import * as api from './../api';
import type { Envelope } from '../types';
import { DocumentForm, SAVE_STATE_LABEL, type DocumentFormHandle, type FormSaveState } from './DocumentForm';
import { StatusPill } from './StatusPill';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './ui/sheet';

export interface DocSheetProps {
  collection: string;
  /** Null = create mode. */
  docId: string | null;
  /** Prefill for create mode (e.g. the inverse relation field). */
  initial?: Record<string, unknown>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fires after every successful persist (saves, autosaves, publishes). */
  onSaved?: (env: Envelope) => void;
  /** Fires once, when a create-mode sheet persists its new document. */
  onCreated?: (env: Envelope) => void;
}

export function DocSheet({ collection, docId, initial, open, onOpenChange, onSaved, onCreated }: DocSheetProps) {
  const formRef = useRef<DocumentFormHandle>(null);
  const [state, setState] = useState<FormSaveState>('idle');
  const [created, setCreated] = useState<Envelope | null>(null);
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();

  const schemaQ = useQuery({ queryKey: ['schema', collection], queryFn: () => api.schema(collection), enabled: open });
  const effectiveId = created?.docId ?? docId;
  const docQ = useQuery({
    queryKey: ['doc', collection, effectiveId],
    queryFn: () => api.getDoc(collection, effectiveId!, { status: 'draft' }),
    enabled: open && !!effectiveId,
  });

  // Fresh create-mode sheet on every open.
  useEffect(() => {
    if (!open) setCreated(null);
  }, [open]);

  const guardedOpenChange = (next: boolean) => {
    if (!next && formRef.current?.isDirty() && !window.confirm('Discard unsaved changes?')) return;
    onOpenChange(next);
  };

  // Ref-guarded so the keyboard handler (registered once per open) never races.
  const busyRef = useRef(false);
  const doSave = async (publish: boolean) => {
    if (!formRef.current || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const env = await formRef.current.save(publish ? { publish: true } : {});
      if (env) toast.success(publish ? 'Saved & published' : created || docId ? 'Draft saved' : 'Draft created');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  // ⌘S save / ⌘⇧Enter publish, captured so the page editor underneath
  // doesn't also react while the sheet is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() === 's') {
        e.preventDefault();
        e.stopPropagation();
        void doSave(false);
      } else if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        void doSave(true);
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const label = schemaQ.data?.admin.label ?? collection;
  const env = created ?? (effectiveId ? (docQ.data ?? null) : null);
  const loading = schemaQ.isPending || (!!effectiveId && docQ.isPending && !created);

  return (
    <Sheet open={open} onOpenChange={guardedOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl" data-doc-sheet={collection}>
        <SheetHeader className="border-b px-6 py-4">
          <SheetTitle className="flex items-center gap-2.5 pr-8 text-base">
            <span className="truncate">
              {effectiveId ? 'Edit' : 'New'} {label}
            </span>
            {env && <StatusPill env={env} />}
            {state !== 'idle' && <span className="text-xs font-normal text-muted-foreground">{SAVE_STATE_LABEL[state]}</span>}
          </SheetTitle>
          <SheetDescription className="sr-only">Edit this document without leaving the page.</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {loading && (
            <div className="grid gap-4">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-2/3" />
              <Skeleton className="h-28 w-full" />
            </div>
          )}
          {!loading && schemaQ.isError && <p className="text-sm text-destructive">Couldn’t load the schema for {collection}.</p>}
          {!loading && !!effectiveId && docQ.isError && <p className="text-sm text-destructive">Couldn’t load this document.</p>}
          {!loading && schemaQ.data && (!effectiveId || env) && (
            <DocumentForm
              ref={formRef}
              collection={collection}
              fields={schemaQ.data.fields ?? {}}
              admin={schemaQ.data.admin}
              doc={env}
              {...(initial ? { initial } : {})}
              onState={setState}
              onSaved={(saved, info) => {
                queryClient.setQueryData(['doc', collection, saved.docId], saved);
                if (info.created) {
                  setCreated(saved);
                  onCreated?.(saved);
                }
                if (!info.created && created) setCreated(saved);
                onSaved?.(saved);
              }}
            />
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t px-6 py-3">
          <Button variant="outline" disabled={busy || loading} onClick={() => void doSave(false)} data-action="sheet-save">
            Save draft
          </Button>
          <Button disabled={busy || loading} onClick={() => void doSave(true)} data-action="sheet-publish">
            {effectiveId ? 'Save & publish' : 'Create & publish'}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
