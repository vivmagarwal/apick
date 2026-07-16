/**
 * Users (/admin/users) — CMS account management, ported from
 * ui-legacy/pages.ts UsersPage onto the new component kit: table of accounts,
 * create/edit dialog (role select, password blank = unchanged on edit),
 * delete with confirm (never yourself).
 */
import * as React from 'react';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Pencil, Plus, Trash2, Users as UsersIcon } from 'lucide-react';
import * as api from '../api';
import type { CmsUser, Me } from '../types';
import { formatDateTime, timeAgo } from '../lib/utils';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';

const ROLES: Array<{ value: string; label: string }> = [
  { value: 'admin', label: 'admin — everything' },
  { value: 'editor', label: 'editor — content only' },
  { value: 'viewer', label: 'viewer — read only' },
];

interface UserFormState {
  docId?: string;
  name: string;
  email: string;
  role: string;
  password: string;
}

function errText(err: unknown): string {
  return err instanceof api.RequestError ? err.error.message : String(err);
}

export function UsersPage({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<UserFormState | null>(null);
  const [formError, setFormError] = useState('');

  const usersQ = useQuery({ queryKey: ['users'], queryFn: api.listUsers, retry: false });

  const saveM = useMutation({
    mutationFn: async (f: UserFormState) => {
      if (f.docId) {
        return api.updateUser(f.docId, {
          name: f.name,
          email: f.email,
          role: f.role,
          ...(f.password ? { password: f.password } : {}),
        });
      }
      return api.createUser({ name: f.name, email: f.email, role: f.role, password: f.password });
    },
    onSuccess: (_user, f) => {
      toast.success(f.docId ? 'User updated' : 'User created');
      setForm(null);
      setFormError('');
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err) => setFormError(errText(err)),
  });

  const deleteM = useMutation({
    mutationFn: (docId: string) => api.deleteUser(docId),
    onSuccess: () => {
      toast.success('User deleted');
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err) => toast.error(errText(err)),
  });

  const remove = (user: CmsUser) => {
    if (!window.confirm(`Delete ${user.email}? They lose access immediately.`)) return;
    deleteM.mutate(user.docId);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (form) saveM.mutate(form);
  };

  return (
    <div className="mx-auto max-w-4xl" data-view="users">
      <div className="mb-4 flex items-center gap-3">
        <p className="text-sm text-muted-foreground">People who sign in to this admin. Services and agents use API keys instead.</p>
        <Button
          size="sm"
          className="ml-auto gap-1.5"
          data-action="new-user"
          onClick={() => {
            setFormError('');
            setForm({ name: '', email: '', role: 'editor', password: '' });
          }}
        >
          <Plus /> New user
        </Button>
      </div>

      {usersQ.isPending && (
        <div className="grid gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      )}
      {usersQ.isError && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Couldn’t load users: {errText(usersQ.error)}
        </p>
      )}
      {usersQ.data && usersQ.data.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-md border py-14 text-center">
          <UsersIcon className="size-8 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">No users yet.</p>
        </div>
      )}
      {usersQ.data && usersQ.data.length > 0 && (
        <div className="overflow-x-auto rounded-md border">
          <Table data-table="users">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-32" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {usersQ.data.map((user) => (
                <TableRow key={user.docId} data-user={user.email}>
                  <TableCell className="font-medium">
                    {user.name}
                    {user.docId === me.docId && <span className="ml-2 text-xs text-muted-foreground">(you)</span>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{user.email}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{user.role}</Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground" title={formatDateTime(user.createdAt)}>
                    {timeAgo(user.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1.5">
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        data-action="edit-user"
                        onClick={() => {
                          setFormError('');
                          setForm({ docId: user.docId, name: user.name, email: user.email, role: user.role, password: '' });
                        }}
                      >
                        <Pencil /> Edit
                      </Button>
                      {user.docId !== me.docId && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="gap-1.5 text-destructive hover:text-destructive"
                          data-action="delete-user"
                          disabled={deleteM.isPending}
                          onClick={() => remove(user)}
                        >
                          <Trash2 /> Delete
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={form !== null} onOpenChange={(o) => !o && setForm(null)}>
        <DialogContent className="max-w-md" data-view="user-form">
          {form && (
            <form onSubmit={submit} className="grid gap-4">
              <DialogHeader>
                <DialogTitle>{form.docId ? 'Edit user' : 'New user'}</DialogTitle>
                <DialogDescription>{form.docId ? 'Update this account.' : 'They can sign in immediately.'}</DialogDescription>
              </DialogHeader>
              {formError && (
                <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" data-error>
                  {formError}
                </p>
              )}
              <div className="grid gap-1.5">
                <Label htmlFor="user-name">Name</Label>
                <Input id="user-name" data-input="user-name" required autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="user-email">Email</Label>
                <Input id="user-email" data-input="user-email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="user-role">Role</Label>
                <Select value={form.role} onValueChange={(role) => setForm({ ...form, role })}>
                  <SelectTrigger id="user-role" data-input="user-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLES.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="user-password">{form.docId ? 'New password (blank = unchanged)' : 'Password (min 10 chars)'}</Label>
                <Input
                  id="user-password"
                  data-input="user-password"
                  type="password"
                  autoComplete="new-password"
                  {...(form.docId ? {} : { required: true })}
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                />
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setForm(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={saveM.isPending} data-action="save-user">
                  {saveM.isPending ? 'Saving…' : form.docId ? 'Save' : 'Create'}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default UsersPage;
