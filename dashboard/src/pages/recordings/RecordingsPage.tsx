// All footage: every recorded part of the chosen location, newest or oldest first, narrowed by camera, day and
// time. Each row opens that moment in the camera workspace (/live?camera=<id>&at=<time>). All times are in the
// location's timezone.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type {
  CameraSummary,
  CamerasResponse,
  RecordingDaysResponse,
  RecordingItem,
  RecordingsPage as RecordingsPageResponse,
} from '../../../../shared/api-types.ts';
import {
  Button,
  CalendarMonth,
  EmptyState,
  FormField,
  GroupedList,
  IconButton,
  ListRow,
  PageHeader,
  Section,
  SegmentedControl,
  Select,
  Spinner,
  useToast,
} from '../../components/index.ts';
import type { SelectOption } from '../../components/index.ts';
import { useTopBar } from '../../app/Shell.tsx';
import { apiGet, describeError, isAbort } from '../../lib/api.ts';
import { formatDate, formatDuration, formatTime } from '../../lib/format.ts';
import { LocationPicker, useLocationChoice, useLocations } from '../live/location-choice.tsx';
import { dayLabel, hourLabel, shiftMonth, todayIn, zonedTime } from './time.ts';
import './recordings.css';

type Order = 'desc' | 'asc';

const LIST_PAGE = 50;
const ALL_CAMERAS = 0;

const FROM_OPTIONS: SelectOption<number>[] = Array.from({ length: 24 }, (_, hour) => ({ value: hour, label: hourLabel(hour) }));
const TO_OPTIONS: SelectOption<number>[] = Array.from({ length: 24 }, (_, i) => ({ value: i + 1, label: hourLabel(i + 1) }));

/** The camera workspace at the start of this part. */
function momentPath(item: RecordingItem): string {
  return `/live?${new URLSearchParams({ camera: String(item.cameraId), at: item.start }).toString()}`;
}

export function RecordingsPage() {
  const toast = useToast();
  const { locations, error: locationsError, reload: reloadLocations } = useLocations();
  const [location, chooseLocation] = useLocationChoice(locations);
  const locationId = location?.id ?? null;
  const tz = location?.timezone ?? 'UTC';
  const today = todayIn(tz);

  const [cameras, setCameras] = useState<CameraSummary[] | null>(null);
  const [cameraId, setCameraId] = useState<number>(ALL_CAMERAS);
  const [day, setDay] = useState<string | null>(null);
  const [month, setMonth] = useState<string>(today.slice(0, 7));
  const [fromHour, setFromHour] = useState(0);
  const [toHour, setToHour] = useState(24);
  const [order, setOrder] = useState<Order>('desc');
  const [refresh, setRefresh] = useState(0);

  const [marked, setMarked] = useState<string[]>([]);
  const [loadingDays, setLoadingDays] = useState(false);
  const [items, setItems] = useState<RecordingItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [listError, setListError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useTopBar(
    <LocationPicker locations={locations} location={location} onChange={chooseLocation} />,
    <IconButton icon="refresh" label="Reload footage" onClick={() => setRefresh((n) => n + 1)} />,
    [locations, locationId],
  );

  // A new location starts over: all cameras, any day.
  const firstLocation = useRef(true);
  useEffect(() => {
    if (locationId === null) return;
    if (!firstLocation.current) {
      setCameraId(ALL_CAMERAS);
      setDay(null);
    }
    firstLocation.current = false;
    setMonth(todayIn(tz).slice(0, 7));
  }, [locationId, tz]);

  useEffect(() => {
    if (locationId === null) return;
    const controller = new AbortController();
    setCameras(null);
    apiGet<CamerasResponse>('/api/cameras', { locationId }, { signal: controller.signal })
      .then((res) => setCameras(res.cameras))
      .catch((err) => {
        if (!isAbort(err)) setCameras([]);
      });
    return () => controller.abort();
  }, [locationId, refresh]);

  // Days with footage in the month on show.
  useEffect(() => {
    if (locationId === null) return;
    const controller = new AbortController();
    setLoadingDays(true);
    apiGet<RecordingDaysResponse>(
      '/api/recordings/days',
      { locationId, cameraId: cameraId === ALL_CAMERAS ? undefined : cameraId, month },
      { signal: controller.signal },
    )
      .then((res) => setMarked(res.days.filter((d) => d.segmentCount > 0).map((d) => d.date)))
      .catch((err) => {
        if (!isAbort(err)) setMarked([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingDays(false);
      });
    return () => controller.abort();
  }, [locationId, cameraId, month, refresh]);

  const query = useMemo(() => {
    const range = day ? { from: new Date(zonedTime(day, fromHour * 60, tz)).toISOString(), to: new Date(zonedTime(day, toHour * 60, tz)).toISOString() } : {};
    return { locationId: locationId ?? undefined, cameraId: cameraId === ALL_CAMERAS ? undefined : cameraId, ...range, order, limit: LIST_PAGE };
  }, [locationId, cameraId, day, fromHour, toHour, tz, order]);

  // First page of the list.
  useEffect(() => {
    if (locationId === null) return;
    const controller = new AbortController();
    setItems(null);
    setCursor(null);
    setListError(null);
    apiGet<RecordingsPageResponse>('/api/recordings', query, { signal: controller.signal })
      .then((res) => {
        setItems(res.items);
        setCursor(res.nextCursor);
      })
      .catch((err) => {
        if (!isAbort(err)) setListError(err);
      });
    return () => controller.abort();
  }, [query, refresh]);

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const res = await apiGet<RecordingsPageResponse>('/api/recordings', { ...query, cursor });
      setItems((list) => [...(list ?? []), ...res.items]);
      setCursor(res.nextCursor);
    } catch (err) {
      toast.show({ message: describeError(err), tone: 'error' });
    } finally {
      setLoadingMore(false);
    }
  };

  const cameraOptions = useMemo<SelectOption<number>[]>(
    () => [{ value: ALL_CAMERAS, label: 'All cameras' }, ...(cameras ?? []).map((camera) => ({ value: camera.id, label: camera.name }))],
    [cameras],
  );
  const knownCameras = useMemo(() => new Set((cameras ?? []).map((camera) => camera.id)), [cameras]);

  const header = <PageHeader title="All footage" subtitle="Every recorded part. Tap one to watch it." />;

  if (locationsError && !locations) {
    return (
      <>
        {header}
        <EmptyState
          icon="warning"
          title="Locations did not load"
          message={describeError(locationsError)}
          action={
            <Button variant="primary" icon="refresh" onClick={reloadLocations}>
              Try again
            </Button>
          }
        />
      </>
    );
  }
  if (!locations) {
    return (
      <>
        {header}
        <Spinner size={32} label="Loading locations" />
      </>
    );
  }
  if (!location) {
    return (
      <>
        {header}
        <EmptyState icon="recordings" title="No locations yet" message="Footage shows here once a location has cameras." />
      </>
    );
  }

  const sortSwitch = (
    <SegmentedControl<Order>
      label="Sort"
      size="s"
      value={order}
      onChange={setOrder}
      options={[
        { value: 'desc', label: 'Newest first' },
        { value: 'asc', label: 'Oldest first' },
      ]}
    />
  );

  return (
    <>
      {header}

      <Section title="Filters" lead="Choose a camera, a day and a time.">
        <div class="rec-filters">
          <div class="stack">
            <FormField label="Camera">
              <Select<number> value={cameraId} options={cameraOptions} onChange={setCameraId} />
            </FormField>
            <div class="rec-range">
              <FormField label="From" hint={day ? undefined : 'Pick a day first'}>
                <Select<number>
                  value={fromHour}
                  options={FROM_OPTIONS}
                  disabled={!day}
                  onChange={(hour) => {
                    setFromHour(hour);
                    if (toHour <= hour) setToHour(hour + 1);
                  }}
                />
              </FormField>
              <FormField label="To">
                <Select<number>
                  value={toHour}
                  options={TO_OPTIONS}
                  disabled={!day}
                  onChange={(hour) => {
                    setToHour(hour);
                    if (fromHour >= hour) setFromHour(hour - 1);
                  }}
                />
              </FormField>
            </div>
            <div class="row wrap">
              <span class="k-body-s grow">{day ? dayLabel(day) : 'Any day'}</span>
              {day ? (
                <Button variant="ghost" icon="close" onClick={() => setDay(null)}>
                  Any day
                </Button>
              ) : null}
            </div>
            <p class="footnote">Times are in {location.name} time ({tz.replace(/_/g, ' ')}).</p>
          </div>
          <CalendarMonth
            month={month}
            selected={day}
            marked={marked}
            today={today}
            max={today}
            markedLabel="has footage"
            onSelect={(next) => setDay(next === day ? null : next)}
            onPrev={() => setMonth((m) => shiftMonth(m, -1))}
            onNext={() => setMonth((m) => shiftMonth(m, 1))}
            nextDisabled={month >= today.slice(0, 7)}
            loading={loadingDays}
          />
        </div>
      </Section>

      <Section title="Footage" lead="About 5 minutes per part. Tap one to open that moment." actions={sortSwitch}>
        {listError ? (
          <EmptyState
            icon="warning"
            title="Footage did not load"
            message={describeError(listError)}
            action={
              <Button variant="primary" icon="refresh" onClick={() => setRefresh((n) => n + 1)}>
                Try again
              </Button>
            }
          />
        ) : !items ? (
          <Spinner size={32} label="Loading footage" />
        ) : items.length === 0 ? (
          <EmptyState
            icon="recordings"
            title="No footage"
            message={day ? 'Nothing was recorded in this time. Try another day.' : 'Nothing has been recorded here yet.'}
          />
        ) : (
          <div class="stack">
            <GroupedList label="Footage">
              {items.map((item) => {
                const removed = cameras !== null && !knownCameras.has(item.cameraId);
                return (
                  <ListRow
                    key={item.id}
                    icon="play"
                    title={item.cameraName}
                    secondary={`${formatDate(item.start, tz)}, ${formatTime(item.start, tz)} to ${formatTime(item.end, tz)}${removed ? ', camera removed' : ''}`}
                    value={formatDuration(item.durationMs)}
                    disabled={removed}
                    linkTitle={removed ? 'This camera was removed' : `Watch ${item.cameraName} from ${formatTime(item.start, tz)}`}
                    href={momentPath(item)}
                  />
                );
              })}
            </GroupedList>
            {cursor ? (
              <div class="row">
                <Button onClick={() => void loadMore()} loading={loadingMore} loadingLabel="Loading...">
                  Load more
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </Section>
    </>
  );
}
