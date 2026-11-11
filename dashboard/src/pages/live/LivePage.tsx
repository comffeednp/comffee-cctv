// The camera workspace (/live). Left (a sheet on phones): the cameras of the chosen location. Main: either every
// camera as a live grid, or one camera big, live at once, with its past footage one tap away.
//
// The address keeps the choice: /live?camera=<id> (one camera), &view=playback (its footage), and
// &at=<ISO time> opens that moment (the "All footage" list links here).

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { CameraSummary, CamerasResponse, LocationSummary, VaultKeysResponse } from '../../../../shared/api-types.ts';
import { Button, EmptyState, GroupedList, IconButton, ListRow, PageHeader, Section, Spinner, StatusDot, Toggle, useToast } from '../../components/index.ts';
import { useTopBar } from '../../app/Shell.tsx';
import { apiGet, apiSend, describeError, isAbort } from '../../lib/api.ts';
import { plural } from '../../lib/format.ts';
import { navigate, useRoute } from '../../lib/router.ts';
import { isOwner, useMe } from '../../lib/session.ts';
import { renameCamera } from './camera-status.ts';
import { CameraList } from './CameraList.tsx';
import { CameraTile } from './CameraTile.tsx';
import { CameraView } from './CameraView.tsx';
import type { CameraMode } from './CameraView.tsx';
import { useLocationChoice, useLocations } from './location-choice.tsx';
import { UPLOAD_RATE_NOTE, formatMbps, recordingUploadMbps } from './upload.ts';
import './live.css';

const REFRESH_MS = 30_000;

interface Address {
  camera: number | null;
  view: CameraMode;
  at: string | null;
}

function readAddress(query: URLSearchParams): Address {
  const raw = Number(query.get('camera'));
  const camera = Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  const at = query.get('at');
  const atValid = at !== null && Number.isFinite(Date.parse(at)) ? at : null;
  const view: CameraMode = query.get('view') === 'playback' || atValid ? 'playback' : 'live';
  return { camera, view, at: camera ? atValid : null };
}

function addressPath(next: Address): string {
  const params = new URLSearchParams();
  if (next.camera) {
    params.set('camera', String(next.camera));
    if (next.view === 'playback') params.set('view', 'playback');
    if (next.at) params.set('at', next.at);
  }
  const text = params.toString();
  return text ? `/live?${text}` : '/live';
}

export function LivePage() {
  const { me } = useMe();
  const owner = isOwner(me);
  const toast = useToast();
  const { query } = useRoute();
  const address = readAddress(query);
  const { locations, error: locationsError, reload: reloadLocations, replace: replaceLocation } = useLocations();
  const [location, chooseLocation] = useLocationChoice(locations);
  const [allCameras, setAllCameras] = useState<CameraSummary[] | null>(null);
  const [camerasError, setCamerasError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  const [noVaultKey, setNoVaultKey] = useState(false);
  const [pausing, setPausing] = useState(false);
  const locationId = location?.id ?? null;

  useTopBar(
    location ? <span class="truncate">{location.name}</span> : null,
    <IconButton icon="refresh" label="Reload cameras" onClick={() => setTick((n) => n + 1)} />,
    [location?.name],
  );

  // Every camera this person may see, refreshed every 30 s for their online and recording state.
  useEffect(() => {
    const controller = new AbortController();
    apiGet<CamerasResponse>('/api/cameras', undefined, { signal: controller.signal })
      .then((res) => {
        setAllCameras(res.cameras);
        setCamerasError(null);
      })
      .catch((err) => {
        if (!isAbort(err)) setCamerasError(err);
      });
    const timer = setTimeout(() => setTick((n) => n + 1), REFRESH_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [tick]);

  // The owner is told when recording cannot start because no recovery key exists yet.
  useEffect(() => {
    if (!owner) return;
    const controller = new AbortController();
    apiGet<VaultKeysResponse>('/api/keys/vault', undefined, { signal: controller.signal })
      .then((res) => setNoVaultKey(!res.activeKeyId))
      .catch(() => undefined);
    return () => controller.abort();
  }, [owner]);

  const linked = address.camera !== null && allCameras ? (allCameras.find((camera) => camera.id === address.camera) ?? null) : null;

  // A link to a camera of another location switches to that location.
  useEffect(() => {
    if (linked && locationId !== null && linked.locationId !== locationId) chooseLocation(linked.locationId);
  }, [linked?.id, linked?.locationId, locationId]);

  // A camera that is gone (removed, or no longer shared) falls back to all cameras.
  useEffect(() => {
    if (address.camera !== null && allCameras && !linked) navigate('/live', { replace: true });
  }, [address.camera, allCameras, linked]);

  // Each new "at" in the address opens that moment again.
  const startNonce = useRef(0);
  const startAt = useMemo(() => {
    if (!address.at) return null;
    startNonce.current += 1;
    return { time: Date.parse(address.at), nonce: startNonce.current };
  }, [address.at]);

  const cameras = useMemo(
    () => (allCameras && locationId !== null ? allCameras.filter((camera) => camera.locationId === locationId) : null),
    [allCameras, locationId],
  );
  const selected = linked && linked.locationId === locationId ? linked : null;

  const showError = (message: string) => toast.show({ message, tone: 'error' });

  const replaceCamera = (next: CameraSummary) => {
    setAllCameras((list) => (list ? list.map((item) => (item.id === next.id ? next : item)) : list));
  };

  const onRename = async (camera: CameraSummary, name: string) => {
    replaceCamera(await renameCamera(camera, name));
    toast.show({ message: 'Camera renamed.', tone: 'success' });
  };

  const selectCamera = (cameraId: number | null) => {
    if (cameraId === address.camera) return;
    navigate(addressPath({ camera: cameraId, view: 'live', at: null }));
  };

  const setMode = (view: CameraMode) => {
    navigate(addressPath({ camera: address.camera, view, at: null }), { replace: true });
  };

  const setPaused = async (target: LocationSummary, recordingPaused: boolean) => {
    setPausing(true);
    try {
      replaceLocation(await apiSend<LocationSummary>('PATCH', `/api/locations/${target.id}`, { recordingPaused }));
      toast.show({ message: recordingPaused ? 'Recording paused.' : 'Recording resumed.', tone: 'success' });
      setTick((n) => n + 1);
    } catch (err) {
      showError(describeError(err));
    } finally {
      setPausing(false);
    }
  };

  const plainHeader = <PageHeader title="Live" subtitle="Watch your cameras and look back at what they saved." />;

  if (locationsError && !locations) {
    return (
      <>
        {plainHeader}
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
        {plainHeader}
        <Spinner size={32} label="Loading locations" />
      </>
    );
  }
  if (!location) {
    return (
      <>
        {plainHeader}
        <EmptyState
          icon="locations"
          title="No locations yet"
          message={owner ? 'Add a location to connect its cameras.' : 'Ask the owner to give you access to a location.'}
          action={
            owner ? (
              <Button variant="primary" icon="plus" href="/locations/new">
                Add location
              </Button>
            ) : undefined
          }
        />
      </>
    );
  }

  const uploadMbps = cameras ? recordingUploadMbps(cameras) : 0;
  const recordingCount = cameras ? cameras.filter((camera) => camera.recording).length : 0;

  const allView = (
    <>
      <PageHeader
        title="All cameras"
        subtitle={location.online ? `Every camera at ${location.name}, live.` : `${location.name} is offline right now.`}
        status={<StatusDot status={location.online ? 'online' : 'offline'} />}
      />
      <Section title="Live view" lead="Tap a camera to watch it big and see its past footage.">
        {camerasError && !cameras ? (
          <EmptyState
            icon="warning"
            title="Cameras did not load"
            message={describeError(camerasError)}
            action={
              <Button variant="primary" icon="refresh" onClick={() => setTick((n) => n + 1)}>
                Try again
              </Button>
            }
          />
        ) : !cameras ? (
          <Spinner size={32} label="Loading cameras" />
        ) : cameras.length === 0 ? (
          <EmptyState
            icon="cameras"
            title="No cameras yet"
            message={owner ? 'Add a camera to start watching and recording.' : 'The owner has not added cameras here yet.'}
            action={
              owner ? (
                <Button variant="primary" icon="plus" href={`/cameras/add?locationId=${location.id}`}>
                  Add camera
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div class="grid-tiles">
            {cameras.map((camera) => (
              <CameraTile
                key={camera.id}
                camera={camera}
                location={location}
                owner={owner}
                noVaultKey={noVaultKey}
                onChanged={replaceCamera}
                onError={showError}
                onOpen={() => selectCamera(camera.id)}
              />
            ))}
          </div>
        )}
      </Section>
      {owner ? (
        <Section title="Recording" lead="Pausing stops uploads from this location, which saves internet.">
          <div class="stack-8">
            <GroupedList label="Recording">
              {noVaultKey ? (
                <ListRow
                  icon="key"
                  tone="amber"
                  title="Set up the recovery key"
                  secondary="Nothing records until it exists"
                  href="/settings/recovery-key"
                />
              ) : null}
              <Toggle
                inList
                label="Pause recording"
                description={
                  location.recordingPaused
                    ? 'Paused: no recording uploads. Watching live still uses internet.'
                    : `Uploads about ${formatMbps(uploadMbps)} for ${plural(recordingCount, 'recording camera')}`
                }
                checked={location.recordingPaused}
                busy={pausing}
                onChange={(next) => void setPaused(location, next)}
              />
            </GroupedList>
            <p class="footnote">{UPLOAD_RATE_NOTE}</p>
          </div>
        </Section>
      ) : null}
    </>
  );

  return (
    <div class="cam-workspace">
      <CameraList
        locations={locations}
        location={location}
        onLocation={(id) => {
          chooseLocation(id);
          if (address.camera !== null) navigate('/live', { replace: true });
        }}
        cameras={cameras}
        error={camerasError && !cameras ? describeError(camerasError) : null}
        onRetry={() => setTick((n) => n + 1)}
        selectedId={selected?.id ?? null}
        onSelect={selectCamera}
        owner={owner}
        onRename={onRename}
      />
      <div class="cam-main">
        {selected ? (
          <CameraView
            key={selected.id}
            camera={selected}
            location={location}
            owner={owner}
            noVaultKey={noVaultKey}
            mode={address.view}
            onMode={setMode}
            startAt={startAt}
            onChanged={replaceCamera}
            onRename={onRename}
            onError={showError}
          />
        ) : address.camera !== null && !allCameras && !camerasError ? (
          <>
            {plainHeader}
            <Spinner size={32} label="Loading camera" />
          </>
        ) : (
          allView
        )}
      </div>
    </div>
  );
}
