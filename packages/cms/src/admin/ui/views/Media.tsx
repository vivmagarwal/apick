/**
 * Media library (/admin/media) — upload (button + drag-drop zone), grid of
 * thumbnails (icon tiles for non-images), filename search, and a detail Sheet
 * per item: preview, alt-text editing, copy URL, delete. Endpoints per
 * ui-legacy/media.ts via the api.ts media helpers.
 */
import * as React from 'react';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, ExternalLink, ImageOff, Trash2 } from 'lucide-react';
import * as api from '../api';
import type { MediaItem } from '../types';
import { useDebouncedValue } from '../lib/hooks';
import { formatBytes, isImage, MediaThumb, UploadZone } from '../components/MediaPicker';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Separator } from '../components/ui/separator';
import { Skeleton } from '../components/ui/skeleton';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../components/ui/sheet';

const PAGE_SIZE = 24;

function errText(err: unknown): string {
  return err instanceof api.RequestError ? err.error.message : String(err);
}

// ---- detail sheet ---------------------------------------------------------------

function MediaDetailSheet({
  item,
  open,
  onOpenChange,
  onDeleted,
}: {
  item: MediaItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const [alt, setAlt] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setAlt(item?.alt ?? '');
  }, [item?.docId, item?.alt]);

  if (!item) return null;
  const fullUrl = `${window.location.origin}${item.url}`;
  const altDirty = alt !== item.alt;

  const saveAlt = async () => {
    setBusy(true);
    try {
      await api.patchMedia(item.docId, { alt });
      await queryClient.invalidateQueries({ queryKey: ['media'] });
      toast.success('Alt text saved');
    } catch (err) {
      toast.error(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const copyUrl = () => {
    void navigator.clipboard.writeText(fullUrl).then(
      () => toast.success('URL copied'),
      () => toast.error('Couldn’t copy URL'),
    );
  };

  const remove = async () => {
    if (!window.confirm(`Delete ${item.filename}? References to it will break.`)) return;
    setBusy(true);
    try {
      await api.deleteMedia(item.docId);
      await queryClient.invalidateQueries({ queryKey: ['media'] });
      toast.success('File deleted');
      onDeleted();
    } catch (err) {
      toast.error(errText(err));
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-md" data-view="media-detail">
        <SheetHeader className="border-b px-6 py-4">
          <SheetTitle className="truncate pr-8 text-base" title={item.filename}>
            {item.filename}
          </SheetTitle>
          <SheetDescription className="sr-only">File details</SheetDescription>
        </SheetHeader>
        <div className="grid gap-5 px-6 py-5">
          <div className="overflow-hidden rounded-md border bg-muted">
            {isImage(item.mime) ? (
              <img src={item.url} alt={alt} className="max-h-72 w-full object-contain" />
            ) : (
              <div className="flex h-40 flex-col items-center justify-center gap-2 text-muted-foreground">
                <ImageOff className="size-8" />
                <span className="text-xs">No preview for {item.mime}</span>
              </div>
            )}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">Type</dt>
            <dd className="font-mono text-xs leading-5">{item.mime}</dd>
            <dt className="text-muted-foreground">Size</dt>
            <dd>{formatBytes(item.size)}</dd>
            <dt className="text-muted-foreground">URL</dt>
            <dd className="truncate font-mono text-xs leading-5" title={item.url}>
              {item.url}
            </dd>
          </dl>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" className="gap-1.5" data-action="copy-url" onClick={copyUrl}>
              <Copy /> Copy URL
            </Button>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => window.open(item.url, '_blank', 'noopener')}>
              <ExternalLink /> Open
            </Button>
          </div>
          <Separator />
          <div className="grid gap-1.5">
            <Label htmlFor="media-alt">Alt text</Label>
            <Input
              id="media-alt"
              data-input="media-alt"
              value={alt}
              placeholder="Describe this file for screen readers…"
              onChange={(e) => setAlt(e.target.value)}
            />
            <div>
              <Button size="sm" disabled={busy || !altDirty} data-action="save-alt" onClick={() => void saveAlt()}>
                {busy ? 'Saving…' : 'Save alt text'}
              </Button>
            </div>
          </div>
          <Separator />
          <div>
            <Button variant="destructive" size="sm" className="gap-1.5" disabled={busy} data-action="delete-media" onClick={() => void remove()}>
              <Trash2 /> Delete file
            </Button>
            <p className="mt-1.5 text-xs text-muted-foreground">Deletes the stored bytes too — anything referencing this URL breaks.</p>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ---- the library page --------------------------------------------------------------

export function MediaPage() {
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search, 300);
  const [page, setPage] = useState(1);
  const [detailId, setDetailId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const mediaQ = useQuery({
    queryKey: ['media', 'library', debounced, page],
    queryFn: () => api.listMedia({ page, pageSize: PAGE_SIZE, ...(debounced ? { search: debounced } : {}) }),
    placeholderData: (prev) => prev,
  });

  useEffect(() => {
    setPage(1);
  }, [debounced]);

  const items = mediaQ.data?.items ?? [];
  const total = mediaQ.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const detail = items.find((i) => i.docId === detailId) ?? null;

  return (
    <div className="mx-auto max-w-5xl" data-view="media">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Input
          type="search"
          placeholder="Search by filename…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-64"
          aria-label="Search media"
        />
        <span className="text-sm text-muted-foreground">{mediaQ.data ? `${total} ${total === 1 ? 'file' : 'files'}` : ''}</span>
      </div>

      <UploadZone
        className="mb-5"
        onUploaded={(uploaded) => {
          void queryClient.invalidateQueries({ queryKey: ['media'] });
          toast.success(uploaded.length === 1 ? `Uploaded ${uploaded[0]?.filename}` : `Uploaded ${uploaded.length} files`);
        }}
      />

      {mediaQ.isPending && (
        <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 lg:grid-cols-6">
          {Array.from({ length: 12 }).map((_, i) => (
            <Skeleton key={i} className="aspect-square rounded-md" />
          ))}
        </div>
      )}
      {mediaQ.isError && <p className="py-10 text-center text-sm text-destructive">Couldn’t load media: {errText(mediaQ.error)}</p>}
      {mediaQ.data && items.length === 0 && (
        <p className="py-14 text-center text-sm text-muted-foreground">
          {debounced ? 'No files match your search.' : 'No files yet — drop the first one above.'}
        </p>
      )}
      {items.length > 0 && (
        <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 lg:grid-cols-6" data-media-grid>
          {items.map((item) => (
            <button
              key={item.docId}
              type="button"
              data-media={item.filename}
              className="group overflow-hidden rounded-md border text-left transition-colors hover:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setDetailId(item.docId)}
            >
              <MediaThumb item={item} />
              <span className="block px-2 py-1.5">
                <span className="block truncate text-xs font-medium" title={item.filename}>
                  {item.filename}
                </span>
                <span className="block text-[11px] text-muted-foreground">{formatBytes(item.size)}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {pages > 1 && (
        <div className="mt-5 flex items-center justify-end gap-3 text-sm">
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

      <MediaDetailSheet item={detail} open={detail !== null} onOpenChange={(o) => !o && setDetailId(null)} onDeleted={() => setDetailId(null)} />
    </div>
  );
}

export default MediaPage;
