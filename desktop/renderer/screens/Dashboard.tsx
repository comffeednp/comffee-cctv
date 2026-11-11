// A server's dashboard. The main process lays the server's own page over this area; what is drawn here
// shows only while it loads, when it could not open, or while a menu of the top bar is open.
import { useEffect, useState } from 'preact/hooks';
import { Button, EmptyState } from '../../../dashboard/src/components/index.ts';
import type { ViewStatus } from '../../src/lib/ipc-types.ts';
import { Loading } from '../components/Parts.tsx';
import { call, cctv, errorText, useAppState, useEvent } from '../lib/bridge.ts';
import { navigate } from '../lib/router.ts';

export function Dashboard({ serverId }: { serverId: string }) {
  const state = useAppState();
  const server = state?.servers.find((s) => s.id === serverId) ?? null;
  const [status, setStatus] = useState<ViewStatus | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  useEvent('view', (view) => {
    if (view.serverId === serverId) setStatus(view);
  }, [serverId]);

  const installing = server?.status === 'installing';
  useEffect(() => {
    if (!state) return;
    if (!server) {
      navigate('/', true);
      return;
    }
    if (installing) {
      navigate(`/wait/${serverId}`, true);
      return;
    }
    setOpenError(null);
    setStatus(null);
    call(cctv.showServer(serverId)).catch((err) => setOpenError(errorText(err)));
    return () => {
      void cctv.hideServer();
    };
  }, [serverId, !!server, installing, !!state]);

  if (!server) return <Loading label="Loading" />;
  const failed = openError ?? (status?.state === 'failed' ? status.message : null);
  return (
    <main id="main" tabIndex={-1} class="desk-view-status">
      {failed ? (
        <EmptyState
          icon="warning"
          title="Could not open"
          message={failed}
          action={
            <Button variant="primary" icon="refresh" onClick={() => void cctv.reloadServer()}>
              Try again
            </Button>
          }
        />
      ) : (
        <Loading label={`Opening ${server.name}`} />
      )}
    </main>
  );
}
