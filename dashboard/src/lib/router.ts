// A tiny History API router: navigate(), useRoute() and Link. Route patterns ("/locations/:id") are
// matched by the app; the matched params reach pages through RouteParamsContext.

import { createContext, h } from 'preact';
import type { ComponentChildren, TargetedMouseEvent } from 'preact';
import { useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { isRouterClick } from '../components/navigation.ts';

export interface RouteState {
  /** Pathname without the query, for example "/locations/3". */
  path: string;
  /** Params of the matched route pattern, for example { id: "3" }. */
  params: Record<string, string>;
  query: URLSearchParams;
}

export interface NavigateOptions {
  /** Replace the current history entry instead of adding one. */
  replace?: boolean;
  /** Never leave this origin: a target on another origin goes to the home path instead. */
  sameOriginOnly?: boolean;
}

type Listener = () => void;
const listeners = new Set<Listener>();
const hasWindow = typeof window !== 'undefined';

function readHref(): { path: string; search: string } {
  if (!hasWindow) return { path: '/', search: '' };
  return { path: window.location.pathname, search: window.location.search };
}

let current = readHref();

function notify(): void {
  const next = readHref();
  if (next.path === current.path && next.search === current.search) return;
  current = next;
  for (const listener of [...listeners]) listener();
}

if (hasWindow) window.addEventListener('popstate', notify);

/** Moves to an in-app path without a page load. Other origins get a normal page load. */
export function navigate(to: string, options: NavigateOptions = {}): void {
  if (!hasWindow) return;
  let url: URL;
  try {
    url = new URL(to, window.location.href);
  } catch {
    url = new URL('/', window.location.origin);
  }
  if (url.origin !== window.location.origin) {
    if (options.sameOriginOnly) {
      navigate('/', { replace: options.replace });
      return;
    }
    window.location.assign(url.href);
    return;
  }
  const target = url.pathname + url.search + url.hash;
  const here = window.location.pathname + window.location.search + window.location.hash;
  if (target !== here) {
    // The full same-origin href: a bare pathname such as "//x" would be read as another site.
    if (options.replace) window.history.replaceState(null, '', url.href);
    else window.history.pushState(null, '', url.href);
  }
  const pathChanged = url.pathname !== current.path;
  notify();
  if (pathChanged && !options.replace) window.scrollTo(0, 0);
}

/** Current path and query; re-renders the caller on every navigation. */
export function useLocation(): { path: string; search: string } {
  const [, setTick] = useState(0);
  const seen = useRef(current);
  seen.current = current;
  useEffect(() => {
    const listener = () => {
      if (seen.current !== current) setTick((n) => n + 1);
    };
    listeners.add(listener);
    // A navigation may have happened between render and effect.
    listener();
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return current;
}

/** Params of the route the app matched for the current page. */
export const RouteParamsContext = createContext<Record<string, string>>({});

export function useRoute(): RouteState {
  const { path, search } = useLocation();
  const params = useContext(RouteParamsContext);
  const query = useMemo(() => new URLSearchParams(search), [search]);
  return { path, params, query };
}

/**
 * Matches "/locations/:id" style patterns. Returns the params, or null when the path does not match.
 * Trailing slashes are ignored; params are URI-decoded.
 */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const split = (value: string) => value.replace(/\/+$/, '').split('/').filter((part, index) => index === 0 || part !== '');
  const want = split(pattern);
  const have = split(path || '/');
  if (want.length !== have.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i += 1) {
    const part = want[i];
    const value = have[i];
    if (part.startsWith(':')) {
      if (!value) return null;
      try {
        params[part.slice(1)] = decodeURIComponent(value);
      } catch {
        return null;
      }
    } else if (part !== value) {
      return null;
    }
  }
  return params;
}

// Stand-in origin for resolving a path on its own; only "is it still this origin" matters.
const PATH_BASE = 'http://app.invalid';
const PATH_BASE_ORIGIN = new URL(PATH_BASE).origin;

/**
 * Returns `next` as a normalised in-app path (path, query and hash) when it is safe to go back to after
 * signing in, else null. Control characters and backslashes are refused outright: the URL parser drops
 * tabs and newlines and reads "\" as "/", which would turn "/\t/evil.example" into another site.
 */
export function safeNextPath(next: string | null): string | null {
  if (!next || !next.startsWith('/')) return null;
  if (/[\x00-\x1f\x7f\\]/.test(next)) return null;
  let url: URL;
  try {
    url = new URL(next, PATH_BASE);
  } catch {
    return null;
  }
  if (url.origin !== PATH_BASE_ORIGIN) return null;
  const path = url.pathname + url.search + url.hash;
  // "/a/..//evil.example" resolves to a pathname of "//evil.example", which reads as another site.
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  if (url.pathname.startsWith('/login') || url.pathname.startsWith('/setup')) return null;
  return path;
}

export interface LinkProps {
  href: string;
  replace?: boolean;
  class?: string;
  title?: string;
  target?: string;
  download?: string | boolean;
  'aria-current'?: 'page' | 'true' | undefined;
  'aria-label'?: string;
  onClick?: (event: TargetedMouseEvent<HTMLAnchorElement>) => void;
  children?: ComponentChildren;
}

/** A plain link that routes in-app paths without a page load. */
export function Link(props: LinkProps) {
  const { href, replace, onClick, children, ...rest } = props;
  const handleClick = (event: TargetedMouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (!isRouterClick(event, href, event.currentTarget)) return;
    event.preventDefault();
    navigate(href, { replace });
  };
  return h('a', { ...rest, href, onClick: handleClick }, children);
}
