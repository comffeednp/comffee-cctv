import type { TargetedSubmitEvent } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { RETENTION_DAYS_MAX, RETENTION_DAYS_MIN } from '../../../../shared/api-types.ts';
import type {
  BridgeSetup,
  BridgeTokenResponse,
  DeleteLocationRequest,
  LocationSetup,
  LocationSummary,
  RouterSetup,
  UpdateLocationRequest,
} from '../../../../shared/api-types.ts';
import {
  Badge,
  Button,
  CopyBox,
  Dialog,
  EmptyState,
  FloatingSave,
  FormField,
  GroupedList,
  IconButton,
  ListRow,
  PageHeader,
  PasswordInput,
  Section,
  Select,
  StatusDot,
  TextInput,
  Toggle,
  useToast,
} from '../../components/index.ts';
import { ApiFailure, apiGet, apiSend, describeError } from '../../lib/api.ts';
import { formatDateTime, plural } from '../../lib/format.ts';
import { navigate, useRoute } from '../../lib/router.ts';
import { PageLoading } from '../../app/Redirect.tsx';
import { TAPO_ACCOUNT_HINT } from '../cameras/camera-text.ts';
import { connectorInfo, subnetProblem, timezoneOptions } from './location-text.ts';

const POLL_MS = 20_000;
const WG_KEY = /^[A-Za-z0-9+/]{43}=$/;

interface FormState {
  name: string;
  timezone: string;
  retentionDays: string;
  uploadCapKbps: string;
  cameraSubnet: string;
  wanRoutingTable: string;
  /** Saved camera login for the location. The password is never sent back by the hub, so it starts empty. */
  cameraUsername: string;
  cameraPassword: string;
}

function formFrom(location: LocationSummary): FormState {
  return {
    name: location.name,
    timezone: location.timezone,
    retentionDays: String(location.retentionDays),
    uploadCapKbps: String(location.uploadCapKbps),
    cameraSubnet: location.cameraSubnet ?? '',
    wanRoutingTable: location.wanRoutingTable ?? '',
    cameraUsername: location.cameraUsername ?? '',
    cameraPassword: '',
  };
}

function sameForm(a: FormState, b: FormState): boolean {
  return (Object.keys(a) as (keyof FormState)[]).every((key) =>
    key === 'cameraPassword' ? a[key] === b[key] : a[key].trim() === b[key].trim(),
  );
}

/** True when the camera login fields differ from what the hub has saved. */
function cameraLoginChanged(form: FormState, location: LocationSummary): boolean {
  return form.cameraUsername.trim() !== (location.cameraUsername ?? '') || form.cameraPassword !== '';
}

/** Moves to a section of this page; with `focusField`, also puts the cursor in its first field. */
function goToSection(id: string, focusField = false): void {
  const target = document.getElementById(id);
  if (!target) return;
  target.scrollIntoView({ block: 'start' });
  if (focusField) target.querySelector<HTMLInputElement>('input:not([type="hidden"]):not([disabled])')?.focus({ preventScroll: true });
}

/** One location: what to do next, its setup instructions, recording switch, camera login, settings and delete. */
export function LocationDetailPage() {
  const { params } = useRoute();
  const id = Number(params.id);
  const toast = useToast();

  const [location, setLocation] = useState<LocationSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [setup, setSetup] = useState<LocationSetup | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const [form, setForm] = useState<FormState | null>(null);
  const [formErrors, setFormErrors] = useState<Partial<Record<keyof FormState | 'form', string>>>({});
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>();

  const [clearLoginOpen, setClearLoginOpen] = useState(false);
  const [clearingLogin, setClearingLogin] = useState(false);
  const [clearLoginError, setClearLoginError] = useState<string | undefined>();

  useEffect(() => {
    if (!Number.isInteger(id) || id <= 0) {
      setNotFound(true);
      return;
    }
    const controller = new AbortController();
    const load = async () => {
      try {
        const next = await apiGet<LocationSummary>(`/api/locations/${id}`, undefined, { signal: controller.signal });
        setLocation(next);
        setForm((current) => current ?? formFrom(next));
        setLoadError(null);
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof ApiFailure && err.code === 'not_found') setNotFound(true);
        else setLoadError(describeError(err));
        return;
      }
      try {
        setSetup(await apiGet<LocationSetup>(`/api/locations/${id}/setup`, undefined, { signal: controller.signal }));
        setSetupError(null);
      } catch (err) {
        if (!controller.signal.aborted) setSetupError(describeError(err));
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [id, reload]);

  if (notFound) {
    return (
      <>
        <PageHeader back={{ href: '/locations', label: 'Locations' }} title="Location not found" subtitle="It may have been deleted." />
        <EmptyState icon="locations" title="No such location" action={<Button href="/locations">Open locations</Button>} />
      </>
    );
  }
  if (!location || !form) {
    if (loadError) {
      return (
        <>
          <PageHeader back={{ href: '/locations', label: 'Locations' }} title="Location" subtitle="Setup, recording and settings." />
          <EmptyState
            icon="warning"
            title="Could not load this location"
            message={loadError}
            action={
              <Button icon="refresh" onClick={() => setReload((n) => n + 1)}>
                Try again
              </Button>
            }
          />
        </>
      );
    }
    return <PageLoading label="Loading location" />;
  }

  const info = connectorInfo(location.connector);
  const dirty = !sameForm(form, formFrom(location));
  const set = (key: keyof FormState) => (value: string) => setForm({ ...form, [key]: value });

  const toggleRecording = async (on: boolean) => {
    setToggling(true);
    try {
      const body: UpdateLocationRequest = { recordingPaused: !on };
      setLocation(await apiSend<LocationSummary>('PATCH', `/api/locations/${id}`, body));
      toast.show({ message: on ? 'Recording resumed.' : 'Recording paused.', tone: 'success' });
    } catch (err) {
      toast.show({ message: describeError(err), tone: 'error' });
    } finally {
      setToggling(false);
    }
  };

  const save = async (event: TargetedSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const errors: typeof formErrors = {};
    if (!form.name.trim()) errors.name = 'Give the location a name.';
    const retention = Number(form.retentionDays);
    if (!Number.isInteger(retention) || retention < RETENTION_DAYS_MIN || retention > RETENTION_DAYS_MAX) {
      errors.retentionDays = `Type a whole number from ${RETENTION_DAYS_MIN} to ${RETENTION_DAYS_MAX}.`;
    }
    if (location.connector !== 'bridge') {
      const subnet = subnetProblem(form.cameraSubnet, location.connector);
      if (subnet) errors.cameraSubnet = subnet;
    }
    if (location.connector === 'router') {
      const cap = Number(form.uploadCapKbps);
      if (!Number.isInteger(cap) || cap <= 0) errors.uploadCapKbps = 'Type a whole number of kbps, like 5000.';
    }
    // The hub takes the camera login as a pair, so a new username also needs the password typed again.
    const loginChanged = cameraLoginChanged(form, location);
    if (loginChanged) {
      if (!form.cameraUsername.trim()) errors.cameraUsername = 'Type the camera username.';
      if (!form.cameraPassword) {
        errors.cameraPassword = location.hasCameraLogin ? 'Type the camera password too, to change the saved login.' : 'Type the camera password.';
      }
    }
    setFormErrors(errors);
    if (Object.keys(errors).length) return;

    const body: UpdateLocationRequest = {};
    const before = formFrom(location);
    if (form.name.trim() !== before.name) body.name = form.name.trim();
    if (form.timezone !== before.timezone) body.timezone = form.timezone;
    if (retention !== location.retentionDays) body.retentionDays = retention;
    if (location.connector !== 'bridge' && form.cameraSubnet.trim() !== before.cameraSubnet) body.cameraSubnet = form.cameraSubnet.trim();
    if (location.connector === 'router') {
      if (Number(form.uploadCapKbps) !== location.uploadCapKbps) body.uploadCapKbps = Number(form.uploadCapKbps);
      if (form.wanRoutingTable.trim() !== before.wanRoutingTable) body.wanRoutingTable = form.wanRoutingTable.trim() || null;
    }
    if (loginChanged) {
      body.cameraUsername = form.cameraUsername.trim();
      body.cameraPassword = form.cameraPassword;
    }
    const onlyLogin = loginChanged && Object.keys(body).length === 2;
    setSaving(true);
    try {
      const next = await apiSend<LocationSummary>('PATCH', `/api/locations/${id}`, body);
      setLocation(next);
      setForm(formFrom(next));
      toast.show({ message: onlyLogin ? 'Camera login saved.' : 'Location saved.', tone: 'success' });
      // The router script depends on the network, cap and line, so fetch it again.
      setReload((n) => n + 1);
    } catch (err) {
      setFormErrors({ form: describeError(err) });
    } finally {
      setSaving(false);
    }
  };

  const clearLogin = async () => {
    setClearingLogin(true);
    setClearLoginError(undefined);
    try {
      const body: UpdateLocationRequest = { clearCameraLogin: true };
      const next = await apiSend<LocationSummary>('PATCH', `/api/locations/${id}`, body);
      setLocation(next);
      // Keep any other unsaved edits; only the login fields follow the hub.
      setForm((current) => (current ? { ...current, cameraUsername: next.cameraUsername ?? '', cameraPassword: '' } : formFrom(next)));
      setFormErrors((current) => ({ ...current, cameraUsername: undefined, cameraPassword: undefined }));
      setClearLoginOpen(false);
      toast.show({ message: 'Saved camera login removed.', tone: 'success' });
    } catch (err) {
      setClearLoginError(describeError(err));
    } finally {
      setClearingLogin(false);
    }
  };

  // Shown until the first camera is added: the steps that get this location watching, the next one marked.
  const steps: { key: string; title: string; secondary: string; done: boolean; go: () => void; href?: string }[] = [];
  if (location.connector !== 'direct') {
    steps.push({
      key: 'connect',
      title: location.connector === 'router' ? 'Connect the router' : 'Start the bridge program',
      secondary: location.online ? 'Connected to the hub' : 'Follow the setup steps below',
      done: location.online,
      go: () => goToSection('setup'),
    });
  }
  steps.push({
    key: 'login',
    title: 'Save the camera login',
    secondary: location.hasCameraLogin && location.cameraUsername ? `Signs in as ${location.cameraUsername}` : 'Typed once, used for every camera here',
    done: location.hasCameraLogin,
    go: () => goToSection('camera-login', true),
  });
  steps.push({
    key: 'detect',
    title: 'Detect cameras',
    secondary: 'Find the cameras on this network and add them',
    done: false,
    go: () => navigate(`/cameras?locationId=${id}`),
    href: `/cameras?locationId=${id}`,
  });
  const nextStep = steps.find((step) => !step.done)?.key;

  const remove = async (password: string) => {
    setDeleting(true);
    setDeleteError(undefined);
    try {
      const body: DeleteLocationRequest = { password };
      await apiSend('DELETE', `/api/locations/${id}`, body);
      toast.show({ message: 'Location deleted.', tone: 'success' });
      navigate('/locations', { replace: true });
    } catch (err) {
      setDeleteError(describeError(err, { wrong_password: 'That password is not right.' }));
      setDeleting(false);
    }
  };

  return (
    <>
      <PageHeader
        back={{ href: '/locations', label: 'Locations' }}
        title={location.name}
        subtitle={`${info.short} · ${location.timezone.replace(/_/g, ' ')}`}
        status={<StatusDot status={location.online ? 'online' : 'offline'} />}
      />

      {location.cameraCount === 0 && (
        <Section title="Next steps" lead="Do these in order to start watching this location.">
          <GroupedList label="Next steps">
            {steps.map((step) => (
              <ListRow
                key={step.key}
                icon={step.key === 'connect' ? info.icon : step.key === 'login' ? 'key' : 'detect'}
                tone={step.key === nextStep ? 'amber' : 'default'}
                title={step.title}
                secondary={step.secondary}
                trailing={
                  step.done ? <Badge tone="ok">Done</Badge> : step.key === nextStep ? <Badge tone="amber">Next</Badge> : undefined
                }
                href={step.href}
                onClick={step.href ? undefined : step.go}
              />
            ))}
          </GroupedList>
        </Section>
      )}

      <Section title="Recording" lead="Turn recording on or off for every camera here.">
        <GroupedList label="Recording">
          <Toggle
            inList
            label="Record at this location"
            description="Pausing stops uploads from this location, which saves internet."
            checked={!location.recordingPaused}
            busy={toggling}
            onChange={(on) => void toggleRecording(on)}
          />
          <ListRow
            icon="cameras"
            title="Cameras"
            secondary={`${plural(location.recordingCameraCount, 'camera')} recording now`}
            value={String(location.cameraCount)}
            href={`/cameras?locationId=${id}`}
          />
        </GroupedList>
      </Section>

      <Section
        id="setup"
        class="scroll-target"
        title="Setup"
        lead={info.label}
        actions={<IconButton icon="refresh" label="Check again" onClick={() => setReload((n) => n + 1)} />}
      >
        {setupError ? (
          <p class="notice k-body-s text-error" role="alert">
            {setupError}
          </p>
        ) : !setup ? (
          <PageLoading label="Loading setup" />
        ) : setup.connector === 'router' ? (
          <RouterSetupPanel id={id} timezone={location.timezone} router={setup.router} onChanged={() => setReload((n) => n + 1)} />
        ) : setup.connector === 'bridge' ? (
          <BridgeSetupPanel id={id} timezone={location.timezone} bridge={setup.bridge} onChanged={() => setReload((n) => n + 1)} />
        ) : (
          <p class="k-body">{setup.direct.note}</p>
        )}
      </Section>

      <form id="location-form" class="stack-24" onSubmit={save} noValidate>
        <Section
          id="camera-login"
          class="scroll-target"
          title="Camera login"
          lead="Saved once, used for every camera you add here."
        >
          <div class="stack">
            {location.hasCameraLogin && (
              <GroupedList label="Saved camera login">
                <ListRow
                  icon="key"
                  title="Saved for this location"
                  secondary={location.cameraUsername ? `Username ${location.cameraUsername}` : undefined}
                  trailing={<Badge tone="ok">Saved</Badge>}
                />
              </GroupedList>
            )}
            <p class="k-body-s">{TAPO_ACCOUNT_HINT}</p>
            <FormField label="Camera username" error={formErrors.cameraUsername}>
              <TextInput
                value={form.cameraUsername}
                onInput={set('cameraUsername')}
                autoComplete="off"
                autoCapitalize="none"
                spellcheck={false}
                maxLength={128}
              />
            </FormField>
            <FormField
              label="Camera password"
              hint={location.hasCameraLogin ? 'Type it only to change the saved login.' : 'Kept encrypted on the hub. It is never shown again.'}
              error={formErrors.cameraPassword}
            >
              <PasswordInput value={form.cameraPassword} onInput={set('cameraPassword')} autoComplete="new-password" maxLength={128} />
            </FormField>
          </div>
        </Section>

        <Section title="Settings" lead="Name, local time and how long recordings are kept.">
          <div class="stack">
            <FormField label="Location name" error={formErrors.name} required>
              <TextInput value={form.name} onInput={set('name')} autoComplete="off" maxLength={80} required />
            </FormField>
            <FormField label="Time zone" error={formErrors.timezone} required>
              <Select value={form.timezone} options={timezoneOptions()} onChange={set('timezone')} />
            </FormField>
            <FormField
              label="Keep recordings"
              hint={`Days, ${RETENTION_DAYS_MIN} to ${RETENTION_DAYS_MAX}. Older recordings are deleted on their own.`}
              error={formErrors.retentionDays}
              required
            >
              <TextInput
                value={form.retentionDays}
                onInput={set('retentionDays')}
                type="number"
                inputMode="numeric"
                min={RETENTION_DAYS_MIN}
                max={RETENTION_DAYS_MAX}
                step={1}
                required
              />
            </FormField>
            {location.connector !== 'bridge' && (
              <FormField label="Camera network" hint="Like 192.168.1.0/24." error={formErrors.cameraSubnet} required>
                <TextInput value={form.cameraSubnet} onInput={set('cameraSubnet')} mono inputMode="decimal" autoComplete="off" spellcheck={false} required />
              </FormField>
            )}
            {location.connector === 'router' && (
              <>
                <FormField label="Upload cap" hint="In kbps. 5000 is about 5 Mbps." error={formErrors.uploadCapKbps} required>
                  <TextInput value={form.uploadCapKbps} onInput={set('uploadCapKbps')} type="number" inputMode="numeric" min={1} step={1} mono required />
                </FormField>
                <FormField
                  label="Internet line"
                  hint="Routing table of the line to use, for routers with two or more lines."
                  error={formErrors.wanRoutingTable}
                  optional
                >
                  <TextInput value={form.wanRoutingTable} onInput={set('wanRoutingTable')} mono autoComplete="off" spellcheck={false} />
                </FormField>
              </>
            )}
            {formErrors.form && (
              <p class="k-body-s text-error" role="alert">
                {formErrors.form}
              </p>
            )}
          </div>
        </Section>
      </form>

      <Section title="Remove" lead="Removing cannot be undone.">
        <GroupedList label="Remove">
          {location.hasCameraLogin && (
            <ListRow icon="key" title="Remove saved login" secondary="Cameras added already keep working" tone="danger" onClick={() => setClearLoginOpen(true)} />
          )}
          <ListRow icon="trash" title="Delete location" tone="danger" onClick={() => setDeleteOpen(true)} />
        </GroupedList>
      </Section>

      <FloatingSave form="location-form" dirty={dirty} saving={saving} title="Save location settings" />

      <Dialog
        open={clearLoginOpen}
        tone="danger"
        title="Remove the saved camera login?"
        message="Cameras added already keep their own copy and keep working. New cameras will ask for a login."
        confirmLabel="Remove login"
        busyLabel="Removing..."
        busy={clearingLogin}
        error={clearLoginError}
        onConfirm={() => void clearLogin()}
        onCancel={() => {
          setClearLoginOpen(false);
          setClearLoginError(undefined);
        }}
      />

      <Dialog
        open={deleteOpen}
        tone="danger"
        title="Delete this location?"
        message="Its cameras are removed and recording stops. Recordings already saved are deleted when they reach the keep limit."
        confirmLabel="Delete location"
        busyLabel="Deleting..."
        password={{ label: 'Your password' }}
        busy={deleting}
        error={deleteError}
        onConfirm={(password) => void remove(password)}
        onCancel={() => {
          setDeleteOpen(false);
          setDeleteError(undefined);
        }}
      />
    </>
  );
}

function RouterSetupPanel({ id, timezone, router, onChanged }: { id: number; timezone: string; router: RouterSetup; onChanged: () => void }) {
  const toast = useToast();
  const [key, setKey] = useState('');
  const [keyError, setKeyError] = useState<string | undefined>();
  const [linking, setLinking] = useState(false);

  const link = async (event: TargetedSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = key.trim();
    if (!WG_KEY.test(value)) {
      setKeyError('Paste the whole key the script printed: 44 characters ending in =.');
      return;
    }
    setLinking(true);
    try {
      const body: UpdateLocationRequest = { routerPublicKey: value };
      await apiSend<LocationSummary>('PATCH', `/api/locations/${id}`, body);
      setKey('');
      setKeyError(undefined);
      toast.show({ message: 'Router linked. The tunnel should come up within a minute.', tone: 'success' });
      onChanged();
    } catch (err) {
      setKeyError(describeError(err));
    } finally {
      setLinking(false);
    }
  };

  return (
    <div class="stack-24">
      <GroupedList label="Tunnel">
        <ListRow
          icon="router"
          title="Tunnel"
          secondary={router.lastHandshake ? `Last contact ${formatDateTime(router.lastHandshake, timezone)}` : 'No contact yet'}
          trailing={<StatusDot status={router.tunnelUp ? 'online' : 'offline'} label={router.tunnelUp ? 'Connected' : 'Not connected'} />}
        />
      </GroupedList>

      <Section level={3} title="1. Run the script" lead="On the MikroTik router: open New Terminal in Winbox, paste, press Enter.">
        <CopyBox label="Router script" value={router.routerOsScript} multiline />
      </Section>

      <Section level={3} title="2. Paste the router key" lead="The script's last line prints a key. Paste it here.">
        <form class="stack" onSubmit={link} noValidate>
          <FormField label="Router key" hint="44 characters ending in =." error={keyError}>
            <TextInput value={key} onInput={setKey} mono autoComplete="off" spellcheck={false} autoCapitalize="none" />
          </FormField>
          <div class="actions">
            <Button variant="primary" type="submit" icon="link" loading={linking} loadingLabel="Linking...">
              Link router
            </Button>
            {router.routerPublicKeySet && <Badge tone="ok">Key saved</Badge>}
          </div>
        </form>
      </Section>

      <Section level={3} title="Other routers" lead="For any WireGuard router that can map one network onto another.">
        <div class="stack">
          <p class="k-body-s">
            The router must map the tunnel network onto the camera network, as noted in the file. If yours cannot, use the
            bridge program instead.
          </p>
          <CopyBox label="WireGuard settings" value={router.genericWireguardConfig} multiline />
        </div>
      </Section>

      <Section level={3} title="Undo" lead="Removes everything the script added to the router.">
        <CopyBox label="Undo script" value={router.routerOsUndoScript} multiline />
      </Section>
    </div>
  );
}

function BridgeSetupPanel({ id, timezone, bridge, onChanged }: { id: number; timezone: string; bridge: BridgeSetup; onChanged: () => void }) {
  const toast = useToast();
  const [fresh, setFresh] = useState<BridgeTokenResponse | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const rotate = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setFresh(await apiSend<BridgeTokenResponse>('POST', `/api/locations/${id}/bridge-token`, {}));
      setConfirmOpen(false);
      toast.show({ message: 'New token made. Copy it now.', tone: 'success' });
      onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="stack-24">
      <GroupedList label="Bridge">
        <ListRow
          icon="link"
          title="Bridge program"
          secondary={bridge.lastSeen ? `Last seen ${formatDateTime(bridge.lastSeen, timezone)}` : 'Not seen yet'}
          trailing={<StatusDot status={bridge.connected ? 'online' : 'offline'} label={bridge.connected ? 'Connected' : 'Not connected'} />}
        />
      </GroupedList>

      <Section level={3} title="1. Get the program" lead="Put it on a computer or mini PC at this location that stays on.">
        {bridge.downloadUrl ? (
          <div class="actions">
            <Button icon="download" href={bridge.downloadUrl} target="_blank">
              Download bridge
            </Button>
          </div>
        ) : (
          <p class="k-body-s">This hub has no download link for the bridge program yet. Ask whoever set up the hub for it.</p>
        )}
      </Section>

      <Section level={3} title="2. Start it with a token" lead="The token lets the program connect to this location only.">
        <div class="stack">
          {fresh ? (
            <>
              <p class="notice k-body-s text-amber">This token is shown only once. Copy it now and keep it private.</p>
              <CopyBox label="Bridge token" value={fresh.token} />
              <CopyBox label="Start command" value={fresh.command} multiline />
            </>
          ) : (
            <>
              <CopyBox label="Start command" value={bridge.command} multiline />
              <p class="k-body-s">
                {bridge.hasToken
                  ? 'Replace <token> with the token you saved. Lost it? Make a new one; the old one stops working.'
                  : 'Make a token, then the command is filled in for you.'}
              </p>
            </>
          )}
          <div class="actions">
            <Button
              variant={fresh ? 'secondary' : 'primary'}
              icon="key"
              onClick={() => (bridge.hasToken || fresh ? setConfirmOpen(true) : void rotate())}
              loading={busy && !confirmOpen}
              loadingLabel="Making..."
            >
              {bridge.hasToken || fresh ? 'Make new token' : 'Make token'}
            </Button>
          </div>
          {error && !confirmOpen && (
            <p class="k-body-s text-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </Section>

      <Dialog
        open={confirmOpen}
        title="Make a new bridge token?"
        message="The old token stops working at once, and the bridge using it disconnects until you start it with the new one."
        confirmLabel="Make new token"
        busyLabel="Making..."
        busy={busy}
        error={error}
        onConfirm={() => void rotate()}
        onCancel={() => {
          setConfirmOpen(false);
          setError(undefined);
        }}
      />
    </div>
  );
}
