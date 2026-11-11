// Add a camera, one step per screen: type, address, name, camera account, quality, then test and save.
// Opened from "Detect cameras" with the address filled in, or from "Add camera" with nothing filled in.

import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { CameraSummary, CameraTestRequest, CameraTestResponse, CreateCameraRequest, Quality, Vendor } from '../../../../shared/api-types.ts';
import {
  Button,
  EmptyState,
  FormField,
  Icon,
  GroupedList,
  ListRow,
  PageHeader,
  PasswordInput,
  Section,
  SegmentedControl,
  Spinner,
  TextInput,
  Toggle,
  useToast,
} from '../../components/index.ts';
import { useTopBar } from '../../app/Shell.tsx';
import { apiSend, describeError } from '../../lib/api.ts';
import { navigate, useRoute } from '../../lib/router.ts';
import { isOwner, useMe } from '../../lib/session.ts';
import { LocationPicker, useLocationChoice, useLocations } from '../live/location-choice.tsx';
import {
  OTHER_ACCOUNT_HINT,
  QUALITY_HINTS,
  TAPO_ACCOUNT_HINT,
  TAPO_ONVIF_PORT,
  TAPO_RTSP_PORT,
  VENDORS,
  ipProblem,
  nameProblem,
  pathProblem,
  portProblem,
  streamSummary,
  vendorLabel,
} from './camera-text.ts';
import './cameras.css';

type Step = 'type' | 'address' | 'name' | 'account' | 'quality' | 'check';
const STEPS: readonly Step[] = ['type', 'address', 'name', 'account', 'quality', 'check'];

type Errors = Partial<Record<'lanIp' | 'rtspPort' | 'onvifPort' | 'mainPath' | 'subPath' | 'name' | 'username' | 'password', string>>;

function numberFrom(value: string | null): number | null {
  const n = value ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function vendorFrom(value: string | null): Vendor {
  return value === 'onvif' || value === 'custom' ? value : 'tapo';
}

export function AddCameraPage() {
  const { me } = useMe();
  const toast = useToast();
  const { query } = useRoute();
  const { locations, error: locationsError, reload: reloadLocations } = useLocations();
  const [location, chooseLocation] = useLocationChoice(locations, numberFrom(query.get('locationId')));

  const [step, setStep] = useState<Step>('type');
  const [vendor, setVendor] = useState<Vendor>(() => vendorFrom(query.get('vendor')));
  const [lanIp, setLanIp] = useState(() => query.get('ip') ?? '');
  const [rtspPort, setRtspPort] = useState(() => String(numberFrom(query.get('rtspPort')) ?? TAPO_RTSP_PORT));
  const [onvifPort, setOnvifPort] = useState(() => String(numberFrom(query.get('onvifPort')) ?? ''));
  const [mainPath, setMainPath] = useState('');
  const [subPath, setSubPath] = useState('');
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // null = not chosen yet: use the location's saved camera login when it has one.
  const [loginChoice, setLoginChoice] = useState<'saved' | 'other' | null>(null);
  const [quality, setQuality] = useState<Quality>('720p');
  const [recording, setRecording] = useState(true);
  const [errors, setErrors] = useState<Errors>({});
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<CameraTestResponse | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useTopBar(<LocationPicker locations={locations} location={location} onChange={chooseLocation} />, null, [locations, location?.id]);

  const custom = vendor !== 'tapo';
  const index = STEPS.indexOf(step);
  const lead = (what: string) => `Step ${index + 1} of ${STEPS.length}. ${what}`;

  if (!isOwner(me)) {
    return (
      <>
        <PageHeader title="Add camera" subtitle="Only the owner adds cameras." />
        <EmptyState icon="shield" title="Owner only" message="Ask the owner to add cameras." />
      </>
    );
  }
  if (locationsError && !locations) {
    return (
      <>
        <PageHeader back={{ href: '/cameras', label: 'Cameras' }} title="Add camera" subtitle="Connect a camera to this location." />
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
  if (!locations) return <Spinner size={32} label="Loading" />;
  if (!location) {
    return (
      <>
        <PageHeader back={{ href: '/cameras', label: 'Cameras' }} title="Add camera" subtitle="Connect a camera to a location." />
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

  // The saved login is used unless the owner picks another one; the hub fills it in when both are left out.
  const useSaved = location.hasCameraLogin && (loginChoice ?? 'saved') === 'saved';
  const login = useSaved ? {} : { username: username.trim(), password };

  const connection = (): CameraTestRequest => {
    const port = Number(rtspPort.trim()) || TAPO_RTSP_PORT;
    const onvif = onvifPort.trim() ? Number(onvifPort.trim()) : null;
    if (vendor === 'tapo') {
      return { locationId: location.id, lanIp: lanIp.trim(), rtspPort: TAPO_RTSP_PORT, onvifPort: onvif ?? TAPO_ONVIF_PORT, vendor, ...login };
    }
    return {
      locationId: location.id,
      lanIp: lanIp.trim(),
      rtspPort: port,
      onvifPort: vendor === 'onvif' ? onvif : null,
      vendor,
      mainPath: mainPath.trim(),
      subPath: subPath.trim() || null,
      ...login,
    };
  };

  const check = (which: Step): Errors => {
    const found: Errors = {};
    if (which === 'address') {
      found.lanIp = ipProblem(lanIp) ?? undefined;
      if (custom) {
        found.rtspPort = portProblem(rtspPort, false) ?? undefined;
        found.mainPath = pathProblem(mainPath, false) ?? undefined;
        found.subPath = pathProblem(subPath, true) ?? undefined;
      }
      if (vendor === 'onvif') found.onvifPort = portProblem(onvifPort, true) ?? undefined;
    }
    if (which === 'name') found.name = nameProblem(name) ?? undefined;
    if (which === 'account' && !useSaved) {
      if (!username.trim()) found.username = 'Type the camera account user name.';
      if (!password) found.password = 'Type the camera account password.';
    }
    return found;
  };

  const goTo = (next: Step) => {
    setErrors({});
    setStep(next);
    window.scrollTo(0, 0);
  };

  const next = (event: Event) => {
    event.preventDefault();
    const found = check(step);
    setErrors(found);
    if (Object.values(found).some(Boolean)) return;
    // Anything that changes the connection makes an earlier test result stale.
    if (step === 'address' || step === 'account' || step === 'type') {
      setTestResult(null);
      setTestError(null);
    }
    goTo(STEPS[Math.min(index + 1, STEPS.length - 1)]);
  };

  const back = () => (index === 0 ? navigate(`/cameras?locationId=${location.id}`) : goTo(STEPS[index - 1]));

  const test = async () => {
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    try {
      setTestResult(await apiSend<CameraTestResponse>('POST', '/api/cameras/test', connection()));
    } catch (err) {
      setTestError(describeError(err, { unavailable: `The hub cannot reach ${location.name} right now. Check its router tunnel or bridge.` }));
    } finally {
      setTesting(false);
    }
  };

  const save = async (event: Event) => {
    event.preventDefault();
    setSaving(true);
    setSaveError(null);
    const body: CreateCameraRequest = { ...connection(), name: name.trim(), quality, recording };
    try {
      const camera = await apiSend<CameraSummary>('POST', '/api/cameras', body);
      toast.show({ message: 'Camera added.', tone: 'success' });
      // Live opens on the remembered location, so remember this one, then show the new camera.
      chooseLocation(location.id);
      navigate(`/live?camera=${camera.id}`);
    } catch (err) {
      setSaveError(describeError(err, { conflict: 'This camera is already added at this location.' }));
    } finally {
      setSaving(false);
    }
  };

  const stepActions = (primary: ComponentChildren) => (
    <div class="cam-step-actions">
      <Button variant="ghost" icon="arrow-left" onClick={back}>
        Back
      </Button>
      {primary}
    </div>
  );

  const nextButton = stepActions(
    <Button variant="primary" size="l" type="submit">
      Next
    </Button>,
  );

  let body: ComponentChildren = null;
  if (step === 'type') {
    body = (
      <Section title="Camera type" lead={lead('Pick the kind of camera.')}>
        <form class="stack-24" onSubmit={next}>
          <GroupedList label="Camera type">
            {VENDORS.map((item) => (
              <ListRow
                key={item.value}
                icon="cameras"
                title={item.label}
                secondary={item.detail}
                selected={vendor === item.value}
                chevron={false}
                trailing={vendor === item.value ? <span class="text-amber"><Icon name="check" label="Chosen" /></span> : undefined}
                onClick={() => setVendor(item.value)}
              />
            ))}
          </GroupedList>
          {nextButton}
        </form>
      </Section>
    );
  } else if (step === 'address') {
    body = (
      <Section title="Camera address" lead={lead('Where the camera is on the network.')}>
        <form class="stack" onSubmit={next} noValidate>
          <FormField label="Camera address" hint="The camera's local IP address, like 192.168.1.20." error={errors.lanIp} required>
            <TextInput value={lanIp} onInput={setLanIp} mono inputMode="decimal" autoComplete="off" spellcheck={false} autoFocus />
          </FormField>
          {custom ? (
            <>
              <FormField label="Video port" hint="The RTSP port. Most cameras use 554." error={errors.rtspPort} required>
                <TextInput value={rtspPort} onInput={setRtspPort} mono inputMode="numeric" autoComplete="off" />
              </FormField>
              <FormField label="Main stream path" hint="The part after the address in the camera's RTSP link." error={errors.mainPath} required>
                <TextInput value={mainPath} onInput={setMainPath} mono autoComplete="off" spellcheck={false} autoCapitalize="off" />
              </FormField>
              <FormField label="Sub stream path" optional hint="A smaller second stream, if the camera has one." error={errors.subPath}>
                <TextInput value={subPath} onInput={setSubPath} mono autoComplete="off" spellcheck={false} autoCapitalize="off" />
              </FormField>
              {vendor === 'onvif' ? (
                <FormField label="ONVIF port" optional hint="Used to read the camera's make and model." error={errors.onvifPort}>
                  <TextInput value={onvifPort} onInput={setOnvifPort} mono inputMode="numeric" autoComplete="off" />
                </FormField>
              ) : null}
            </>
          ) : (
            <p class="k-body-s">Tapo cameras use video port 554 and ONVIF port 2020, so nothing else is needed.</p>
          )}
          {nextButton}
        </form>
      </Section>
    );
  } else if (step === 'name') {
    body = (
      <Section title="Camera name" lead={lead('A name everyone will recognise.')}>
        <form class="stack" onSubmit={next} noValidate>
          <FormField label="Camera name" hint="Where it points, like Front door or Counter." error={errors.name} required>
            <TextInput value={name} onInput={setName} maxLength={64} autoComplete="off" autoFocus />
          </FormField>
          {nextButton}
        </form>
      </Section>
    );
  } else if (step === 'account') {
    body = (
      <Section title="Camera account" lead={lead('The sign-in the camera asks for.')}>
        <form class="stack" onSubmit={next} noValidate>
          {location.hasCameraLogin ? (
            <SegmentedControl<'saved' | 'other'>
              label="Camera login"
              block
              value={useSaved ? 'saved' : 'other'}
              onChange={(value) => {
                setLoginChoice(value);
                setErrors({});
              }}
              options={[
                { value: 'saved', label: 'Saved login' },
                { value: 'other', label: 'Another login' },
              ]}
            />
          ) : null}
          {useSaved ? (
            <p class="k-body-s">
              {location.cameraUsername
                ? `Signs in as ${location.cameraUsername}, the login saved for ${location.name}.`
                : `Uses the login saved for ${location.name}.`}
            </p>
          ) : (
            <>
              <p class="k-body-s">{vendor === 'tapo' ? TAPO_ACCOUNT_HINT : OTHER_ACCOUNT_HINT}</p>
              <FormField label="Camera username" error={errors.username} required>
                <TextInput value={username} onInput={setUsername} autoComplete="off" autoCapitalize="off" spellcheck={false} autoFocus />
              </FormField>
              <FormField label="Camera password" hint="Kept encrypted on the hub. It is never shown again." error={errors.password} required>
                <PasswordInput value={password} onInput={setPassword} autoComplete="new-password" />
              </FormField>
            </>
          )}
          {nextButton}
        </form>
      </Section>
    );
  } else if (step === 'quality') {
    body = (
      <Section title="Quality" lead={lead('How sharp the video is kept.')}>
        <form class="stack" onSubmit={next}>
          <SegmentedControl<Quality>
            label="Quality"
            block
            value={quality}
            onChange={setQuality}
            options={[
              { value: '360p', label: '360p' },
              { value: '720p', label: '720p' },
              { value: '1080p', label: '1080p' },
            ]}
          />
          <p class="k-body-s">{QUALITY_HINTS[quality]}</p>
          <GroupedList label="Recording">
            <Toggle
              inList
              label="Record this camera"
              description="Saved encrypted to the cloud"
              checked={recording}
              onChange={setRecording}
            />
          </GroupedList>
          {nextButton}
        </form>
      </Section>
    );
  } else {
    body = (
      <Section title="Test and save" lead={lead('Check the camera answers, then save it.')}>
        <form class="stack" onSubmit={(event) => void save(event)}>
          <GroupedList label="Summary">
            <ListRow icon="cameras" title={name.trim()} secondary={vendorLabel(vendor)} value={quality} />
            <ListRow
              icon="link"
              title={lanIp.trim()}
              secondary={useSaved ? 'Signs in with the saved login' : `Signs in as ${username.trim()}`}
              value={recording ? 'Recording' : 'Live only'}
            />
          </GroupedList>
          <div class="cam-actions">
            <Button icon="check" loading={testing} loadingLabel="Testing..." onClick={() => void test()}>
              Test connection
            </Button>
          </div>
          {testError ? (
            <p class="k-body-s text-error" role="alert">
              {testError}
            </p>
          ) : null}
          {testResult ? (
            <div class="stack-8" role="status">
              <div class="cam-result">
                <span class="k-body-s">Main stream</span>
                <span class={`k-body-s ${testResult.main.ok ? 'text-cream' : 'text-error'}`}>{streamSummary(testResult.main)}</span>
              </div>
              {testResult.sub ? (
                <div class="cam-result">
                  <span class="k-body-s">Sub stream</span>
                  <span class={`k-body-s ${testResult.sub.ok ? 'text-cream' : 'text-error'}`}>{streamSummary(testResult.sub)}</span>
                </div>
              ) : null}
              {testResult.manufacturer || testResult.model ? (
                <div class="cam-result">
                  <span class="k-body-s">Camera</span>
                  <span class="k-body-s text-cream">{[testResult.manufacturer, testResult.model].filter(Boolean).join(' ')}</span>
                </div>
              ) : null}
              {!testResult.main.ok ? (
                <p class="k-body-s">Check the address, the camera account and that the camera is on. You can still save it and fix it later.</p>
              ) : null}
            </div>
          ) : null}
          {saveError ? (
            <p class="k-body-s text-error" role="alert">
              {saveError}
            </p>
          ) : null}
          {stepActions(
            <Button variant="primary" size="l" type="submit" icon="check" loading={saving} loadingLabel="Saving...">
              Save camera
            </Button>,
          )}
        </form>
      </Section>
    );
  }

  return (
    <>
      <PageHeader
        back={{ href: `/cameras?locationId=${location.id}`, label: 'Cameras' }}
        caption={location.name}
        title="Add camera"
        subtitle="Connect a camera so you can watch and record it."
      />
      {body}
    </>
  );
}
