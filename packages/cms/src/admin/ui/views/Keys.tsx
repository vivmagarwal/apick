/**
 * API keys (/admin/keys) — ported from ui-legacy/pages.ts KeysPage: table of
 * keys (label, prefix, last used, revoked), create dialog (name + role) and
 * the show-once token dialog with copy button. Keys go through the same
 * permission system as everything else; agents hit /mcp with them.
 */
import * as React from 'react';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, KeyRound, Plus } from 'lucide-react';
import * as api from '../api';
import { formatDateTime, timeAgo } from '../lib/utils';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';

const KEY_ROLES: Array<{ value: string; label: string }> = [
  { value: 'content-reader', label: 'content-reader — read published' },
  { value: 'content-editor', label: 'content-editor — full content CRUD' },
  { value: 'cms-editor', label: 'cms-editor — content CRUD except users' },
  { value: 'tenant-admin', label: 'tenant-admin — content + settings' },
];

function errText(err: unknown): string {
  return err instanceof api.RequestError ? err.error.message : String(err);
}

export function KeysPage() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<{ name: string; role: string } | null>(null);
  const [formError, setFormError] = useState('');
  const [createdToken, setCreatedToken] = useState<string | null>(null);

  const keysQ = useQuery({ queryKey: ['keys'], queryFn: api.listKeys, retry: false });

  const createM = useMutation({
    mutationFn: (f: { name: string; role: string }) => api.createKey(f),
    onSuccess: (res) => {
      setForm(null);
      setFormError('');
      setCreatedToken(res.token);
      void queryClient.invalidateQueries({ queryKey: ['keys'] });
    },
    onError: (err) => setFormError(errText(err)),
  });

  const revokeM = useMutation({
    mutationFn: (id: string) => api.revokeKey(id),
    onSuccess: () => {
      toast.success('Key revoked');
      void queryClient.invalidateQueries({ queryKey: ['keys'] });
    },
    onError: (err) => toast.error(errText(err)),
  });

  const revoke = (id: string) => {
    if (!window.confirm('Revoke this key? Anything using it stops working within seconds.')) return;
    revokeM.mutate(id);
  };

  const copyToken = () => {
    if (!createdToken) return;
    void navigator.clipboard.writeText(createdToken).then(
      () => toast.success('Token copied'),
      () => toast.error('Couldn’t copy token'),
    );
  };

  return (
    <div className="mx-auto max-w-4xl" data-view="keys">
      <div className="mb-4 flex items-center gap-3">
        <p className="text-sm text-muted-foreground">
          Keys are for services and AI agents — the same permission system as everything else. MCP endpoint:{' '}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">/mcp</code>
        </p>
        <Button
          size="sm"
          className="ml-auto shrink-0 gap-1.5"
          data-action="new-key"
          onClick={() => {
            setFormError('');
            setForm({ name: '', role: 'content-editor' });
          }}
        >
          <Plus /> New key
        </Button>
      </div>

      {keysQ.isPending && (
        <div className="grid gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      )}
      {keysQ.isError && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Couldn’t load keys: {errText(keysQ.error)}
        </p>
      )}
      {keysQ.data && keysQ.data.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-md border py-14 text-center">
          <KeyRound className="size-8 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">No API keys yet — create one for your first service or agent.</p>
        </div>
      )}
      {keysQ.data && keysQ.data.length > 0 && (
        <div className="overflow-x-auto rounded-md border">
          <Table data-table="keys">
            <TableHeader>
              <TableRow>
                <TableHead>Label / service</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead className="w-28" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {keysQ.data.map((key) => (
                <TableRow key={key.id} data-key={key.prefix}>
                  <TableCell className="font-medium">{key.label || key.principal_name}</TableCell>
                  <TableCell>
                    <code className="font-mono text-xs">{key.prefix}…</code>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground" title={key.last_used_at ? formatDateTime(key.last_used_at) : undefined}>
                    {key.last_used_at ? timeAgo(key.last_used_at) : 'never'}
                  </TableCell>
                  <TableCell className="text-right">
                    {key.revoked_at ? (
                      <Badge variant="outline" className="text-muted-foreground">
                        revoked
                      </Badge>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        data-action="revoke-key"
                        disabled={revokeM.isPending}
                        onClick={() => revoke(key.id)}
                      >
                        Revoke
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* ---- create dialog ---------------------------------------------------------- */}
      <Dialog open={form !== null} onOpenChange={(o) => !o && setForm(null)}>
        <DialogContent className="max-w-md" data-view="key-form">
          {form && (
            <form
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                createM.mutate(form);
              }}
            >
              <DialogHeader>
                <DialogTitle>New API key</DialogTitle>
                <DialogDescription>The token is shown exactly once after creation.</DialogDescription>
              </DialogHeader>
              {formError && (
                <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" data-error>
                  {formError}
                </p>
              )}
              <div className="grid gap-1.5">
                <Label htmlFor="key-name">Name (what will use it?)</Label>
                <Input id="key-name" data-input="key-name" required autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="key-role">Role</Label>
                <Select value={form.role} onValueChange={(role) => setForm({ ...form, role })}>
                  <SelectTrigger id="key-role" data-input="key-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {KEY_ROLES.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setForm(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={createM.isPending} data-action="create-key">
                  {createM.isPending ? 'Creating…' : 'Create key'}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* ---- show-once token -------------------------------------------------------------- */}
      <Dialog open={createdToken !== null} onOpenChange={(o) => !o && setCreatedToken(null)}>
        <DialogContent className="max-w-lg" data-view="created-key">
          <DialogHeader>
            <DialogTitle>Copy this token now</DialogTitle>
            <DialogDescription>It is shown once and can’t be recovered — only revoked and re-created.</DialogDescription>
          </DialogHeader>
          <code className="block break-all rounded-md border bg-muted px-3 py-2 font-mono text-xs" data-token>
            {createdToken}
          </code>
          <DialogFooter>
            <Button variant="outline" className="gap-1.5" onClick={copyToken}>
              <Copy /> Copy
            </Button>
            <Button onClick={() => setCreatedToken(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default KeysPage;
