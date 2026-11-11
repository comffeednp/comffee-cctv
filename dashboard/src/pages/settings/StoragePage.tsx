import { useEffect, useState } from 'preact/hooks';
import type { StorageResponse } from '../../../../shared/api-types.ts';
import { Badge, Button, Card, EmptyState, Icon, IconButton, PageHeader, Section } from '../../components/index.ts';
import { apiGet, describeError } from '../../lib/api.ts';
import { browserTimezone, formatBytes, formatDate, plural } from '../../lib/format.ts';
import { PageLoading } from '../../app/Redirect.tsx';

/** Storage (owner only): disk space, and per location how many days of recordings fit against the keep limit. */
export function StoragePage() {
  const [storage, setStorage] = useState<StorageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    apiGet<StorageResponse>('/api/storage', undefined, { signal: controller.signal })
      .then(setStorage)
      .catch((err) => {
        if (!controller.signal.aborted) setError(describeError(err));
      });
    return () => controller.abort();
  }, [reload]);

  const header = (
    <PageHeader
      back={{ href: '/settings', label: 'Settings' }}
      title="Storage"
      subtitle="Space on the hub, and how long recordings fit."
      actions={<IconButton icon="refresh" label="Refresh" onClick={() => setReload((n) => n + 1)} />}
    />
  );

  if (error) {
    return (
      <>
        {header}
        <EmptyState icon="warning" title="Could not load storage" message={error} action={<Button icon="refresh" onClick={() => setReload((n) => n + 1)}>Try again</Button>} />
      </>
    );
  }
  if (!storage) return <PageLoading label="Loading storage" />;

  const tz = browserTimezone();
  const lowSpace = storage.freeBytes < storage.minFreeBytes * 1.5;

  return (
    <>
      {header}
      <Section title="Hub disk" lead="The oldest recordings are deleted early if free space runs low.">
        <Card>
          <div class="stack">
          <div class="pairs k-body-s">
            <div>
              <span>Recordings</span>
              <span class="text-cream tnum">{formatBytes(storage.vaultBytes)}</span>
            </div>
            <div>
              <span>Free space</span>
              <span class="text-cream tnum">{formatBytes(storage.freeBytes)}</span>
            </div>
            <div>
              <span>Disk size</span>
              <span class="text-cream tnum">{formatBytes(storage.totalBytes)}</span>
            </div>
            <div>
              <span>Always kept free</span>
              <span class="text-cream tnum">{formatBytes(storage.minFreeBytes)}</span>
            </div>
          </div>
          {lowSpace && (
            <p class="notice k-body-s text-amber" role="status">
              <Icon name="warning" size={16} />
              <span>Free space is nearly at the limit. Old recordings will soon be deleted before their keep limit.</span>
            </p>
          )}
          </div>
        </Card>
      </Section>

      <Section title="Locations" lead="How many days fit at each location's usual rate.">
        {storage.perLocation.length === 0 ? (
          <EmptyState icon="storage" title="Nothing stored yet" message="Recordings show up here once cameras record." />
        ) : (
          <div class="grid-2">
            {storage.perLocation.map((item) => {
              const short = item.estimatedDaysFit !== null && item.estimatedDaysFit < item.retentionDays;
              return (
                <Card
                  key={item.locationId}
                  title={item.name}
                  subtitle={`Keeps ${plural(item.retentionDays, 'day')}`}
                  icon="locations"
                  actions={short ? <Badge tone="amber">Space short</Badge> : undefined}
                >
                  <div class="stack">
                    <div class="pairs k-body-s">
                      <div>
                        <span>Used</span>
                        <span class="text-cream tnum">{formatBytes(item.bytes)}</span>
                      </div>
                      <div>
                        <span>Per day</span>
                        <span class="text-cream tnum">{item.avgBytesPerDay > 0 ? formatBytes(item.avgBytesPerDay) : ''}</span>
                      </div>
                      <div>
                        <span>Oldest</span>
                        <span class="text-cream tnum">{formatDate(item.oldest, tz)}</span>
                      </div>
                      <div>
                        <span>Newest</span>
                        <span class="text-cream tnum">{formatDate(item.newest, tz)}</span>
                      </div>
                      <div>
                        <span>Days that fit</span>
                        <span class="text-cream tnum">{item.estimatedDaysFit === null ? '' : String(Math.floor(item.estimatedDaysFit))}</span>
                      </div>
                    </div>
                    {short && (
                      <p class="notice k-body-s text-amber" role="status">
                        <Icon name="warning" size={16} />
                        <span>
                          Only about {plural(Math.floor(item.estimatedDaysFit ?? 0), 'day')} fit, but this location keeps{' '}
                          {plural(item.retentionDays, 'day')}. Lower the days kept, record fewer cameras or use a lower quality.
                        </span>
                      </p>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </Section>
    </>
  );
}
