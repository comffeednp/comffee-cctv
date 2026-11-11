import { useEffect, useState } from 'preact/hooks';
import type { LocationSummary, LocationsResponse } from '../../../../shared/api-types.ts';
import { Button, EmptyState, GroupedList, IconButton, ListRow, PageHeader, Section, StatusDot } from '../../components/index.ts';
import { apiGet, describeError } from '../../lib/api.ts';
import { plural } from '../../lib/format.ts';
import { PageLoading } from '../../app/Redirect.tsx';
import { connectorInfo, recordingWord } from './location-text.ts';

/** Every location (a shop, branch or home) with how it connects, whether it is online and recording. */
export function LocationsPage() {
  const [locations, setLocations] = useState<LocationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    apiGet<LocationsResponse>('/api/locations', undefined, { signal: controller.signal })
      .then((result) => setLocations(result.locations))
      .catch((err) => {
        if (!controller.signal.aborted) setError(describeError(err));
      });
    return () => controller.abort();
  }, [reload]);

  return (
    <>
      <PageHeader
        title="Locations"
        subtitle="Each place with cameras, and how the hub reaches it."
        actions={
          <Button variant="primary" icon="plus" href="/locations/new">
            Add location
          </Button>
        }
      />
      {error ? (
        <EmptyState
          icon="warning"
          title="Could not load locations"
          message={error}
          action={
            <Button icon="refresh" onClick={() => setReload((n) => n + 1)}>
              Try again
            </Button>
          }
        />
      ) : locations === null ? (
        <PageLoading label="Loading locations" />
      ) : locations.length === 0 ? (
        <EmptyState
          icon="locations"
          title="No locations yet"
          message="Add the place where your cameras are."
          action={
            <Button variant="primary" icon="plus" href="/locations/new">
              Add location
            </Button>
          }
        />
      ) : (
        <Section
          title="Your locations"
          lead="Open one to see its setup, recording and settings."
          actions={<IconButton icon="refresh" label="Refresh" onClick={() => setReload((n) => n + 1)} />}
        >
          <GroupedList label="Locations">
            {locations.map((location) => (
              <ListRow
                key={location.id}
                icon={connectorInfo(location.connector).icon}
                title={location.name}
                secondary={`${connectorInfo(location.connector).short} · ${recordingWord(location)}`}
                value={plural(location.cameraCount, 'camera')}
                trailing={<StatusDot status={location.online ? 'online' : 'offline'} />}
                href={`/locations/${location.id}`}
              />
            ))}
          </GroupedList>
        </Section>
      )}
    </>
  );
}
