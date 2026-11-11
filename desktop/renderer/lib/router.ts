// Hash routes for the local screens: app://local/index.html#/settings/server/<id>?x=y
import { useEffect, useState } from 'preact/hooks';

export interface Route {
  path: string;
  query: URLSearchParams;
}

function read(): Route {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const [path = '/', search = ''] = raw.split('?');
  return { path: path.startsWith('/') ? path : `/${path}`, query: new URLSearchParams(search) };
}

const listeners = new Set<(route: Route) => void>();
window.addEventListener('hashchange', () => {
  const route = read();
  for (const listener of listeners) listener(route);
  document.getElementById('main')?.focus({ preventScroll: true });
  window.scrollTo(0, 0);
});

export function navigate(href: string, replace = false): void {
  const target = `#${href.startsWith('/') ? href : `/${href}`}`;
  if (window.location.hash === target) return;
  if (replace) window.location.replace(target);
  else window.location.hash = target;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(read);
  useEffect(() => {
    listeners.add(setRoute);
    return () => {
      listeners.delete(setRoute);
    };
  }, []);
  return route;
}

/** Matches "/plan/:id" style patterns; returns the params or null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const part = p[i]!;
    const seg = s[i]!;
    if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(seg);
    else if (part !== seg) return null;
  }
  return params;
}
