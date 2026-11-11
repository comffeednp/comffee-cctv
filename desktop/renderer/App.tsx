// Route table of the local screens.
import { useEffect } from 'preact/hooks';
import { TopBar, Loading } from './components/Parts.tsx';
import { useAppState } from './lib/bridge.ts';
import { match, navigate, useRoute } from './lib/router.ts';
import { ChooseAccount, LinkServer, Welcome } from './screens/Start.tsx';
import { ApiKey, Connect, SignIn } from './screens/Connect.tsx';
import { Creating, Plan, WaitForHub } from './screens/Create.tsx';
import { Dashboard } from './screens/Dashboard.tsx';
import { AccountDetail, ServerDetail, ServerName, Settings, Source } from './screens/Settings.tsx';

const ID = /^[a-z0-9]{16,40}$/;

function cleanId(value: string | null): string | null {
  return value && ID.test(value) ? value : null;
}

function Home() {
  const state = useAppState();
  useEffect(() => {
    if (!state) return;
    if (!state.servers.length) {
      navigate('/welcome', true);
      return;
    }
    const selected = state.servers.find((s) => s.id === state.selectedServerId) ?? state.servers[0]!;
    navigate(`/server/${selected.id}`, true);
  }, [state]);
  return <Loading label="Loading" />;
}

export function App() {
  const route = useRoute();
  const state = useAppState();
  const { path, query } = route;
  const replace = cleanId(query.get('replace'));

  let screen;
  let params: Record<string, string> | null;
  let currentServer: string | null = state?.selectedServerId ?? null;
  if (path === '/') screen = <Home />;
  else if (path === '/welcome') screen = <Welcome firstRun />;
  else if (path === '/add') screen = <Welcome firstRun={false} />;
  else if (path === '/link') screen = <LinkServer />;
  else if (path === '/new-server') screen = <ChooseAccount />;
  else if (path === '/connect') screen = <Connect replace={replace} />;
  else if (path === '/connect/sign-in') screen = <SignIn replace={replace} />;
  else if (path === '/connect/api-key') screen = <ApiKey replace={replace} />;
  else if (path === '/create') screen = <Creating />;
  else if (path === '/settings') screen = <Settings />;
  else if (path === '/settings/source') screen = <Source />;
  else if ((params = match('/plan/:id', path)) && cleanId(params.id!)) screen = <Plan key={params.id} accountId={params.id!} />;
  else if ((params = match('/wait/:id', path)) && cleanId(params.id!)) screen = <WaitForHub key={params.id} serverId={params.id!} />;
  else if ((params = match('/server/:id', path)) && cleanId(params.id!)) {
    currentServer = params.id!;
    screen = <Dashboard key={params.id} serverId={params.id!} />;
  } else if ((params = match('/settings/account/:id', path)) && cleanId(params.id!)) screen = <AccountDetail key={params.id} accountId={params.id!} />;
  else if ((params = match('/settings/server/:id', path)) && cleanId(params.id!)) screen = <ServerDetail key={params.id} serverId={params.id!} />;
  else if ((params = match('/settings/server/:id/name', path)) && cleanId(params.id!)) screen = <ServerName key={params.id} serverId={params.id!} />;
  else screen = <Home />;

  const servers = state?.servers ?? [];
  return (
    <div class="desk-app">
      {servers.length > 0 && <TopBar servers={servers} currentId={currentServer} />}
      <div class="desk-content">{screen}</div>
    </div>
  );
}
