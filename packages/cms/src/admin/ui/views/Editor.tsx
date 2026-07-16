/**
 * The editor route (/admin/c/:key/new + /admin/c/:key/:docId) — the
 * centerpiece. Header with status + actions (Preview, Save draft, Publish
 * split-button with Schedule…, ⋯ menu with Unpublish/Delete/Copy/metadata),
 * the schema-driven DocumentForm, version history with restore, autosave
 * indicator, unsaved-changes guards (in-app + beforeunload) and ⌘S/⌘⇧Enter.
 * Ported behaviors from ui-legacy/editor.ts on the stage-1 component kit.
 */
import * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'wouter';
import { toast } from 'sonner';
import {
  CalendarClock,
  ChevronDown,
  ChevronLeft,
  Copy,
  ExternalLink,
  History,
  MoreHorizontal,
  Trash2,
  Undo2,
} from 'lucide-react';
import * as api from '../api';
import type { Envelope } from '../types';
import { timeAgo, formatDateTime } from '../lib/utils';
import { DocumentForm, SAVE_STATE_LABEL, type DocumentFormHandle, type FormSaveState } from '../components/DocumentForm';
import { RelatedContent } from '../components/RelatedContent';
import { StatusPill, statusOf } from '../components/StatusPill';
import { docTitle, localToIso, titleFieldFor } from '../components/fields/utils';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Skeleton } from '../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';

// ---- unsaved-changes guard ----------------------------------------------------

/**
 * Guards in-app navigations (wouter drives history.pushState/replaceState) and
 * tab close/refresh (beforeunload) while the form is dirty. `bypass(fn)` runs
 * an intentional navigation (e.g. right after create) without the prompt.
 */
function useUnsavedGuard(dirty: boolean): { bypass: (fn: () => void) => void } {
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const bypassRef = useRef(false);

  useEffect(() => {
    const mayLeave = () => !dirtyRef.current || bypassRef.current || window.confirm('You have unsaved changes — leave anyway?');
    const origPush = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);
    history.pushState = (data: unknown, unused: string, url?: string | URL | null) => {
      if (mayLeave()) origPush(data, unused, url);
    };
    history.replaceState = (data: unknown, unused: string, url?: string | URL | null) => {
      if (mayLeave()) origReplace(data, unused, url);
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current && !bypassRef.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      history.pushState = origPush;
      history.replaceState = origReplace;
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, []);

  const bypass = (fn: () => void) => {
    bypassRef.current = true;
    try {
      fn();
    } finally {
      bypassRef.current = false;
    }
  };
  return { bypass };
}

// ---- version history dialog ----------------------------------------------------

function VersionsDialog({
  collection,
  docId,
  currentVersion,
  open,
  onOpenChange,
  onRestored,
}: {
  collection: string;
  docId: string;
  currentVersion: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRestored: (env: Envelope) => void;
}) {
  const [busy, setBusy] = useState(false);
  const versionsQ = useQuery({
    queryKey: ['versions', collection, docId],
    queryFn: () => api.listVersions(collection, docId),
    enabled: open,
  });

  const restore = async (version: number) => {
    setBusy(true);
    try {
      const env = await api.restoreVersion(collection, docId, version);
      toast.success(`Restored v${version} as a new draft version`);
      onOpenChange(false);
      onRestored(env);
    } catch (err) {
      toast.error(err instanceof api.RequestError ? err.error.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" data-view="versions">
        <DialogHeader>
          <DialogTitle>History</DialogTitle>
          <DialogDescription>Every save is a version. Restoring copies an old version into a new draft.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[55vh] overflow-y-auto">
          {versionsQ.isPending && (
            <div className="grid gap-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          )}
          {versionsQ.isError && <p className="text-sm text-destructive">Couldn’t load versions.</p>}
          {versionsQ.data && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">v</TableHead>
                  <TableHead>Operation</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {versionsQ.data.map((v) => (
                  <TableRow key={v.version}>
                    <TableCell className="font-mono text-xs">v{v.version}</TableCell>
                    <TableCell>{v.op}</TableCell>
                    <TableCell title={formatDateTime(v.createdAt)}>{timeAgo(v.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      {v.version === currentVersion ? (
                        <span className="text-xs text-muted-foreground">current</span>
                      ) : (
                        <Button variant="outline" size="sm" className="gap-1.5" disabled={busy} data-restore={v.version} onClick={() => void restore(v.version)}>
                          <Undo2 /> Restore
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---- schedule dialog --------------------------------------------------------------

function ScheduleDialog({
  open,
  onOpenChange,
  onSchedule,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSchedule: (atIso: string) => void;
}) {
  const [local, setLocal] = useState('');
  const iso = localToIso(local);
  const valid = iso !== null && new Date(iso).getTime() > Date.now();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm" data-view="schedule">
        <DialogHeader>
          <DialogTitle>Schedule publish</DialogTitle>
          <DialogDescription>The draft is saved now and goes live automatically at this time.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="schedule-at">Publish at</Label>
          <Input id="schedule-at" type="datetime-local" value={local} onChange={(e) => setLocal(e.target.value)} />
          {local !== '' && !valid && <p className="text-xs text-destructive">Pick a future date and time.</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!valid}
            data-action="confirm-schedule"
            onClick={() => {
              if (iso) onSchedule(iso);
            }}
          >
            <CalendarClock /> Schedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- the editor page ----------------------------------------------------------------

export function EditorPage({ collection, docId }: { collection: string; docId: string | null }) {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const formRef = useRef<DocumentFormHandle>(null);
  const [saveState, setSaveState] = useState<FormSaveState>('idle');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [resetKey, setResetKey] = useState(0);

  const schemaQ = useQuery({ queryKey: ['schema', collection], queryFn: () => api.schema(collection) });
  const docQ = useQuery({
    queryKey: ['doc', collection, docId],
    queryFn: () => api.getDoc(collection, docId!, { status: 'draft' }),
    enabled: !!docId,
    retry: false,
  });
  const env = docId ? (docQ.data ?? null) : null;

  const previewQ = useQuery({
    queryKey: ['preview', collection, docId],
    queryFn: () => api.previewUrl(collection, docId!),
    enabled: !!docId,
    retry: false,
  });

  const fields = schemaQ.data?.fields ?? {};
  const admin = schemaQ.data?.admin;
  const titleField = useMemo(() => titleFieldFor(fields, admin), [fields, admin]);
  const label = admin?.label ?? collection;

  const dirty = saveState === 'dirty' || saveState === 'saving' || saveState === 'error';
  const { bypass } = useUnsavedGuard(dirty);

  const setDoc = (saved: Envelope) => queryClient.setQueryData(['doc', collection, saved.docId], saved);

  // Ref-guarded so the mount-once keyboard handler never runs a stale closure.
  const busyRef = useRef(false);
  const runSave = async (opts: { publish?: boolean; publishAt?: string }, successMsg: string) => {
    if (!formRef.current || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const saved = await formRef.current.save(opts);
      if (saved) toast.success(successMsg);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  // ⌘S = save draft, ⌘⇧Enter = save & publish (a DocSheet on top captures first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.defaultPrevented) return;
      if (e.key.toLowerCase() === 's') {
        e.preventDefault();
        void runSave({}, 'Draft saved');
      } else if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        void runSave({ publish: true }, 'Saved & published');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const unpublish = async () => {
    if (!docId) return;
    setBusy(true);
    try {
      const saved = await api.unpublishDoc(collection, docId);
      setDoc(saved);
      toast.success('Unpublished');
    } catch (err) {
      toast.error(err instanceof api.RequestError ? err.error.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const cancelSchedule = async () => {
    if (!docId) return;
    setBusy(true);
    try {
      const saved = await api.cancelSchedule(collection, docId);
      setDoc(saved);
      toast.success('Schedule cancelled');
    } catch (err) {
      toast.error(err instanceof api.RequestError ? err.error.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!docId) return;
    if (!window.confirm('Delete this document? Version history is kept for audit.')) return;
    setBusy(true);
    try {
      await api.deleteDoc(collection, docId);
      toast.success('Document deleted');
      bypass(() => navigate(`/c/${collection}`));
    } catch (err) {
      toast.error(err instanceof api.RequestError ? err.error.message : String(err));
      setBusy(false);
    }
  };

  const copy = (text: string, what: string) => {
    void navigator.clipboard.writeText(text).then(
      () => toast.success(`${what} copied`),
      () => toast.error(`Couldn’t copy ${what}`),
    );
  };

  // ---- render guards ------------------------------------------------------------

  if (schemaQ.isPending || (docId && docQ.isPending)) {
    return (
      <div className="mx-auto max-w-3xl">
        <Skeleton className="mb-6 h-9 w-2/3" />
        <div className="grid gap-4">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-3/4" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    );
  }
  if (schemaQ.isError || (docId && docQ.isError)) {
    return (
      <div className="mx-auto max-w-2xl pt-12">
        <Card>
          <CardHeader>
            <CardTitle>{docId && docQ.isError ? 'Document not found' : 'Couldn’t load this collection'}</CardTitle>
            <CardDescription>
              {docId && docQ.isError
                ? 'It may have been deleted, or you may not have access to it.'
                : String(schemaQ.error ?? '')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href={`/c/${collection}`} className="text-sm underline underline-offset-4">
              ← Back to {label}
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const displayTitle = title.trim() || (env ? docTitle(env, titleField) : 'Untitled');
  const status = env ? statusOf(env) : null;
  const scheduled = env?.scheduledPublishAt ?? null;
  const apiUrl = docId ? `${window.location.origin}/v1/collections/${collection}/docs/${docId}` : '';

  return (
    <div className="mx-auto max-w-3xl" data-view="editor">
      {/* ---- header --------------------------------------------------------- */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Link
          href={`/c/${collection}`}
          title={`Back to ${label}`}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground [&_svg]:size-4"
        >
          <ChevronLeft />
        </Link>
        <h2 className="min-w-0 flex-1 truncate text-xl font-semibold tracking-tight" title={displayTitle}>
          {displayTitle}
        </h2>
        {env && <StatusPill env={env} />}
        {saveState !== 'idle' && (
          <span className="text-xs text-muted-foreground" data-autosave={saveState}>
            {SAVE_STATE_LABEL[saveState]}
          </span>
        )}
        <div className="flex items-center gap-2">
          {previewQ.data?.url && (
            <Button variant="outline" size="sm" className="gap-1.5" data-action="preview" onClick={() => window.open(previewQ.data!.url, '_blank', 'noopener')}>
              <ExternalLink /> Preview
            </Button>
          )}
          <Button variant="outline" size="sm" disabled={busy} data-action="save" onClick={() => void runSave({}, docId ? 'Draft saved' : 'Draft created')}>
            Save draft
          </Button>
          {/* Publish split-button (Schedule lives behind the chevron). */}
          <div className="flex items-center">
            <Button
              size="sm"
              className="gap-1.5 rounded-r-none"
              disabled={busy}
              data-action="publish"
              onClick={() => void runSave({ publish: true }, docId ? 'Saved & published' : 'Created & published')}
            >
              {scheduled ? `Scheduled ${formatDateTime(scheduled)}` : 'Publish'}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" className="rounded-l-none border-l border-l-primary-foreground/25 px-1.5" disabled={busy} aria-label="Publish options">
                  <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void runSave({ publish: true }, 'Saved & published')}>Publish now</DropdownMenuItem>
                <DropdownMenuItem disabled={!docId} data-action="schedule" onSelect={() => setShowSchedule(true)}>
                  <CalendarClock /> Schedule…
                </DropdownMenuItem>
                {scheduled && (
                  <DropdownMenuItem data-action="cancel-schedule" onSelect={() => void cancelSchedule()}>
                    Cancel schedule
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {/* ⋯ menu */}
          {docId && env && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" className="h-8 w-8" aria-label="More actions" data-action="more">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuItem data-action="versions" onSelect={() => setShowVersions(true)}>
                  <History /> History…
                </DropdownMenuItem>
                {env.publishedVersion !== null && status !== 'scheduled' && (
                  <DropdownMenuItem data-action="unpublish" onSelect={() => void unpublish()}>
                    <Undo2 /> Unpublish
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => copy(docId, 'docId')}>
                  <Copy /> Copy docId
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => copy(apiUrl, 'API URL')}>
                  <Copy /> Copy API URL
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive focus:text-destructive" data-action="delete" onSelect={() => void remove()}>
                  <Trash2 /> Delete
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <div className="grid gap-1 px-2 py-1.5 text-xs text-muted-foreground">
                  <span title={formatDateTime(env.createdAt)}>Created {timeAgo(env.createdAt)}</span>
                  <span title={formatDateTime(env.updatedAt)}>Updated {timeAgo(env.updatedAt)}</span>
                  <span title={formatDateTime(env.publishedAt)}>{env.publishedAt ? `Published ${timeAgo(env.publishedAt)}` : 'Never published'}</span>
                  <span className="truncate font-mono" title={docId}>
                    {docId}
                  </span>
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* ---- the form -------------------------------------------------------- */}
      <DocumentForm
        ref={formRef}
        collection={collection}
        fields={fields}
        {...(admin ? { admin } : {})}
        doc={env}
        resetKey={resetKey}
        onState={setSaveState}
        onValues={(values) => {
          const t = titleField ? values[titleField] : null;
          setTitle(typeof t === 'string' ? t : '');
        }}
        onSaved={(saved, info) => {
          setDoc(saved);
          if (info.created) bypass(() => navigate(`/c/${collection}/${saved.docId}`));
        }}
      />

      {/* ---- inverse relations (existing docs only) --------------------------- */}
      {docId && schemaQ.data && schemaQ.data.referencedBy.length > 0 && (
        <div className="mt-8">
          <h3 className="mb-3 text-sm font-semibold text-muted-foreground">Related content</h3>
          <RelatedContent collection={collection} docId={docId} referencedBy={schemaQ.data.referencedBy} />
        </div>
      )}

      {/* ---- dialogs ----------------------------------------------------------- */}
      {docId && env && (
        <VersionsDialog
          collection={collection}
          docId={docId}
          currentVersion={env.version}
          open={showVersions}
          onOpenChange={setShowVersions}
          onRestored={(restored) => {
            setDoc(restored);
            setResetKey((k) => k + 1);
          }}
        />
      )}
      <ScheduleDialog
        open={showSchedule}
        onOpenChange={setShowSchedule}
        onSchedule={(atIso) => {
          setShowSchedule(false);
          void runSave({ publishAt: atIso }, `Scheduled for ${formatDateTime(atIso)}`);
        }}
      />
    </div>
  );
}

export default EditorPage;
