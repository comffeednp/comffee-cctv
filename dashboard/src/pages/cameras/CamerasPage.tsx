// Cameras of one location (owner only): each camera's settings, and "Detect cameras" to find new ones.
// Found Tapo cameras are added in one tap with the location's saved camera login (asked for once, inline,
// when the location has none). Other brands go through the add flow, where their video paths are typed.

import type { TargetedSubmitEvent } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type {
  AddDetectedRequest,
  AddDetectedResponse,
  CameraSummary,
  CamerasResponse,
  DetectResponse,
  DetectedDevice,
  LocationSummary,
  UpdateLocationRequest,
} from '../../../../shared/api-types.ts';
import {
  Badge,
  Button,
  EmptyState,
  FormField,
  GroupedList,
  IconButton,
  ListRow,
  PageHeader,
  PasswordInput,
  Section,
  Spinner,
  TextInput,
  useToast,
} from '../../components/index.ts';
import { useTopBar } from '../../app/Shell.tsx';
import { ApiFailure, apiGet, apiSend, describeError, isAbort } from '../../lib/api.ts';
import { Link, navigate, useRoute } from '../../lib/router.ts';
import { formatTime, plural } from '../../lib/format.ts';
import { isOwner, useMe } from '../../lib/session.ts';
import { LocationPicker, useLocationChoice, useLocations } from '../live/location-choice.tsx';
import { CameraCard } from './CameraCard.tsx';
import { TAPO_ACCOUNT_HINT, TAPO_ONVIF_PORT, canQuickAdd, deviceWords, failureWords } from './camera-text.ts';
import './cameras.css';

type DetectState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; result: DetectResponse; at: number }
  | { kind: 'error'; message: string };

/** What the owner asked to add: every found Tapo camera, or one device. */
type AddTarget = { kind: 'all' } | { kind: 'one'; device: DetectedDevice };

/** Result of the last one-tap add on this page. */
interface AddOutcome {
  /** Id of the first camera added, for "Watch cameras". Null when none was added. */
  firstAddedId: number | null;
  addedCount: number;
  failedCount: number;
}

/** The hub treats a found device with no video port as port 554 when it marks it as added. */
const DEFAULT_RTSP_PORT = 554;
/** How long the last detection stays on this page after leaving it. */
const DETECT_KEEP_MS = 60 * 60 * 1000;

// The hub allows only a few detection runs an hour, so the last result (and a run still going) is kept
// outside the page: adding a found camera and coming back keeps the list. Kept per signed-in person and
// location, in memory only (a reload starts empty).
const savedDetect = new Map<string, { result: DetectResponse; at: number }>();
const runningDetect = new Map<string, Promise<DetectResponse>>();

function detectKey(meId: number, locationId: number): string {
  return `${meId}:${locationId}`;
}

function savedDetectState(key: string): DetectState {
  const saved = savedDetect.get(key);
  if (!saved) return { kind: 'idle' };
  if (Date.now() - saved.at > DETECT_KEEP_MS) {
    savedDetect.delete(key);
    return { kind: 'idle' };
  }
  return { kind: 'done', result: saved.result, at: saved.at };
}

function idFromQuery(value: string | null): number | null {
  const id = value ? Number(value) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function deviceKey(ip: string, rtspPort: number | null): string {
  return `${ip}:${rtspPort ?? DEFAULT_RTSP_PORT}`;
}

export function CamerasPage() {
  const { me } = useMe();
  const toast = useToast();
  const { query } = useRoute();
  const { locations, error: locationsError, reload: reloadLocations, replace: replaceLocation } = useLocations();
  const [location, chooseLocation] = useLocationChoice(locations, idFromQuery(query.get('locationId')));
  const locationId = location?.id ?? null;
  const [cameras, setCameras] = useState<CameraSummary[] | null>(null);
  const [camerasError, setCamerasError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  const [detect, setDetect] = useState<DetectState>({ kind: 'idle' });
  const [detectRun, setDetectRun] = useState(0);
  const key = me && locationId !== null ? detectKey(me.id, locationId) : null;

  // One-tap adding: which add is running ('all' or a device IP), why each device was not added, and the
  // last outcome. All of it belongs to the location on screen and is cleared when the location changes.
  const [adding, setAdding] = useState<'all' | string | null>(null);
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState<AddOutcome | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  // Asked for once, inline, when the location has no saved camera login yet.
  const [askLogin, setAskLogin] = useState<AddTarget | null>(null);
  const [loginUser, setLoginUser] = useState('');
  const [loginPass, setLoginPass] = useState('');
  const [loginErrors, setLoginErrors] = useState<{ username?: string; password?: string; form?: string }>({});
  const [savingLogin, setSavingLogin] = useState(false);
  // The location on screen right now, so an add that finishes after a location switch is not applied.
  const shownLocation = useRef<number | null>(locationId);
  shownLocation.current = locationId;

  useTopBar(
    <LocationPicker locations={locations} location={location} onChange={chooseLocation} />,
    <IconButton icon="refresh" label="Reload cameras" onClick={() => setTick((n) => n + 1)} />,
    [locations, locationId],
  );

  useEffect(() => {
    if (locationId === null) return;
    const controller = new AbortController();
    setCamerasError(null);
    apiGet<CamerasResponse>('/api/cameras', { locationId }, { signal: controller.signal })
      .then((res) => setCameras(res.cameras))
      .catch((err) => {
        if (!isAbort(err)) setCamerasError(err);
      });
    return () => controller.abort();
  }, [locationId, tick]);

  useEffect(() => {
    setCameras(null);
    setFailed({});
    setOutcome(null);
    setAddError(null);
    setAskLogin(null);
    setLoginUser('');
    setLoginPass('');
    setLoginErrors({});
  }, [locationId]);

  // Shows the kept result for this location, or follows a run that is still going (also one started
  // before the page was left and opened again).
  useEffect(() => {
    if (key === null) {
      setDetect({ kind: 'idle' });
      return;
    }
    const pending = runningDetect.get(key);
    if (!pending) {
      setDetect(savedDetectState(key));
      return;
    }
    const placeName = location?.name ?? 'this location';
    let live = true;
    setDetect({ kind: 'running' });
    pending.then(
      () => {
        if (live) setDetect(savedDetectState(key));
      },
      (err: unknown) => {
        if (!live) return;
        setDetect({
          kind: 'error',
          message: describeError(err, {
            conflict: 'A search is already running for this location. Wait for it to finish.',
            unavailable: `The hub cannot reach the network at ${placeName}. Check that its router tunnel or bridge is connected.`,
          }),
        });
      },
    );
    return () => {
      live = false;
    };
  }, [key, detectRun]);

  const header = (
    <PageHeader
      title="Cameras"
      subtitle="Find, add and set up the cameras at this location."
      actions={
        location && isOwner(me) ? (
          <Button icon="plus" href={`/cameras/add?locationId=${location.id}`}>
            Add camera
          </Button>
        ) : undefined
      }
    />
  );

  if (!isOwner(me)) {
    return (
      <>
        <PageHeader title="Cameras" subtitle="Only the owner manages cameras." />
        <EmptyState icon="shield" title="Owner only" message="Ask the owner to change cameras." />
      </>
    );
  }
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
        <EmptyState
          icon="locations"
          title="No locations yet"
          message="Add a location first, then its cameras."
          action={
            <Button variant="primary" icon="plus" href="/locations/new">
              Add location
            </Button>
          }
        />
      </>
    );
  }

  const runDetect = () => {
    if (key === null || runningDetect.has(key)) return;
    const runKey = key;
    setFailed({});
    setOutcome(null);
    setAddError(null);
    setAskLogin(null);
    const pending = apiSend<DetectResponse>('POST', `/api/locations/${location.id}/detect`, {})
      .then((result) => {
        savedDetect.set(runKey, { result, at: Date.now() });
        return result;
      })
      .finally(() => runningDetect.delete(runKey));
    // The page may be closed before the run ends; the error is shown by the effect when it is open.
    pending.catch(() => undefined);
    runningDetect.set(runKey, pending);
    setDetectRun((n) => n + 1);
  };

  // The camera list is the truth for "Added" once it has loaded, so a kept result stays correct after
  // cameras are added or removed.
  const addedKeys = cameras ? new Set(cameras.map((camera) => deviceKey(camera.lanIp, camera.rtspPort))) : null;
  const isAdded = (device: DetectedDevice) => (addedKeys ? addedKeys.has(deviceKey(device.ip, device.rtspPort)) : device.alreadyAdded);

  const devices = detect.kind === 'done' ? detect.result.devices : [];
  const quickList = devices.filter((device) => canQuickAdd(device) && !isAdded(device));
  const otherCount = devices.filter((device) => !canQuickAdd(device) && !isAdded(device)).length;

  const addHref = (device: DetectedDevice) => {
    const params = new URLSearchParams({ locationId: String(location.id), ip: device.ip });
    if (device.guessVendor) params.set('vendor', device.guessVendor);
    if (device.rtspPort) params.set('rtspPort', String(device.rtspPort));
    if (device.onvifPort) params.set('onvifPort', String(device.onvifPort));
    else if (device.guessVendor === 'tapo') params.set('onvifPort', String(TAPO_ONVIF_PORT));
    return `/cameras/add?${params.toString()}`;
  };

  const watch = (cameraId: number) => {
    // Live opens on the remembered location, so remember this one before going there.
    chooseLocation(location.id);
    navigate(`/live?camera=${cameraId}`);
  };

  /** POST /api/locations/:id/cameras/add-detected with the saved login; goes to Live when all worked. */
  const quickAdd = async (target: AddTarget, placeId: number) => {
    const list = target.kind === 'all' ? quickList : [target.device];
    if (list.length === 0) return;
    setAdding(target.kind === 'all' ? 'all' : target.device.ip);
    setAddError(null);
    try {
      const body: AddDetectedRequest = {
        devices: list.map((device) => ({ ip: device.ip, rtspPort: device.rtspPort, onvifPort: device.onvifPort, vendor: device.guessVendor })),
      };
      const res = await apiSend<AddDetectedResponse>('POST', `/api/locations/${placeId}/cameras/add-detected`, body);
      if (shownLocation.current !== placeId) return;
      if (res.added.length > 0) {
        setCameras((current) => (current ? [...current, ...res.added.filter((cam) => !current.some((item) => item.id === cam.id))] : current));
      }
      setFailed((current) => {
        const next = { ...current };
        for (const device of list) delete next[device.ip];
        for (const item of res.failed) next[item.ip] = failureWords(item.error);
        return next;
      });
      if (res.added.length > 0 && res.failed.length === 0) {
        toast.show({ message: res.added.length === 1 ? 'Camera added.' : `${plural(res.added.length, 'camera')} added.`, tone: 'success' });
        watch(res.added[0].id);
        return;
      }
      if (res.added.length === 0 && res.failed.length === 0) {
        // Nothing new: they were added already (for example from another device). Show the real list.
        toast.show({ message: 'These cameras are already added.', tone: 'info' });
        setTick((n) => n + 1);
        return;
      }
      if (target.kind === 'one') {
        // One camera that did not work: its row shows the reason and offers the step-by-step add.
        const reason = res.failed[0] ? failureWords(res.failed[0].error) : 'No video came back.';
        toast.show({ message: `${target.device.ip} was not added. ${reason}`, tone: 'error' });
        return;
      }
      setOutcome({ firstAddedId: res.added[0]?.id ?? null, addedCount: res.added.length, failedCount: res.failed.length });
      if (res.added.length > 0) {
        toast.show({ message: `${plural(res.added.length, 'camera')} added. ${res.failed.length} did not work.`, tone: 'info' });
      }
    } catch (err) {
      if (shownLocation.current !== placeId) return;
      // A conflict is worded by the hub: either an add is already running here, or the saved login cannot
      // be opened any more (for example after a reinstall). Both sentences say what to do, so they show as is.
      setAddError(
        describeError(err, {
          unavailable: `The hub cannot reach ${location.name} right now. Check its router tunnel or bridge.`,
        }),
      );
      if (err instanceof ApiFailure && err.code === 'conflict' && /cannot be read/i.test(err.message)) {
        // Ask for the login again right here, so saving it and adding is one step.
        setLoginErrors({});
        setLoginUser((current) => current || location.cameraUsername || '');
        setAskLogin(target);
      }
      setTick((n) => n + 1);
      // The saved login may have been removed meanwhile: load the location again so the page asks for it.
      reloadLocations();
    } finally {
      setAdding(null);
    }
  };

  const startAdd = (target: AddTarget) => {
    if (adding !== null) return;
    if (!location.hasCameraLogin) {
      setLoginErrors({});
      setAskLogin(target);
      return;
    }
    void quickAdd(target, location.id);
  };

  const saveLoginAndAdd = async (event: TargetedSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!askLogin) return;
    const errors: typeof loginErrors = {};
    if (!loginUser.trim()) errors.username = 'Type the camera username.';
    if (!loginPass) errors.password = 'Type the camera password.';
    setLoginErrors(errors);
    if (Object.keys(errors).length) return;
    const placeId = location.id;
    const target = askLogin;
    setSavingLogin(true);
    try {
      const body: UpdateLocationRequest = { cameraUsername: loginUser.trim(), cameraPassword: loginPass };
      const next = await apiSend<LocationSummary>('PATCH', `/api/locations/${placeId}`, body);
      if (shownLocation.current !== placeId) return;
      replaceLocation(next);
      setLoginPass('');
      setAskLogin(null);
      await quickAdd(target, placeId);
    } catch (err) {
      setLoginErrors({ form: describeError(err) });
    } finally {
      setSavingLogin(false);
    }
  };

  const showWatch = outcome !== null && outcome.firstAddedId !== null;
  const showAddAll = quickList.length > 0 && askLogin === null;
  const detectPrimary = !showWatch && !showAddAll && askLogin === null;

  const detectSection = (
    <Section
      title="Detect cameras"
      lead="Look for cameras on this location's network."
      actions={
        <Button
          variant={detectPrimary ? 'primary' : 'secondary'}
          icon="detect"
          loading={detect.kind === 'running'}
          loadingLabel="Looking..."
          disabled={adding !== null || savingLogin}
          onClick={runDetect}
        >
          Detect cameras
        </Button>
      }
    >
      {detect.kind === 'idle' ? (
        <p class="k-body-s">
          {location.online ? 'Finds cameras that answer on the video or ONVIF ports.' : `${location.name} is offline, so a search will not reach its cameras.`}
        </p>
      ) : null}
      {detect.kind === 'running' ? (
        <div class="row">
          <Spinner size={20} decorative />
          <span class="k-body-s" role="status">
            Looking for cameras. This can take up to a minute.
          </span>
        </div>
      ) : null}
      {detect.kind === 'error' ? (
        <p class="k-body-s text-error" role="alert">
          {detect.message}
        </p>
      ) : null}
      {detect.kind === 'done' ? (
        devices.length === 0 ? (
          <EmptyState icon="detect" title="No cameras found" message="Check that the cameras are on and on the same network as the router or bridge." />
        ) : (
          <div class="stack">
            {outcome ? (
              <div class="stack-8" role="status">
                <p class="k-body">
                  {outcome.addedCount > 0
                    ? `${plural(outcome.addedCount, 'camera')} added. ${plural(outcome.failedCount, 'camera')} did not work: the reason is on each one below.`
                    : `${plural(outcome.failedCount, 'camera')} did not work: the reason is on each one below.`}
                </p>
                {location.hasCameraLogin ? (
                  <p class="k-body-s">
                    Wrong login? Change it on the <Link href={`/locations/${location.id}`}>location page</Link>, then try again.
                  </p>
                ) : null}
              </div>
            ) : null}

            {addError ? (
              <p class="k-body-s text-error" role="alert">
                {addError}
              </p>
            ) : null}

            {askLogin ? (
              <Section
                level={3}
                title="Camera login"
                lead={
                  location.hasCameraLogin
                    ? 'Type the login again. It replaces the saved one for every camera here.'
                    : askLogin.kind === 'one'
                      ? `Needed to add ${askLogin.device.ip}. Saved for every camera here.`
                      : 'Typed once, then saved for every camera here.'
                }
              >
                <form class="stack" onSubmit={(event) => void saveLoginAndAdd(event)} noValidate>
                  <p class="k-body-s">{TAPO_ACCOUNT_HINT}</p>
                  <FormField label="Camera username" error={loginErrors.username} required>
                    <TextInput value={loginUser} onInput={setLoginUser} autoComplete="off" autoCapitalize="none" spellcheck={false} maxLength={128} autoFocus />
                  </FormField>
                  <FormField label="Camera password" hint="Kept encrypted on the hub. It is never shown again." error={loginErrors.password} required>
                    <PasswordInput value={loginPass} onInput={setLoginPass} autoComplete="new-password" maxLength={128} />
                  </FormField>
                  {loginErrors.form ? (
                    <p class="k-body-s text-error" role="alert">
                      {loginErrors.form}
                    </p>
                  ) : null}
                  <div class="cam-step-actions">
                    <Button variant="ghost" onClick={() => setAskLogin(null)} disabled={savingLogin || adding !== null}>
                      Cancel
                    </Button>
                    <Button variant="primary" type="submit" icon="plus" loading={savingLogin || adding !== null} loadingLabel="Adding...">
                      {askLogin.kind === 'one' ? 'Save and add' : 'Save and add all'}
                    </Button>
                  </div>
                </form>
              </Section>
            ) : null}

            {showWatch || showAddAll ? (
              <div class="stack-8">
                <div class="cam-actions">
                  {showWatch && outcome?.firstAddedId ? (
                    <Button variant="primary" icon="live" onClick={() => watch(outcome.firstAddedId as number)}>
                      Watch cameras
                    </Button>
                  ) : null}
                  {showAddAll ? (
                    <Button
                      variant={showWatch ? 'secondary' : 'primary'}
                      icon="plus"
                      loading={adding === 'all'}
                      loadingLabel="Adding..."
                      disabled={adding !== null}
                      onClick={() => startAdd({ kind: 'all' })}
                    >
                      {outcome ? (showWatch ? 'Try the rest again' : 'Try again') : quickList.length === 1 ? 'Add found camera' : 'Add all found cameras'}
                    </Button>
                  ) : null}
                </div>
                {showAddAll ? (
                  <p class="k-body-s">
                    {location.hasCameraLogin
                      ? `Uses the camera login saved for ${location.name}.`
                      : 'You type the camera login once. It is saved for this location.'}
                  </p>
                ) : null}
              </div>
            ) : null}

            <GroupedList label="Cameras found">
              {devices.map((device) => {
                const added = isAdded(device);
                const reason = added ? undefined : failed[device.ip];
                const quick = canQuickAdd(device);
                let trailing;
                if (added) trailing = <Badge tone="ok">Added</Badge>;
                else if (reason || !quick) {
                  trailing = (
                    <Button icon="plus" disabled={adding !== null} onClick={() => navigate(addHref(device))}>
                      {reason ? 'Add by hand' : 'Add'}
                    </Button>
                  );
                } else {
                  trailing = (
                    <Button
                      icon="plus"
                      loading={adding === device.ip}
                      loadingLabel="Adding..."
                      disabled={adding !== null}
                      onClick={() => startAdd({ kind: 'one', device })}
                    >
                      Add
                    </Button>
                  );
                }
                return (
                  <ListRow
                    key={deviceKey(device.ip, device.rtspPort)}
                    icon="cameras"
                    title={device.ip}
                    secondary={reason ? `Not added: ${reason}` : deviceWords(device)}
                    trailing={trailing}
                  />
                );
              })}
            </GroupedList>
            <p class="footnote">
              {otherCount > 0 ? 'Other brands need their video address, so Add opens a few short steps. ' : ''}
              Searched at {formatTime(detect.at)}: checked {plural(detect.result.scanned, 'address', 'addresses')} in{' '}
              {Math.max(1, Math.round(detect.result.tookMs / 1000))} s.
            </p>
          </div>
        )
      ) : null}
    </Section>
  );

  const camerasSection = (
    <Section title="Cameras" lead={cameras ? `${plural(cameras.length, 'camera')} at ${location.name}.` : `Cameras at ${location.name}.`}>
      {camerasError && !cameras ? (
        <EmptyState
          icon="warning"
          title="Cameras did not load"
          message={describeError(camerasError)}
          action={
            <Button icon="refresh" onClick={() => setTick((n) => n + 1)}>
              Try again
            </Button>
          }
        />
      ) : !cameras ? (
        <Spinner size={32} label="Loading cameras" />
      ) : cameras.length === 0 ? (
        <EmptyState icon="cameras" title="No cameras yet" message="Detect the cameras on this network above, or add one by its address." />
      ) : (
        <div class="grid-2">
          {cameras.map((camera) => (
            <CameraCard
              key={camera.id}
              camera={camera}
              locationPaused={location.recordingPaused}
              onChanged={(next) => setCameras((list) => (list ? list.map((item) => (item.id === next.id ? next : item)) : list))}
              onRemoved={(id) => setCameras((list) => (list ? list.filter((item) => item.id !== id) : list))}
            />
          ))}
        </div>
      )}
    </Section>
  );

  // A location without cameras is being set up, so finding them comes first.
  const settingUp = cameras !== null && cameras.length === 0;

  return (
    <>
      {header}
      {settingUp ? (
        <>
          {detectSection}
          {camerasSection}
        </>
      ) : (
        <>
          {camerasSection}
          {detectSection}
        </>
      )}
    </>
  );
}
