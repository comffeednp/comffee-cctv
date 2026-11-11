import type { ComponentChildren } from 'preact';
import { Badge } from './Badge.tsx';
import { Icon } from './Icons.tsx';
import type { IconName } from './Icons.tsx';
import { useLinkClick } from './navigation.ts';

export interface NavItem {
  href: string;
  /** One or two words, sentence case ("Live", "Recordings"). */
  label: string;
  icon: IconName;
  /** True for the section the current page belongs to. */
  current?: boolean;
  /** A count or short word shown as a badge. */
  badge?: string | number;
  /** Set false to keep an item off the phone bottom bar (desktop side nav only). The bar holds at most 5. */
  phone?: boolean;
}

export interface AppShellProps {
  nav: readonly NavItem[];
  /** Short context in the top bar (a location name, a location picker). Not a heading: the page's h1 lives in PageHeader. */
  title?: ComponentChildren;
  /** Icon buttons on the right of the top bar. */
  actions?: ComponentChildren;
  /** Bottom of the desktop side nav (for example the signed-in person and a sign-out button). */
  sideFooter?: ComponentChildren;
  /** Product name in the side nav. Defaults to "Comffee CCTV". */
  productName?: string;
  /** Accessible names of the two navs. */
  navLabel?: string;
  children: ComponentChildren;
}

function NavLink({ item }: { item: NavItem }) {
  const onClick = useLinkClick<HTMLAnchorElement>(item.href);
  return (
    <a
      class="app-nav-link"
      href={item.href}
      aria-current={item.current ? 'page' : undefined}
      title={item.label}
      onClick={onClick}
    >
      <Icon name={item.icon} size={24} />
      <span class="app-nav-label">{item.label}</span>
      {item.badge !== undefined && item.badge !== '' && (
        <span class="app-nav-badge">
          <Badge tone="count">{item.badge}</Badge>
        </span>
      )}
    </a>
  );
}

/**
 * The frame of every signed-in screen: a side nav from 1024 px, a bottom bar below that, a sticky top
 * bar with the title and action slots, and the main area where the page renders (PageHeader first).
 */
export function AppShell({
  nav,
  title,
  actions,
  sideFooter,
  productName = 'Comffee CCTV',
  navLabel = 'Main',
  children,
}: AppShellProps) {
  const phoneNav = nav.filter((item) => item.phone !== false).slice(0, 5);
  return (
    <div class="app-shell">
      <a class="skip-link" href="#main">
        Skip to content
      </a>
      <aside class="app-sidenav">
        <div class="app-sidenav-brand">
          <Icon name="cameras" size={24} />
          <span>{productName}</span>
        </div>
        <nav aria-label={navLabel}>
          <ul class="app-sidenav-list" role="list">
            {nav.map((item) => (
              <li key={item.href}>
                <NavLink item={item} />
              </li>
            ))}
          </ul>
        </nav>
        {sideFooter && <div class="app-sidenav-footer">{sideFooter}</div>}
      </aside>
      <div class="app-column">
        <header class="app-topbar">
          <span class="app-topbar-brand" aria-hidden="true">
            <Icon name="cameras" size={24} />
          </span>
          <div class="app-topbar-title">{title}</div>
          {actions && <div class="app-topbar-actions">{actions}</div>}
        </header>
        <main id="main" class="app-main" tabIndex={-1}>
          {children}
        </main>
      </div>
      <nav class="app-bottomnav" aria-label={navLabel}>
        {phoneNav.map((item) => (
          <NavLink key={item.href} item={item} />
        ))}
      </nav>
    </div>
  );
}
