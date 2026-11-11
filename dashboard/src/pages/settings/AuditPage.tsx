import { useEffect, useState } from 'preact/hooks';
import type { AuditAction, AuditItem, AuditPage as AuditPageBody } from '../../../../shared/api-types.ts';
import { Button, EmptyState, GroupedList, IconButton, ListRow, PageHeader, Section, useToast } from '../../components/index.ts';
import { apiGet, describeError } from '../../lib/api.ts';
import { browserTimezone, formatDateTime } from '../../lib/format.ts';
import { PageLoading } from '../../app/Redirect.tsx';

const PAGE_SIZE = 50;

const ACTION_LABELS: Record<AuditAction, string> = {
  'auth.login': 'Signed in',
  'auth.login_failed': 'Sign-in failed',
  'auth.logout': 'Signed out',
  'auth.totp_enrolled': '2-step linked',
  'setup.owner': 'Hub set up',
  'account.password': 'Password changed',
  'account.totp_reset': '2-step reset',
  'user.create': 'Viewer added',
  'user.update': 'Viewer changed',
  'user.delete': 'Viewer deleted',
  'vault.key_set': 'Recovery key set',
  'location.create': 'Location added',
  'location.update': 'Location changed',
  'location.delete': 'Location deleted',
  'location.bridge_token': 'Bridge token made',
  'location.detect': 'Cameras searched',
  'location.recording_on': 'Location recording on',
  'location.recording_off': 'Location recording paused',
  'location.camera_login': 'Camera login changed',
  'camera.create': 'Camera added',
  'camera.update': 'Camera changed',
  'camera.delete': 'Camera deleted',
  'camera.recording_on': 'Camera recording on',
  'camera.recording_off': 'Camera recording off',
  'live.start': 'Live view opened',
  'recording.download': 'Recording opened',
  'storage.prune': 'Old recordings removed for space',
};

function secondaryLine(item: AuditItem): string {
  const who = item.username ?? 'Hub';
  const parts = [who];
  if (item.detail) parts.push(item.detail);
  else if (item.target) parts.push(item.target);
  if (item.ip) parts.push(item.ip);
  return parts.join(' · ');
}

/** Audit log (owner only): who did what and when, newest first. */
export function AuditPage() {
  const toast = useToast();
  const [items, setItems] = useState<AuditItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reload, setReload] = useState(0);
  const tz = browserTimezone();

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    apiGet<AuditPageBody>('/api/audit', { limit: PAGE_SIZE }, { signal: controller.signal })
      .then((page) => {
        setItems(page.items);
        setCursor(page.nextCursor);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(describeError(err));
      });
    return () => controller.abort();
  }, [reload]);

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await apiGet<AuditPageBody>('/api/audit', { limit: PAGE_SIZE, cursor });
      setItems((current) => [...(current ?? []), ...page.items]);
      setCursor(page.nextCursor);
    } catch (err) {
      toast.show({ message: describeError(err), tone: 'error' });
    } finally {
      setLoadingMore(false);
    }
  };

  const header = (
    <PageHeader
      back={{ href: '/settings', label: 'Settings' }}
      title="Audit log"
      subtitle="Sign-ins and changes on this hub, newest first."
      actions={<IconButton icon="refresh" label="Refresh" onClick={() => setReload((n) => n + 1)} />}
    />
  );

  if (error) {
    return (
      <>
        {header}
        <EmptyState icon="warning" title="Could not load the log" message={error} action={<Button icon="refresh" onClick={() => setReload((n) => n + 1)}>Try again</Button>} />
      </>
    );
  }
  if (!items) return <PageLoading label="Loading the log" />;

  return (
    <>
      {header}
      <Section title="Events" lead={`Times shown in ${tz.replace(/_/g, ' ')}.`}>
        {items.length === 0 ? (
          <EmptyState icon="audit" title="Nothing yet" message="Sign-ins and changes show up here." />
        ) : (
          <div class="stack">
            <GroupedList label="Events">
              {items.map((item) => (
                <ListRow
                  key={item.id}
                  icon={item.action === 'auth.login_failed' ? 'warning' : 'audit'}
                  title={ACTION_LABELS[item.action] ?? item.action}
                  secondary={secondaryLine(item)}
                  value={formatDateTime(item.at, tz)}
                  tone={item.action === 'auth.login_failed' ? 'amber' : 'default'}
                />
              ))}
            </GroupedList>
            {cursor && (
              <div class="actions">
                <Button onClick={() => void loadMore()} loading={loadingMore} loadingLabel="Loading...">
                  Load more
                </Button>
              </div>
            )}
          </div>
        )}
      </Section>
    </>
  );
}
