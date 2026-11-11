import type { TargetedSubmitEvent } from 'preact';
import { useState } from 'preact/hooks';
import { UPLOAD_CAP_KBPS_DEFAULT } from '../../../../shared/api-types.ts';
import type { ConnectorKind, CreateLocationRequest, LocationSummary } from '../../../../shared/api-types.ts';
import { Button, FormField, PageHeader, Section, Select, TextInput, useToast } from '../../components/index.ts';
import { ApiFailure, apiSend, describeError } from '../../lib/api.ts';
import { browserTimezone } from '../../lib/format.ts';
import { navigate } from '../../lib/router.ts';
import { CONNECTORS, subnetProblem, timezoneOptions } from './location-text.ts';

type Step = 'name' | 'connector' | 'network';

interface Errors {
  name?: string;
  timezone?: string;
  cameraSubnet?: string;
  wanRoutingTable?: string;
  uploadCap?: string;
  form?: string;
}

/** Add a location, one step per screen: name and time zone, how the hub reaches it, its camera network. */
export function NewLocationPage() {
  const toast = useToast();
  const [step, setStep] = useState<Step>('name');
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState(browserTimezone());
  const [connector, setConnector] = useState<ConnectorKind>('router');
  const [cameraSubnet, setCameraSubnet] = useState('');
  const [wanRoutingTable, setWanRoutingTable] = useState('');
  const [uploadCap, setUploadCap] = useState(String(UPLOAD_CAP_KBPS_DEFAULT));
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);

  // The bridge finds cameras on its own network, so it skips the network step.
  const total = connector === 'bridge' ? 2 : 3;
  const lead = (n: number, text: string) => `Step ${n} of ${total}. ${text}`;

  const create = async () => {
    const body: CreateLocationRequest = { name: name.trim(), timezone, connector };
    if (connector !== 'bridge') body.cameraSubnet = cameraSubnet.trim();
    if (connector === 'router') {
      body.wanRoutingTable = wanRoutingTable.trim() || null;
      body.uploadCapKbps = Number(uploadCap);
    }
    setBusy(true);
    try {
      const location = await apiSend<LocationSummary>('POST', '/api/locations', body);
      // The location page lists what comes next: connect it, save the camera login, then detect cameras.
      toast.show({
        message: connector === 'direct' ? 'Location added. Next, save the camera login.' : 'Location added. Next, connect it to the hub.',
        tone: 'success',
      });
      navigate(`/locations/${location.id}`, { replace: true });
    } catch (err) {
      const message = describeError(err);
      if (err instanceof ApiFailure && err.code === 'invalid_input') {
        const text = err.message.toLowerCase();
        if (text.includes('camera network') || text.includes('subnet')) setErrors({ cameraSubnet: message });
        else if (text.includes('upload')) setErrors({ uploadCap: message });
        else if (text.includes('routing')) setErrors({ wanRoutingTable: message });
        else if (text.includes('time zone') || text.includes('timezone')) {
          setErrors({ timezone: message });
          setStep('name');
        } else if (text.includes('name')) {
          setErrors({ name: message });
          setStep('name');
        } else setErrors({ form: message });
      } else {
        setErrors({ form: message });
      }
    } finally {
      setBusy(false);
    }
  };

  const submitName = (event: TargetedSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next: Errors = {};
    if (!name.trim()) next.name = 'Give the location a name, like the shop or branch name.';
    if (!timezone) next.timezone = 'Choose the time zone of this location.';
    setErrors(next);
    if (Object.keys(next).length === 0) setStep('connector');
  };

  const submitConnector = (event: TargetedSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrors({});
    if (connector === 'bridge') void create();
    else setStep('network');
  };

  const submitNetwork = (event: TargetedSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next: Errors = {};
    const subnet = subnetProblem(cameraSubnet, connector);
    if (subnet) next.cameraSubnet = subnet;
    if (connector === 'router') {
      const cap = Number(uploadCap);
      if (!uploadCap.trim() || !Number.isInteger(cap) || cap <= 0) next.uploadCap = 'Type a whole number of kbps, like 5000.';
    }
    setErrors(next);
    if (Object.keys(next).length === 0) void create();
  };

  let body;
  if (step === 'name') {
    body = (
      <form class="stack-24" onSubmit={submitName} noValidate>
        <Section title="Name and time zone" lead={lead(1, 'What to call this place, and its local time.')}>
          <div class="stack">
            <FormField label="Location name" hint="Like the shop or branch name." error={errors.name} required>
              <TextInput value={name} onInput={setName} autoComplete="off" maxLength={80} autoFocus required />
            </FormField>
            <FormField label="Time zone" hint="Recordings are listed in this local time." error={errors.timezone} required>
              <Select value={timezone} options={timezoneOptions()} onChange={setTimezone} />
            </FormField>
          </div>
        </Section>
        <div class="actions row-between">
          <Button variant="ghost" icon="chevron-left" href="/locations">
            Cancel
          </Button>
          <Button variant="primary" size="l" type="submit">
            Next
          </Button>
        </div>
      </form>
    );
  } else if (step === 'connector') {
    body = (
      <form class="stack-24" onSubmit={submitConnector} noValidate>
        <Section title="Connection" lead={lead(2, 'How the hub reaches the cameras at this place.')}>
          <fieldset class="plain-fieldset stack-8">
            <legend class="sr-only">Connection</legend>
            {CONNECTORS.map((item) => (
              <label key={item.kind} class="check">
                <input
                  type="radio"
                  name="connector"
                  value={item.kind}
                  checked={connector === item.kind}
                  onChange={() => setConnector(item.kind)}
                />
                <span class="stack-8">
                  <span class="k-body fw-bold text-cream">{item.label}</span>
                  <span class="k-body-s">{item.detail}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {errors.form && <p class="k-body-s text-error" role="alert">{errors.form}</p>}
        </Section>
        <div class="actions row-between">
          <Button variant="ghost" icon="chevron-left" onClick={() => setStep('name')} disabled={busy}>
            Back
          </Button>
          {connector === 'bridge' ? (
            <Button variant="primary" size="l" type="submit" loading={busy} loadingLabel="Adding...">
              Create location
            </Button>
          ) : (
            <Button variant="primary" size="l" type="submit">
              Next
            </Button>
          )}
        </div>
      </form>
    );
  } else {
    body = (
      <form class="stack-24" onSubmit={submitNetwork} noValidate>
        <Section title="Camera network" lead={lead(3, 'Where the cameras sit on the local network.')}>
          <div class="stack">
            <FormField
              label="Camera network"
              hint={connector === 'router' ? 'Ends in /24, like 192.168.1.0/24. Ask whoever set up the router.' : 'Like 192.168.1.0/24.'}
              error={errors.cameraSubnet}
              required
            >
              <TextInput
                value={cameraSubnet}
                onInput={setCameraSubnet}
                mono
                inputMode="decimal"
                autoComplete="off"
                spellcheck={false}
                placeholder="192.168.1.0/24"
                autoFocus
                required
              />
            </FormField>
            {connector === 'router' && (
              <>
                <FormField
                  label="Upload cap"
                  hint="In kbps. Keeps camera uploads from filling the internet line. 5000 is about 5 Mbps."
                  error={errors.uploadCap}
                  required
                >
                  <TextInput value={uploadCap} onInput={setUploadCap} type="number" inputMode="numeric" min={1} step={1} mono required />
                </FormField>
                <FormField
                  label="Internet line"
                  hint="Only for routers with two or more internet lines: the routing table of the line to use. Leave blank otherwise."
                  error={errors.wanRoutingTable}
                  optional
                >
                  <TextInput value={wanRoutingTable} onInput={setWanRoutingTable} mono autoComplete="off" spellcheck={false} />
                </FormField>
              </>
            )}
            {errors.form && <p class="k-body-s text-error" role="alert">{errors.form}</p>}
          </div>
        </Section>
        <div class="actions row-between">
          <Button variant="ghost" icon="chevron-left" onClick={() => setStep('connector')} disabled={busy}>
            Back
          </Button>
          <Button variant="primary" size="l" type="submit" loading={busy} loadingLabel="Adding...">
            Create location
          </Button>
        </div>
      </form>
    );
  }

  return (
    <>
      <PageHeader back={{ href: '/locations', label: 'Locations' }} title="New location" subtitle="Add a place where your cameras are." />
      {body}
    </>
  );
}
