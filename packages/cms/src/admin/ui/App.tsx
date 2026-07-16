import * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Redirect, Route, Router, Switch, useLocation } from 'wouter';
import {
  Braces,
  ExternalLink,
  FileText,
  Image,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Search,
  Users,
  Webhook,
} from 'lucide-react';
import * as api from './api';
import type { AdminStatus, CollectionInfo, EventRow, Me } from './types';
import { cn, timeAgo } from './lib/utils';
import { Button } from './components/ui/button';
import { Badge } from './components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { Skeleton } from './components/ui/skeleton';
import { Separator } from './components/ui/separator';
import { CommandPalette, COMMAND_PALETTE_EVENT } from './components/CommandPalette';
import { EditorPage } from './views/Editor';
import { ListingPage } from './views/Listing';
import { MediaPage } from './views/Media';
import { UsersPage } from './views/Users';
import { KeysPage } from './views/Keys';
import { WebhooksPage } from './views/Webhooks';
import { SchemaIndexPage, SchemaDetailPage } from './views/Schema';

/** Collections that get dedicated UI (or none at all) instead of a CONTENT entry. */
const HIDDEN_COLLECTIONS = new Set(['cms-users', 'media']);

export { COMMAND_PALETTE_EVENT };

// ---- auth screens (ported from ui-legacy/pages.ts) --------------------------------

function errorMessage(err: unknown): string {
  return err instanceof api.RequestError ? err.error.message : String(err);
}

function AuthScreen({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center text-xl font-semibold tracking-tight">
          APIck <span className="font-normal text-muted-foreground">Admin</span>
        </div>
        {children}
      </div>
    </div>
  );
}

function useEnsurePath(path: string) {
  useEffect(() => {
    if (window.location.pathname !== path) window.history.replaceState(null, '', path);
  }, [path]);
}

export function LoginPage({ onAuthed }: { onAuthed: () => void }) {
  useEnsurePath('/admin/login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.login(email, password);
      window.history.replaceState(null, '', '/admin');
      onAuthed();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthScreen>
      <Card>
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Use your CMS account.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid gap-4" data-view="login">
            {error && (
              <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" data-error>
                {error}
              </p>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="login-email">Email</Label>
              <Input id="login-email" type="email" required autoFocus autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="login-password">Password</Label>
              <Input id="login-password" type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </AuthScreen>
  );
}

export function SetupPage({ onAuthed }: { onAuthed: () => void }) {
  useEnsurePath('/admin/setup');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.setup(name, email, password);
      window.history.replaceState(null, '', '/admin');
      onAuthed();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthScreen>
      <Card>
        <CardHeader>
          <CardTitle>Welcome — create your admin account</CardTitle>
          <CardDescription>This install has no users yet. This account gets the admin role.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid gap-4" data-view="setup">
            {error && (
              <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" data-error>
                {error}
              </p>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="setup-name">Your name</Label>
              <Input id="setup-name" required autoFocus autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="setup-email">Email</Label>
              <Input id="setup-email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="setup-password">
                Password <span className="font-normal text-muted-foreground">(min 10 characters)</span>
              </Label>
              <Input id="setup-password" type="password" required autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? 'Creating…' : 'Create account'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </AuthScreen>
  );
}

// ---- shell -----------------------------------------------------------------------

function collectionLabel(col: CollectionInfo): string {
  return col.admin.label ?? col.key;
}

function NavLink({ href, children, exact = false }: { href: string; children: React.ReactNode; exact?: boolean }) {
  const [location] = useLocation();
  const active = exact ? location === href : location === href || location.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      className={cn(
        'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors [&_svg]:size-4 [&_svg]:shrink-0',
        active ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
      )}
    >
      {children}
    </Link>
  );
}

function NavGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <div className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">{label}</div>
      <div className="grid gap-0.5">{children}</div>
    </div>
  );
}

function pageTitle(location: string, contentCollections: CollectionInfo[]): string {
  if (location === '/' || location === '') return 'Dashboard';
  const colMatch = location.match(/^\/c\/([^/]+)/);
  if (colMatch) {
    const col = contentCollections.find((c) => c.key === colMatch[1]);
    return col ? collectionLabel(col) : (colMatch[1] ?? '');
  }
  if (location.startsWith('/media')) return 'Media';
  if (location.startsWith('/users')) return 'Users';
  if (location.startsWith('/keys')) return 'API keys';
  if (location.startsWith('/webhooks')) return 'Webhooks';
  if (location.startsWith('/schema')) return 'Schema';
  return 'Admin';
}

function Shell({
  me,
  status,
  collections,
  children,
}: {
  me: Me;
  status: AdminStatus;
  collections: CollectionInfo[];
  children: React.ReactNode;
}) {
  const [location] = useLocation();
  const contentCollections = useMemo(() => collections.filter((c) => !HIDDEN_COLLECTIONS.has(c.key)), [collections]);
  const isAdmin = me.role === 'admin';

  const openPalette = () => window.dispatchEvent(new CustomEvent(COMMAND_PALETTE_EVENT));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openPalette();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const signOut = () => {
    api.logout();
    window.location.href = '/admin/login';
  };

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-60 shrink-0 flex-col border-r bg-muted/30">
        <Link href="/" className="flex h-14 items-center gap-2 border-b px-4 text-sm">
          <span className="text-base font-bold tracking-tight">APIck</span>
          <span className="truncate text-muted-foreground" title={status.site.title}>
            · {status.site.title}
          </span>
        </Link>
        <nav className="flex-1 overflow-y-auto px-2 pb-4" aria-label="Main">
          <div className="mt-4 grid gap-0.5">
            <NavLink href="/" exact>
              <LayoutDashboard /> Dashboard
            </NavLink>
          </div>
          <NavGroup label="Content">
            {contentCollections.map((col) => (
              <NavLink key={col.key} href={`/c/${col.key}`}>
                {col.admin.icon ? (
                  <span className="flex size-4 items-center justify-center text-sm leading-none" aria-hidden>
                    {col.admin.icon}
                  </span>
                ) : (
                  <FileText />
                )}
                <span className="truncate">{collectionLabel(col)}</span>
              </NavLink>
            ))}
            {contentCollections.length === 0 && (
              <p className="px-2.5 py-1.5 text-xs text-muted-foreground">No collections defined yet.</p>
            )}
            <NavLink href="/media">
              <Image /> Media
            </NavLink>
          </NavGroup>
          <NavGroup label="System">
            {isAdmin && (
              <>
                <NavLink href="/users">
                  <Users /> Users
                </NavLink>
                <NavLink href="/keys">
                  <KeyRound /> API keys
                </NavLink>
                <NavLink href="/webhooks">
                  <Webhook /> Webhooks
                </NavLink>
              </>
            )}
            <NavLink href="/schema">
              <Braces /> Schema
            </NavLink>
          </NavGroup>
          {status.adminNav.length > 0 && (
            <NavGroup label="Plugins">
              {status.adminNav.map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
                >
                  {item.label}
                </a>
              ))}
            </NavGroup>
          )}
        </nav>
        <div className="border-t p-3">
          <a
            href="/"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground [&_svg]:size-3.5"
          >
            View site <ExternalLink />
          </a>
          <Separator className="my-2" />
          <div className="flex items-center justify-between gap-2 px-2">
            <span className="truncate text-sm" title={me.email}>
              {me.name}
            </span>
            <Button variant="ghost" size="sm" onClick={signOut} className="h-7 gap-1.5 px-2 text-xs text-muted-foreground [&_svg]:size-3.5">
              <LogOut /> Sign out
            </Button>
          </div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b px-6">
          <h1 className="truncate text-sm font-semibold">{pageTitle(location, contentCollections)}</h1>
          <button
            type="button"
            onClick={openPalette}
            className="flex h-8 w-56 items-center gap-2 rounded-md border bg-muted/40 px-3 text-sm text-muted-foreground transition-colors hover:bg-accent [&_svg]:size-3.5"
          >
            <Search />
            <span className="flex-1 text-left">Search…</span>
            <kbd className="rounded border bg-background px-1.5 font-sans text-[10px] text-muted-foreground">⌘K</kbd>
          </button>
        </header>
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}

// ---- dashboard ----------------------------------------------------------------------

const EVENT_TYPES = ['doc.created', 'doc.updated', 'doc.published', 'doc.unpublished', 'doc.deleted'];

function eventCollection(ev: EventRow, collections: CollectionInfo[]): string {
  const key = typeof ev.subject['collection'] === 'string' ? ev.subject['collection'] : '';
  const col = collections.find((c) => c.key === key);
  return col ? collectionLabel(col) : key;
}

function DashboardPage({ me, collections }: { me: Me; collections: CollectionInfo[] }) {
  const contentCollections = collections.filter((c) => !HIDDEN_COLLECTIONS.has(c.key));

  const countQueries = useQueries({
    queries: contentCollections.map((col) => ({
      queryKey: ['dashboard-count', col.key],
      queryFn: () => api.listDocs(col.key, { status: 'draft', pageSize: 1, count: true }).then((r) => r.meta.total ?? 0),
      retry: false,
    })),
  });

  // Admin-only audit feed — editors get a 403; hide the section quietly.
  const eventsQ = useQuery({
    queryKey: ['dashboard-events'],
    queryFn: () => api.events({ types: EVENT_TYPES, limit: 200 }).then((evs) => evs.slice(-10).reverse()),
    retry: false,
  });

  return (
    <div className="mx-auto max-w-5xl" data-view="dashboard">
      <h2 className="text-2xl font-semibold tracking-tight">Welcome back, {me.name.split(' ')[0] ?? me.name}</h2>
      <p className="mt-1 text-sm text-muted-foreground">Everything in {'"'}draft{'"'} counts — publish when ready.</p>

      <div className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
        {contentCollections.map((col, i) => {
          const q = countQueries[i];
          return (
            <Link key={col.key} href={`/c/${col.key}`} className="group" data-card={col.key}>
              <Card className="transition-colors group-hover:border-ring/60">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-2xl">{col.admin.icon ?? '📄'}</span>
                    {q && q.isPending ? (
                      <Skeleton className="h-7 w-10" />
                    ) : (
                      <span className="text-2xl font-semibold tabular-nums">{q?.data ?? '—'}</span>
                    )}
                  </div>
                  <div className="mt-2 truncate text-sm font-medium">{collectionLabel(col)}</div>
                  {col.description && <div className="truncate text-xs text-muted-foreground">{col.description}</div>}
                </CardContent>
              </Card>
            </Link>
          );
        })}
        {contentCollections.length === 0 && (
          <Card className="col-span-full">
            <CardHeader>
              <CardTitle>No collections yet</CardTitle>
              <CardDescription>
                Content types are code — add <code className="font-mono text-xs">collections/&lt;key&gt;.js</code> to your project and restart.
              </CardDescription>
            </CardHeader>
          </Card>
        )}
      </div>

      {eventsQ.data && eventsQ.data.length > 0 && (
        <section className="mt-8">
          <h3 className="mb-3 text-sm font-semibold text-muted-foreground">Recent activity</h3>
          <Card>
            <CardContent className="p-0">
              <ul className="divide-y">
                {eventsQ.data.map((ev) => (
                  <li key={ev.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                    <Badge variant="secondary" className="font-mono text-[11px]">
                      {ev.type.replace('doc.', '')}
                    </Badge>
                    <span className="flex-1 truncate">{eventCollection(ev, collections)}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(ev.created_at)}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </section>
      )}

      <section className="mt-8">
        <h3 className="mb-3 text-sm font-semibold text-muted-foreground">Quick links</h3>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Link href="/media">
            <Card className="transition-colors hover:border-ring/60">
              <CardContent className="flex items-center gap-3 p-4 text-sm font-medium [&_svg]:size-4 [&_svg]:text-muted-foreground">
                <Image /> Media library
              </CardContent>
            </Card>
          </Link>
          <Link href="/schema">
            <Card className="transition-colors hover:border-ring/60">
              <CardContent className="flex items-center gap-3 p-4 text-sm font-medium [&_svg]:size-4 [&_svg]:text-muted-foreground">
                <Braces /> Schema inspector
              </CardContent>
            </Card>
          </Link>
        </div>
      </section>
    </div>
  );
}

function NotFound() {
  return (
    <div className="mx-auto max-w-2xl pt-12">
      <Card>
        <CardHeader>
          <CardTitle>Page not found</CardTitle>
          <CardDescription>This admin route does not exist.</CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/" className="text-sm underline underline-offset-4">
            ← Back to dashboard
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

// ---- authed app (session + collections + routes) -------------------------------------------

function AuthedApp({ status, onSessionEnd }: { status: AdminStatus; onSessionEnd: () => void }) {
  const meQ = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false });
  const collectionsQ = useQuery({ queryKey: ['collections'], queryFn: api.collections, enabled: meQ.isSuccess });

  useEffect(() => {
    if (meQ.isError) {
      api.logout();
      onSessionEnd();
    }
  }, [meQ.isError, onSessionEnd]);

  if (meQ.isPending || (meQ.isSuccess && collectionsQ.isPending)) return <Splash />;
  if (!meQ.data) return <Splash />; // isError effect above swaps to Login

  const me = meQ.data;
  const collections = collectionsQ.data ?? [];

  return (
    <Router base="/admin">
      <Shell me={me} status={status} collections={collections}>
        <Switch>
          <Route path="/">
            <DashboardPage me={me} collections={collections} />
          </Route>
          <Route path="/c/:key/new">
            {(params) => <EditorPage key={`${params.key}:new`} collection={params.key ?? ''} docId={null} />}
          </Route>
          <Route path="/c/:key/:docId">
            {(params) => <EditorPage key={`${params.key}:${params.docId}`} collection={params.key ?? ''} docId={params.docId ?? null} />}
          </Route>
          <Route path="/c/:key">{(params) => <ListingPage key={params.key} collection={params.key ?? ''} />}</Route>
          <Route path="/media">
            <MediaPage />
          </Route>
          <Route path="/users">
            <UsersPage me={me} />
          </Route>
          <Route path="/keys">
            <KeysPage />
          </Route>
          <Route path="/webhooks">
            <WebhooksPage />
          </Route>
          <Route path="/schema/:key">{(params) => <SchemaDetailPage key={params.key} collection={params.key ?? ''} />}</Route>
          <Route path="/schema">
            <SchemaIndexPage />
          </Route>
          <Route path="/login">
            <Redirect to="/" replace />
          </Route>
          <Route path="/setup">
            <Redirect to="/" replace />
          </Route>
          <Route>
            <NotFound />
          </Route>
        </Switch>
        <CommandPalette collections={collections} />
      </Shell>
    </Router>
  );
}

// ---- root gate --------------------------------------------------------------------------------

function Splash() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-sm text-muted-foreground">Loading…</div>
    </div>
  );
}

export default function App() {
  // Bumped on login/logout/setup so the gate re-reads the token and refetches.
  const [authVersion, setAuthVersion] = useState(0);
  const queryClient = useQueryClient();
  const statusQ = useQuery({ queryKey: ['admin-status', authVersion], queryFn: api.adminStatus });

  const handleAuthChange = () => {
    queryClient.clear();
    setAuthVersion((v) => v + 1);
  };

  if (statusQ.isPending) return <Splash />;
  if (statusQ.isError) {
    return (
      <AuthScreen>
        <Card>
          <CardHeader>
            <CardTitle>Can’t reach the server</CardTitle>
            <CardDescription>{errorMessage(statusQ.error)}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => statusQ.refetch()}>Retry</Button>
          </CardContent>
        </Card>
      </AuthScreen>
    );
  }

  const status = statusQ.data;
  if (status.needsSetup) return <SetupPage onAuthed={handleAuthChange} />;
  if (!api.getToken()) return <LoginPage onAuthed={handleAuthChange} />;
  return <AuthedApp status={status} onSessionEnd={handleAuthChange} />;
}
