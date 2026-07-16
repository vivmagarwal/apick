/**
 * RelationPicker — to-one and to-many relation editor per the spec:
 * combobox popover with 300ms-debounced `?search=` against the TARGET
 * collection (falling back to titleField $icontains when FTS is unavailable),
 * options show the target's title + status pill, selection renders as a chip
 * (one) or drag-reorderable rows (many), and a pinned "Create new" option
 * opens the target's editor in a Sheet with the created doc auto-connected.
 */
import * as React from 'react';
import { useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronsUpDown, GripVertical, Link2, Plus, X } from 'lucide-react';
import * as api from '../api';
import type { Envelope, FieldDef } from '../types';
import { cn } from '../lib/utils';
import { useDebouncedValue } from '../lib/hooks';
import { titleFieldFor, docTitle } from './fields/utils';
import { StatusPill } from './StatusPill';
import { Button } from './ui/button';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from './ui/command';
import { DocSheet } from './DocSheet';

export interface RelationPickerProps {
  path: string;
  def: FieldDef; // type "relation": to + many
  value: unknown;
  onChange: (v: unknown) => void;
}

/** Search the target collection: FTS first, title $icontains as fallback. */
async function searchTarget(target: string, q: string, titleField: string | null): Promise<Envelope[]> {
  const base = { status: 'draft' as const, pageSize: 10 };
  if (!q) return (await api.listDocs(target, { ...base, sort: '-updatedAt' })).data;
  try {
    return (await api.listDocs(target, { ...base, search: q })).data;
  } catch (err) {
    if (err instanceof api.RequestError && err.status === 400 && titleField) {
      return (await api.listDocs(target, { ...base, filter: { [titleField]: { $icontains: q } }, sort: '-updatedAt' })).data;
    }
    throw err;
  }
}

export function RelationPicker({ path, def, value, onChange }: RelationPickerProps) {
  const target = def.to ?? '';
  const many = def.many === true;
  const ids: string[] = many
    ? Array.isArray(value)
      ? (value as string[]).filter((v): v is string => typeof v === 'string')
      : []
    : typeof value === 'string' && value
      ? [value]
      : [];

  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const debounced = useDebouncedValue(query, 300);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const queryClient = useQueryClient();

  const schemaQ = useQuery({ queryKey: ['schema', target], queryFn: () => api.schema(target), enabled: !!target });
  const titleField = schemaQ.data ? titleFieldFor(schemaQ.data.fields ?? {}, schemaQ.data.admin) : null;
  const targetLabel = schemaQ.data?.admin.label ?? target;

  const searchQ = useQuery({
    // titleField is in the key so the $icontains fallback re-runs once the
    // target schema (and thus the fallback field) is known.
    queryKey: ['relation-search', target, debounced, titleField],
    queryFn: () => searchTarget(target, debounced, titleField),
    enabled: open && !!target,
    placeholderData: (prev) => prev,
  });

  // Labels + status for the connected ids (seeded from picked search hits).
  const rowQs = useQueries({
    queries: ids.map((id) => ({
      queryKey: ['doc', target, id],
      queryFn: () => api.getDoc(target, id, { status: 'draft' }),
      staleTime: 30_000,
      retry: false,
    })),
  });

  const connect = (env: Envelope) => {
    queryClient.setQueryData(['doc', target, env.docId], env);
    if (many) {
      if (!ids.includes(env.docId)) onChange([...ids, env.docId]);
    } else {
      onChange(env.docId);
    }
    setOpen(false);
    setQuery('');
  };

  const disconnect = (id: string) => {
    if (many) {
      const next = ids.filter((x) => x !== id);
      onChange(next.length ? next : []);
    } else {
      onChange(null);
    }
  };

  const reorder = (from: number, to: number) => {
    if (from === to) return;
    const next = ids.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    onChange(next);
  };

  const hits = (searchQ.data ?? []).filter((h) => !ids.includes(h.docId));

  const row = (id: string, i: number) => {
    const env = rowQs[i]?.data;
    const failed = rowQs[i]?.isError === true;
    return (
      <div
        key={id}
        data-relation-row={id}
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
          if (dragIndex !== null) reorder(dragIndex, i);
          setDragIndex(null);
          setDropIndex(null);
        }}
      >
        {many && ids.length > 1 && (
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
        <Link2 className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{env ? docTitle(env, titleField) : failed ? `${id.slice(0, 8)}… (missing)` : `${id.slice(0, 8)}…`}</span>
        {env && <StatusPill env={env} />}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 text-muted-foreground"
          title="Remove"
          onClick={() => disconnect(id)}
        >
          <X className="size-3.5" />
        </Button>
      </div>
    );
  };

  return (
    <div className="grid gap-2" data-relation={path}>
      {ids.length > 0 && <div className="grid gap-1.5">{ids.map(row)}</div>}
      <div>
        <Popover
          open={open}
          onOpenChange={(o) => {
            setOpen(o);
            if (!o) setQuery('');
          }}
        >
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="gap-1.5 text-muted-foreground" data-input={path} aria-expanded={open}>
              <ChevronsUpDown /> {many ? 'Add relation' : ids.length ? 'Change relation' : 'Set relation'}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-0" align="start">
            <Command shouldFilter={false}>
              <CommandInput placeholder={`Search ${targetLabel}…`} value={query} onValueChange={setQuery} />
              <CommandList>
                {searchQ.isError && <CommandEmpty>Search failed — try again.</CommandEmpty>}
                {!searchQ.isError && hits.length === 0 && (
                  <CommandEmpty>{searchQ.isFetching ? 'Searching…' : query ? 'No matches.' : 'Nothing to link yet.'}</CommandEmpty>
                )}
                {hits.length > 0 && (
                  <CommandGroup>
                    {hits.map((hit) => (
                      <CommandItem key={hit.docId} value={hit.docId} onSelect={() => connect(hit)}>
                        <Link2 className="text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{docTitle(hit, titleField)}</span>
                        <StatusPill env={hit} />
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    value="__create__"
                    onSelect={() => {
                      setOpen(false);
                      setCreating(true);
                    }}
                  >
                    <Plus className="text-muted-foreground" /> Create new {targetLabel}…
                  </CommandItem>
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
      <DocSheet
        collection={target}
        docId={null}
        open={creating}
        onOpenChange={setCreating}
        onCreated={(env) => connect(env)}
      />
    </div>
  );
}
