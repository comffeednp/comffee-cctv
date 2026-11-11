import { createContext } from 'preact';
import type { TargetedMouseEvent } from 'preact';
import { useContext } from 'preact/hooks';

/** Moves the app to an in-app path without a page load. The app's router provides it. */
export type Navigate = (href: string) => void;

/**
 * Wrap the app in `<NavigationContext.Provider value={navigate}>` once. Every component that takes an
 * `href` (Button, IconButton, ListRow, AppShell nav, PageHeader back link) then routes plain clicks on
 * in-app paths through it. Without a provider they behave as normal links.
 */
export const NavigationContext = createContext<Navigate | null>(null);

export function useNavigate(): Navigate | null {
  return useContext(NavigationContext);
}

/** True for a plain left click on a same-origin path that the router should handle. */
export function isRouterClick(event: MouseEvent, href: string | undefined, anchor?: HTMLAnchorElement | null): boolean {
  if (!href || event.defaultPrevented) return false;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  if (!href.startsWith('/') || href.startsWith('//')) return false;
  if (anchor && (anchor.hasAttribute('download') || (anchor.target && anchor.target !== '_self'))) return false;
  return true;
}

/** Click handler for an element with an `href`: runs `onClick`, then hands in-app paths to the router. */
export function useLinkClick<T extends HTMLElement>(
  href: string | undefined,
  onClick?: (event: TargetedMouseEvent<T>) => void,
): (event: TargetedMouseEvent<T>) => void {
  const navigate = useNavigate();
  return (event) => {
    onClick?.(event);
    if (!navigate || !href) return;
    const anchor = event.currentTarget instanceof HTMLAnchorElement ? event.currentTarget : null;
    if (!isRouterClick(event, href, anchor)) return;
    event.preventDefault();
    navigate(href);
  };
}
