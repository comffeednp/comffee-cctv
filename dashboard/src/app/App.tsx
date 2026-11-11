import type { ComponentType } from 'preact';
import { useEffect } from 'preact/hooks';
import { Button, EmptyState, PageHeader } from '../components/index.ts';
import { RouteParamsContext, matchPath, safeNextPath, useLocation } from '../lib/router.ts';
import { isOwner, refreshMe, refreshSetupStatus, useMe, useSetupStatus } from '../lib/session.ts';
import { Loading, Redirect } from './Redirect.tsx';
import { Shell } from './Shell.tsx';
import { LivePage } from '../pages/live/LivePage.tsx';
import { RecordingsPage } from '../pages/recordings/RecordingsPage.tsx';
import { CamerasPage } from '../pages/cameras/CamerasPage.tsx';
import { AddCameraPage } from '../pages/cameras/AddCameraPage.tsx';
import { SetupPage } from '../pages/setup/SetupPage.tsx';
import { LoginPage } from '../pages/login/LoginPage.tsx';
import { LocationsPage } from '../pages/locations/LocationsPage.tsx';
import { NewLocationPage } from '../pages/locations/NewLocationPage.tsx';
import { LocationDetailPage } from '../pages/locations/LocationDetailPage.tsx';
import { SettingsPage } from '../pages/settings/SettingsPage.tsx';
import { AccountPage } from '../pages/settings/AccountPage.tsx';
import { UsersPage } from '../pages/settings/UsersPage.tsx';
import { AuditPage } from '../pages/settings/AuditPage.tsx';
import { StoragePage } from '../pages/settings/StoragePage.tsx';
import { RecoveryKeyPage } from '../pages/settings/RecoveryKeyPage.tsx';
import { NewRecoveryKeyPage } from '../pages/settings/NewRecoveryKeyPage.tsx';

const PRODUCT = 'Comffee CCTV';

interface RouteDef {
  pattern: string;
  title: string;
  page: ComponentType;
  /** Owner only: viewers are sent to Watch (/live). */
  owner?: boolean;
}

// Order matters: fixed paths come before patterns that would also match them.
const ROUTES: readonly RouteDef[] = [
  { pattern: '/live', title: 'Watch', page: LivePage },
  { pattern: '/recordings', title: 'Footage', page: RecordingsPage },
  { pattern: '/cameras', title: 'Cameras', page: CamerasPage, owner: true },
  { pattern: '/cameras/add', title: 'Add camera', page: AddCameraPage, owner: true },
  { pattern: '/locations', title: 'Locations', page: LocationsPage, owner: true },
  { pattern: '/locations/new', title: 'New location', page: NewLocationPage, owner: true },
  { pattern: '/locations/:id', title: 'Location', page: LocationDetailPage, owner: true },
  { pattern: '/settings', title: 'Settings', page: SettingsPage },
  { pattern: '/settings/account', title: 'My account', page: AccountPage },
  { pattern: '/settings/users', title: 'Users', page: UsersPage, owner: true },
  { pattern: '/settings/audit', title: 'Audit log', page: AuditPage, owner: true },
  { pattern: '/settings/storage', title: 'Storage', page: StoragePage, owner: true },
  { pattern: '/settings/recovery-key', title: 'Recovery key', page: RecoveryKeyPage },
  { pattern: '/settings/recovery-key/new', title: 'New recovery key', page: NewRecoveryKeyPage, owner: true },
];

function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title === PRODUCT ? PRODUCT : `${title} - ${PRODUCT}`;
  }, [title]);
}

function HubUnreachable() {
  useDocumentTitle('Hub not reachable');
  return (
    <main id="main" class="app-main auth-main">
      <PageHeader title="Hub not reachable" subtitle="The dashboard could not reach your hub." />
      <EmptyState
        icon="cloud"
        title="No answer from the hub"
        message="Check your internet connection, then try again."
        action={
          <Button
            variant="primary"
            icon="refresh"
            onClick={() => {
              void refreshSetupStatus();
              void refreshMe();
            }}
          >
            Try again
          </Button>
        }
      />
    </main>
  );
}

function NotFound() {
  useDocumentTitle('Page not found');
  return (
    <>
      <PageHeader title="Page not found" subtitle="This address does not lead anywhere in the dashboard." />
      <EmptyState
        icon="info"
        title="Nothing here"
        message="Go back to watching your cameras."
        action={
          <Button variant="primary" href="/live">
            Watch cameras
          </Button>
        }
      />
    </>
  );
}

function RoutedPage({ route, params }: { route: RouteDef; params: Record<string, string> }) {
  useDocumentTitle(route.title);
  const Page = route.page;
  return (
    <RouteParamsContext.Provider value={params}>
      <Page />
    </RouteParamsContext.Provider>
  );
}

/** Auth gate and routes: /setup until an owner exists, /login until signed in, then the signed-in pages. */
export function App() {
  const { path, search } = useLocation();
  const setup = useSetupStatus();
  const session = useMe();

  if (setup.loading || session.loading) return <Loading />;
  if (!setup.status) return <HubUnreachable />;

  if (path === '/setup') return <SetupPage />;
  if (setup.status.needsSetup) return <Redirect to="/setup" />;

  const me = session.me;
  if (path === '/login') {
    if (!me) return <LoginPage />;
    // Signed in (just now, or from before): go where they were heading. An owner without a recovery key
    // finishes setup first, because nothing can be recorded until that key exists.
    const next = safeNextPath(new URLSearchParams(search).get('next'));
    if (isOwner(me) && !setup.status.hasVaultKey) return <Redirect to="/setup" />;
    return <Redirect to={next ?? '/live'} />;
  }
  if (!me) {
    if (session.error) return <HubUnreachable />;
    const here = safeNextPath(path + search);
    return <Redirect to={here && here !== '/' ? `/login?next=${encodeURIComponent(here)}` : '/login'} />;
  }
  if (path === '/' || path === '') return <Redirect to="/live" />;

  for (const route of ROUTES) {
    const params = matchPath(route.pattern, path);
    if (!params) continue;
    if (route.owner && !isOwner(me)) return <Redirect to="/live" />;
    return (
      <Shell me={me} path={path}>
        <RoutedPage key={path} route={route} params={params} />
      </Shell>
    );
  }
  return (
    <Shell me={me} path={path}>
      <NotFound />
    </Shell>
  );
}
