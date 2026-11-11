// The location the Live, Recordings and Cameras screens show. The last choice is remembered in this browser
// (a convenience only: it falls back to the first location when storage is blocked or the location is gone).

import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import type { LocationSummary, LocationsResponse } from '../../../../shared/api-types.ts';
import { Select } from '../../components/index.ts';
import type { SelectOption } from '../../components/index.ts';
import { apiGet, isAbort } from '../../lib/api.ts';

const STORAGE_KEY = 'comffee-cctv.location';

function readStored(): number | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const id = raw ? Number(raw) : NaN;
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function writeStored(id: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(id));
  } catch {
    // Storage blocked (private window): the choice just is not remembered.
  }
}

export interface LocationsState {
  locations: LocationSummary[] | null;
  error: unknown;
  reload: () => void;
  /** Replaces one location after a change (for example recording paused). */
  replace: (location: LocationSummary) => void;
}

/** GET /api/locations (viewers get only their own). */
export function useLocations(): LocationsState {
  const [locations, setLocations] = useState<LocationSummary[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    apiGet<LocationsResponse>('/api/locations', undefined, { signal: controller.signal })
      .then((res) => setLocations(res.locations))
      .catch((err) => {
        if (!isAbort(err)) setError(err);
      });
    return () => controller.abort();
  }, [tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const replace = useCallback((next: LocationSummary) => {
    setLocations((list) => (list ? list.map((item) => (item.id === next.id ? next : item)) : list));
  }, []);
  return { locations, error, reload, replace };
}

/**
 * The chosen location: `preferredId` (for example from the address) first, then the remembered one, then the
 * first in the list.
 */
export function useLocationChoice(
  locations: LocationSummary[] | null,
  preferredId?: number | null,
): [LocationSummary | null, (id: number) => void] {
  const [chosenId, setChosenId] = useState<number | null>(() => preferredId ?? readStored());
  const location = useMemo(() => {
    if (!locations || locations.length === 0) return null;
    return locations.find((item) => item.id === chosenId) ?? locations[0];
  }, [locations, chosenId]);
  const choose = useCallback((id: number) => {
    setChosenId(id);
    writeStored(id);
  }, []);
  return [location, choose];
}

/** Location picker for the top bar; just the name when there is only one location. */
export function LocationPicker({
  locations,
  location,
  onChange,
}: {
  locations: LocationSummary[] | null;
  location: LocationSummary | null;
  onChange: (id: number) => void;
}) {
  if (!locations || !location) return null;
  if (locations.length < 2) return <span class="truncate">{location.name}</span>;
  const options: SelectOption<number>[] = locations.map((item) => ({
    value: item.id,
    label: item.name,
    detail: item.online ? undefined : 'Offline',
  }));
  return <Select aria-label="Location" value={location.id} options={options} onChange={onChange} />;
}
