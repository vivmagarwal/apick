/**
 * MediaPicker — dialog that lists the media library and picks one item, plus
 * the shared media building blocks (UploadZone drag-drop, MediaThumb,
 * formatBytes) reused by the full Media library view. Endpoints per
 * ui-legacy/media.ts: bytes multipart-POST to /admin/api/media, metadata docs
 * live in the `media` collection, files serve from /media/:docId/:filename.
 */
import * as React from 'react';
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileText, Upload } from 'lucide-react';
import * as api from '../api';
import type { MediaItem } from '../types';
import { cn } from '../lib/utils';
import { useDebouncedValue } from '../lib/hooks';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Skeleton } from './ui/skeleton';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';

export function isImage(mime: string): boolean {
  return mime.startsWith('image/');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Square thumbnail: the image itself, or a file icon tile. */
export function MediaThumb({ item, className }: { item: MediaItem; className?: string }) {
  return (
    <span className={cn('flex aspect-square items-center justify-center overflow-hidden bg-muted', className)}>
      {isImage(item.mime) ? (
        <img src={item.url} alt={item.alt} loading="lazy" className="size-full object-cover" />
      ) : (
        <span className="flex flex-col items-center gap-1 text-muted-foreground">
          <FileText className="size-6" />
          <span className="text-[10px] font-medium uppercase">{item.mime.split('/')[1]?.slice(0, 4) ?? 'file'}</span>
        </span>
      )}
    </span>
  );
}

export interface UploadZoneProps {
  /** Called with every successfully uploaded item, in upload order. */
  onUploaded: (items: MediaItem[]) => void;
  accept?: string;
  className?: string;
}

/** Click-to-upload button doubling as a drag-drop target. */
export function UploadZone({ onUploaded, accept, className }: UploadZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const doUpload = async (files: FileList | File[]) => {
    setBusy(true);
    const done: MediaItem[] = [];
    try {
      for (const file of Array.from(files)) done.push(await api.uploadMedia(file));
    } catch (err) {
      toast.error(err instanceof api.RequestError ? err.error.message : String(err));
    } finally {
      setBusy(false);
      if (done.length > 0) onUploaded(done);
    }
  };

  return (
    <div
      data-upload-zone
      role="button"
      tabIndex={0}
      aria-label="Upload files"
      className={cn(
        'flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed px-4 py-6 text-sm text-muted-foreground transition-colors hover:border-ring hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4',
        dragging && 'border-ring bg-accent/50 text-foreground',
        className,
      )}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) void doUpload(e.dataTransfer.files);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        data-input="media-file"
        {...(accept ? { accept } : {})}
        onChange={(e) => {
          if (e.target.files?.length) void doUpload(e.target.files);
          e.target.value = '';
        }}
      />
      <Upload />
      {busy ? (
        <span>Uploading…</span>
      ) : (
        <span>
          <strong className="font-medium text-foreground">Click to upload</strong> or drag files here
        </span>
      )}
    </div>
  );
}

// ---- the picker dialog ---------------------------------------------------------

const PICKER_PAGE_SIZE = 48;

export interface MediaPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the picked item; the caller closes the dialog. */
  onPick: (item: MediaItem) => void;
  /** Restrict the upload input (e.g. "image/*"). Listing is not filtered. */
  accept?: string;
}

export function MediaPicker({ open, onOpenChange, onPick, accept }: MediaPickerProps) {
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search, 300);
  const [page, setPage] = useState(1);
  const queryClient = useQueryClient();

  const mediaQ = useQuery({
    queryKey: ['media', 'picker', debounced, page],
    queryFn: () => api.listMedia({ page, pageSize: PICKER_PAGE_SIZE, ...(debounced ? { search: debounced } : {}) }),
    enabled: open,
    placeholderData: (prev) => prev,
  });

  const pages = Math.max(1, Math.ceil((mediaQ.data?.total ?? 0) / PICKER_PAGE_SIZE));

  const onUploaded = (items: MediaItem[]) => {
    void queryClient.invalidateQueries({ queryKey: ['media'] });
    // Single upload from inside the picker = the user meant to pick it.
    if (items.length === 1 && items[0]) onPick(items[0]);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl" data-view="media-picker">
        <DialogHeader>
          <DialogTitle>Choose media</DialogTitle>
          <DialogDescription>Pick a file from the library or upload a new one.</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input
            type="search"
            placeholder="Search by filename…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="max-w-xs"
            aria-label="Search media"
          />
        </div>
        <UploadZone onUploaded={onUploaded} {...(accept ? { accept } : {})} className="py-4" />
        <div className="max-h-[48vh] overflow-y-auto">
          {mediaQ.isPending && (
            <div className="grid grid-cols-4 gap-3 sm:grid-cols-6">
              {Array.from({ length: 12 }).map((_, i) => (
                <Skeleton key={i} className="aspect-square rounded-md" />
              ))}
            </div>
          )}
          {mediaQ.isError && (
            <p className="py-8 text-center text-sm text-destructive">
              Couldn’t load media: {mediaQ.error instanceof api.RequestError ? mediaQ.error.error.message : String(mediaQ.error)}
            </p>
          )}
          {mediaQ.data && mediaQ.data.items.length === 0 && (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {debounced ? 'No files match your search.' : 'No files yet — upload the first one.'}
            </p>
          )}
          {mediaQ.data && mediaQ.data.items.length > 0 && (
            <div className="grid grid-cols-4 gap-3 sm:grid-cols-6">
              {mediaQ.data.items.map((item) => (
                <button
                  key={item.docId}
                  type="button"
                  data-media={item.filename}
                  className="group overflow-hidden rounded-md border text-left transition-colors hover:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onPick(item)}
                >
                  <MediaThumb item={item} />
                  <span className="block truncate px-1.5 py-1 text-[11px] text-muted-foreground" title={item.filename}>
                    {item.filename}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        {pages > 1 && (
          <div className="flex items-center justify-end gap-3 text-sm">
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
      </DialogContent>
    </Dialog>
  );
}
