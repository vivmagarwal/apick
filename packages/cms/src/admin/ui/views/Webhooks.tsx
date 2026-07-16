/**
 * Webhooks (/admin/webhooks) — ported from ui-legacy/pages.ts WebhooksPage:
 * table (name, url, events, enabled toggle), create dialog with show-once
 * signing secret, delete with confirm, and a deliveries Sheet per hook with
 * per-delivery replay.
 */
import * as React from 'react';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, Plus, RotateCcw, Trash2, Webhook as WebhookIcon } from 'lucide-react';
import * as api from '../api';
import type { WebhookRow } from '../types';
import { formatDateTime, timeAgo } from '../lib/utils';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../components/ui/sheet';
import { Skeleton } from '../components/ui/skeleton';
import { Switch } from '../components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';

function errText(err: unknown): string {
  return err instanceof api.RequestError ? err.error.message : String(err);
}

// ---- deliveries sheet -----------------------------------------------------------

function DeliveriesSheet({ hook, open, onOpenChange }: { hook: WebhookRow | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const [replaying, setReplaying] = useState<string | null>(null);

  const deliveriesQ = useQuery({
    queryKey: ['webhook-deliveries', hook?.id],
    queryFn: () => api.webhookDeliveries(hook!.id),
    enabled: open && !!hook,
  });

  const replay = async (deliveryId: string) => {
    setReplaying(deliveryId);
    try {
      await api.replayDelivery(deliveryId);
      toast.success('Delivery queued for replay');
      await queryClient.invalidateQueries({ queryKey: ['webhook-deliveries', hook?.id] });
    } catch (err) {
      toast.error(errText(err));
    } finally {
      setReplaying(null);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-lg" data-view="webhook-deliveries">
        <SheetHeader className="border-b px-6 py-4">
          <SheetTitle className="truncate pr-8 text-base">Deliveries — {hook?.name ?? ''}</SheetTitle>
          <SheetDescription>Recent attempts to {hook?.url ?? ''}. Replay re-sends the same payload.</SheetDescription>
        </SheetHeader>
        <div className="flex-1 px-6 py-5">
          {deliveriesQ.isPending && (
            <div className="grid gap-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          )}
          {deliveriesQ.isError && <p className="text-sm text-destructive">Couldn’t load deliveries: {errText(deliveriesQ.error)}</p>}
          {deliveriesQ.data && deliveriesQ.data.length === 0 && (
            <p className="py-10 text-center text-sm text-muted-foreground">No deliveries yet — they appear once matching events fire.</p>
          )}
          {deliveriesQ.data && deliveriesQ.data.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>State</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead>HTTP</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {deliveriesQ.data.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>
                      <Badge variant={d.state === 'delivered' ? 'secondary' : d.state === 'failed' ? 'destructive' : 'outline'}>{d.state}</Badge>
                    </TableCell>
                    <TableCell className="tabular-nums">{d.attempts}</TableCell>
                    <TableCell className="tabular-nums">{d.last_status ?? '—'}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground" title={formatDateTime(d.created_at)}>
                      {timeAgo(d.created_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        disabled={replaying !== null}
                        data-action="replay-delivery"
                        onClick={() => void replay(d.id)}
                      >
                        <RotateCcw /> {replaying === d.id ? '…' : 'Replay'}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ---- the page ----------------------------------------------------------------------

export function WebhooksPage() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<{ name: string; url: string; events: string } | null>(null);
  const [formError, setFormError] = useState('');
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [deliveriesFor, setDeliveriesFor] = useState<WebhookRow | null>(null);

  const hooksQ = useQuery({ queryKey: ['webhooks'], queryFn: api.listWebhooks, retry: false });

  const createM = useMutation({
    mutationFn: (f: { name: string; url: string; events: string }) =>
      api.createWebhook({
        name: f.name,
        url: f.url,
        events: f.events
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      }),
    onSuccess: (res) => {
      setForm(null);
      setFormError('');
      setCreatedSecret(res.secret);
      void queryClient.invalidateQueries({ queryKey: ['webhooks'] });
    },
    onError: (err) => setFormError(errText(err)),
  });

  const toggleM = useMutation({
    mutationFn: (hook: WebhookRow) => api.updateWebhook(hook.id, { enabled: !hook.enabled }),
    onSuccess: (_res, hook) => {
      toast.success(hook.enabled ? 'Webhook disabled' : 'Webhook enabled');
      void queryClient.invalidateQueries({ queryKey: ['webhooks'] });
    },
    onError: (err) => toast.error(errText(err)),
  });

  const deleteM = useMutation({
    mutationFn: (id: string) => api.deleteWebhook(id),
    onSuccess: () => {
      toast.success('Webhook deleted');
      void queryClient.invalidateQueries({ queryKey: ['webhooks'] });
    },
    onError: (err) => toast.error(errText(err)),
  });

  const remove = (hook: WebhookRow) => {
    if (!window.confirm(`Delete webhook "${hook.name}"?`)) return;
    deleteM.mutate(hook.id);
  };

  const copySecret = () => {
    if (!createdSecret) return;
    void navigator.clipboard.writeText(createdSecret).then(
      () => toast.success('Secret copied'),
      () => toast.error('Couldn’t copy secret'),
    );
  };

  return (
    <div className="mx-auto max-w-5xl" data-view="webhooks">
      <div className="mb-4 flex items-center gap-3">
        <p className="text-sm text-muted-foreground">
          Signed POSTs on matching events. Patterns: <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">*</code>,{' '}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">doc.*</code>,{' '}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">doc.published:posts</code>
        </p>
        <Button
          size="sm"
          className="ml-auto shrink-0 gap-1.5"
          data-action="new-webhook"
          onClick={() => {
            setFormError('');
            setForm({ name: '', url: '', events: 'doc.published' });
          }}
        >
          <Plus /> New webhook
        </Button>
      </div>

      {hooksQ.isPending && (
        <div className="grid gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      )}
      {hooksQ.isError && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Couldn’t load webhooks: {errText(hooksQ.error)}
        </p>
      )}
      {hooksQ.data && hooksQ.data.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-md border py-14 text-center">
          <WebhookIcon className="size-8 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">No webhooks yet — notify your site or services when content changes.</p>
        </div>
      )}
      {hooksQ.data && hooksQ.data.length > 0 && (
        <div className="overflow-x-auto rounded-md border">
          <Table data-table="webhooks">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>URL</TableHead>
                <TableHead>Events</TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead className="w-44" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {hooksQ.data.map((hook) => (
                <TableRow key={hook.id} data-webhook={hook.name}>
                  <TableCell className="font-medium">{hook.name}</TableCell>
                  <TableCell className="max-w-56 truncate text-muted-foreground" title={hook.url}>
                    {hook.url}
                  </TableCell>
                  <TableCell className="max-w-48">
                    <div className="flex flex-wrap gap-1">
                      {hook.events.map((ev) => (
                        <Badge key={ev} variant="outline" className="font-mono text-[11px]">
                          {ev}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={hook.enabled}
                      disabled={toggleM.isPending}
                      aria-label={`${hook.enabled ? 'Disable' : 'Enable'} ${hook.name}`}
                      data-action="toggle-webhook"
                      onCheckedChange={() => toggleM.mutate(hook)}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1.5">
                      <Button variant="outline" size="sm" data-action="deliveries" onClick={() => setDeliveriesFor(hook)}>
                        Deliveries
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1.5 text-destructive hover:text-destructive"
                        data-action="delete-webhook"
                        disabled={deleteM.isPending}
                        onClick={() => remove(hook)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* ---- create dialog ----------------------------------------------------------- */}
      <Dialog open={form !== null} onOpenChange={(o) => !o && setForm(null)}>
        <DialogContent className="max-w-md" data-view="webhook-form">
          {form && (
            <form
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                createM.mutate(form);
              }}
            >
              <DialogHeader>
                <DialogTitle>New webhook</DialogTitle>
                <DialogDescription>The signing secret is shown exactly once after creation.</DialogDescription>
              </DialogHeader>
              {formError && (
                <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" data-error>
                  {formError}
                </p>
              )}
              <div className="grid gap-1.5">
                <Label htmlFor="webhook-name">Name</Label>
                <Input id="webhook-name" data-input="webhook-name" required autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="webhook-url">URL</Label>
                <Input id="webhook-url" data-input="webhook-url" type="url" required placeholder="https://…" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="webhook-events">Events (comma-separated)</Label>
                <Input id="webhook-events" data-input="webhook-events" value={form.events} onChange={(e) => setForm({ ...form, events: e.target.value })} />
                <p className="text-xs text-muted-foreground">
                  e.g. <code className="font-mono">doc.published, doc.deleted:posts</code> or <code className="font-mono">*</code>
                </p>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setForm(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={createM.isPending} data-action="create-webhook">
                  {createM.isPending ? 'Creating…' : 'Create webhook'}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* ---- show-once secret ----------------------------------------------------------- */}
      <Dialog open={createdSecret !== null} onOpenChange={(o) => !o && setCreatedSecret(null)}>
        <DialogContent className="max-w-lg" data-view="created-webhook">
          <DialogHeader>
            <DialogTitle>Signing secret</DialogTitle>
            <DialogDescription>Shown once — use it to verify the X-Apick-Signature header on deliveries.</DialogDescription>
          </DialogHeader>
          <code className="block break-all rounded-md border bg-muted px-3 py-2 font-mono text-xs" data-token>
            {createdSecret}
          </code>
          <DialogFooter>
            <Button variant="outline" className="gap-1.5" onClick={copySecret}>
              <Copy /> Copy
            </Button>
            <Button onClick={() => setCreatedSecret(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DeliveriesSheet hook={deliveriesFor} open={deliveriesFor !== null} onOpenChange={(o) => !o && setDeliveriesFor(null)} />
    </div>
  );
}

export default WebhooksPage;
