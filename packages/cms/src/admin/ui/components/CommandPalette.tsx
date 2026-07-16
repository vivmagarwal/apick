/**
 * ⌘K command palette — per spec: jump to collections, search content across
 * collections via /v1/search (api.searchAll), and quick actions (New
 * <collection>…, Media, Schema). Opens on the Shell's topbar button and the
 * global ⌘K shortcut, both of which dispatch COMMAND_PALETTE_EVENT.
 */
import * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { Braces, FileText, Image, Plus } from 'lucide-react';
import * as api from '../api';
import type { AdminHints, CollectionInfo, Envelope } from '../types';
import { useDebouncedValue } from '../lib/hooks';
import { StatusPill } from './StatusPill';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from './ui/command';

/** The Shell's topbar button and ⌘K handler dispatch this to open the palette. */
export const COMMAND_PALETTE_EVENT = 'apick:command-palette';

/** Best-effort title for a search hit: admin.titleField, common keys, first string. */
function hitTitle(env: Envelope, admin: AdminHints): string {
  const keys = [admin.titleField, 'title', 'name', 'headline'].filter((k): k is string => !!k);
  for (const key of keys) {
    const v = env.data[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  for (const v of Object.values(env.data)) {
    if (typeof v === 'string' && v.trim()) return v.length > 80 ? `${v.slice(0, 77)}…` : v;
  }
  return env.docId.slice(0, 8);
}

export function CommandPalette({ collections }: { collections: CollectionInfo[] }) {
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const debounced = useDebouncedValue(query, 300);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(COMMAND_PALETTE_EVENT, onOpen);
    return () => window.removeEventListener(COMMAND_PALETTE_EVENT, onOpen);
  }, []);

  const contentCollections = useMemo(() => collections.filter((c) => c.key !== 'cms-users' && c.key !== 'media'), [collections]);

  const searchQ = useQuery({
    queryKey: ['palette-search', debounced],
    queryFn: () => api.searchAll(debounced, { status: 'draft', pageSize: 5 }),
    enabled: open && debounced.trim().length > 0,
    placeholderData: (prev) => prev,
    retry: false,
  });

  const go = (path: string) => {
    setOpen(false);
    setQuery('');
    navigate(path);
  };

  // We filter manually (cmdk's own filter would hide server-side search hits
  // whose titles don't contain the query text).
  const q = query.trim().toLowerCase();
  const matches = (text: string) => q === '' || text.toLowerCase().includes(q);
  const jumpables = contentCollections.filter((c) => matches(c.admin.label ?? c.key) || matches(c.key));
  const groups = (searchQ.data ?? []).filter((g) => g.hits.length > 0);
  const searching = debounced.trim().length > 0;

  const staticActions: Array<{ id: string; label: string; icon: React.ReactNode; path: string }> = [
    { id: 'media', label: 'Media library', icon: <Image className="text-muted-foreground" />, path: '/media' },
    { id: 'schema', label: 'Schema inspector', icon: <Braces className="text-muted-foreground" />, path: '/schema' },
  ];
  const actions = staticActions.filter((a) => matches(a.label));
  const newActions = contentCollections.filter((c) => matches(`new ${c.admin.label ?? c.key}`));

  const nothing = jumpables.length === 0 && actions.length === 0 && newActions.length === 0 && groups.length === 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery('');
      }}
    >
      <DialogContent className="overflow-hidden p-0 [&>button]:hidden" data-view="command-palette">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">Jump to a collection, search content, or run an action.</DialogDescription>
        <Command
          shouldFilter={false}
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2"
        >
          <CommandInput placeholder="Search content, jump to a collection, run an action…" value={query} onValueChange={setQuery} />
          <CommandList>
            {nothing && <CommandEmpty>{searchQ.isFetching ? 'Searching…' : 'No results.'}</CommandEmpty>}

            {jumpables.length > 0 && (
              <CommandGroup heading="Collections">
                {jumpables.map((col) => (
                  <CommandItem key={`jump-${col.key}`} value={`jump-${col.key}`} onSelect={() => go(`/c/${col.key}`)}>
                    {col.admin.icon ? (
                      <span className="flex size-4 items-center justify-center text-sm leading-none" aria-hidden>
                        {col.admin.icon}
                      </span>
                    ) : (
                      <FileText className="text-muted-foreground" />
                    )}
                    {col.admin.label ?? col.key}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {searching && groups.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Content">
                  {groups.flatMap((group) =>
                    group.hits.map((hit) => (
                      <CommandItem
                        key={`hit-${group.collection}-${hit.docId}`}
                        value={`hit-${group.collection}-${hit.docId}`}
                        onSelect={() => go(`/c/${group.collection}/${hit.docId}`)}
                      >
                        <FileText className="text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{hitTitle(hit, group.admin)}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{group.admin.label ?? group.collection}</span>
                        <StatusPill env={hit} />
                      </CommandItem>
                    )),
                  )}
                </CommandGroup>
              </>
            )}
            {searching && searchQ.isError && (
              <>
                <CommandSeparator />
                <p className="px-3 py-2 text-xs text-muted-foreground">Content search unavailable for this account.</p>
              </>
            )}

            {(newActions.length > 0 || actions.length > 0) && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Actions">
                  {newActions.map((col) => (
                    <CommandItem key={`new-${col.key}`} value={`new-${col.key}`} onSelect={() => go(`/c/${col.key}/new`)}>
                      <Plus className="text-muted-foreground" />
                      New {col.admin.label ?? col.key}…
                    </CommandItem>
                  ))}
                  {actions.map((a) => (
                    <CommandItem key={a.id} value={`action-${a.id}`} onSelect={() => go(a.path)}>
                      {a.icon}
                      {a.label}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
