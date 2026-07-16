/** Minimal history router for the admin SPA. */

type Listener = () => void;
const listeners = new Set<Listener>();

export function navigate(path: string): void {
  history.pushState(null, '', path);
  for (const fn of listeners) fn();
}

export function onRouteChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

window.addEventListener('popstate', () => {
  for (const fn of listeners) fn();
});

/** Intercept in-app link clicks. */
document.addEventListener('click', (e) => {
  const target = (e.target as HTMLElement).closest('a');
  if (!target || target.origin !== location.origin) return;
  if (!target.pathname.startsWith('/admin') || target.hasAttribute('data-external')) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey || target.target === '_blank') return;
  e.preventDefault();
  navigate(target.pathname + target.search);
});

export function currentPath(): string {
  return location.pathname;
}
