import { createContext } from 'preact';
import type { ComponentChildren } from 'preact';
import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import type { Me } from '../../../shared/api-types.ts';
import { AppShell, Button } from '../components/index.ts';
import type { NavItem } from '../components/index.ts';
import { isOwner, signOut } from '../lib/session.ts';

interface TopBarSlots {
  title?: ComponentChildren;
  actions?: ComponentChildren;
}

type SetTopBar = (slots: TopBarSlots) => void;

const TopBarContext = createContext<SetTopBar | null>(null);

/**
 * Lets a page put a short context (a location name or picker) and icon buttons in the top bar.
 * Pass the values every render; `deps` decides when they are re-sent. Cleared when the page unmounts.
 */
export function useTopBar(title: ComponentChildren, actions: ComponentChildren, deps: readonly unknown[]): void {
  const set = useContext(TopBarContext);
  useEffect(() => {
    set?.({ title, actions });
  }, deps);
  useEffect(() => () => set?.({}), []);
}

/** The navigation each role sees. Viewers only get Watch, Footage and Settings. */
export function navFor(me: Me, path: string): NavItem[] {
  const at = (prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
  const items: NavItem[] = [
    { href: '/live', label: 'Watch', icon: 'live', current: at('/live') },
    { href: '/recordings', label: 'Footage', icon: 'recordings', current: at('/recordings') },
  ];
  if (isOwner(me)) {
    items.push(
      { href: '/cameras', label: 'Cameras', icon: 'cameras', current: at('/cameras') },
      { href: '/locations', label: 'Locations', icon: 'locations', current: at('/locations') },
    );
  }
  items.push({ href: '/settings', label: 'Settings', icon: 'settings', current: at('/settings') });
  return items;
}

/** The signed-in frame: navigation for the person's role, top bar slots and a sign-out button. */
export function Shell({ me, path, children }: { me: Me; path: string; children: ComponentChildren }) {
  const [slots, setSlots] = useState<TopBarSlots>({});
  const firstPath = useRef(path);

  // After an in-app navigation, move focus to the new page so screen readers start at its heading.
  useEffect(() => {
    if (path === firstPath.current) return;
    firstPath.current = path;
    document.getElementById('main')?.focus({ preventScroll: true });
  }, [path]);

  return (
    <TopBarContext.Provider value={setSlots}>
      <AppShell
        nav={navFor(me, path)}
        title={slots.title}
        actions={slots.actions}
        sideFooter={
          <div class="stack-8">
            <span class="k-body-s truncate">
              Signed in as <span class="text-cream">{me.username}</span>
            </span>
            <Button variant="ghost" icon="log-out" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        }
      >
        {children}
      </AppShell>
    </TopBarContext.Provider>
  );
}
