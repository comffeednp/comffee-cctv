// Step 1: connect an Oracle account, by browser sign-in (session token) or by API key.
import type { TargetedSubmitEvent } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Button, FormField, GroupedList, Icon, ListRow, Section, Select, Spinner, TextInput, useToast } from '../../../dashboard/src/components/index.ts';
import { DEFAULT_REGION, OCI_REGIONS, isOciRegion } from '../../src/lib/oci-regions.ts';
import type { AccountView } from '../../src/lib/ipc-types.ts';
import { FlowPage, HubPage, TextArea, stepLead } from '../components/Parts.tsx';
import { call, cctv, errorText, isCancelled, useAppState, useEvent } from '../lib/bridge.ts';
import { navigate } from '../lib/router.ts';
import { ONE_ACCOUNT_NOTE } from './Start.tsx';

const REGION_OPTIONS = OCI_REGIONS.map((r) => ({ value: r.name, label: r.label, detail: r.name }));

function withReplace(path: string, replace: string | null): string {
  return replace ? `${path}?replace=${encodeURIComponent(replace)}` : path;
}

/** Where to go once an account is connected. */
function afterConnect(account: AccountView, replace: string | null): void {
  if (replace) navigate(`/settings/account/${account.id}`, true);
  else navigate(`/plan/${account.id}`, true);
}

export function Connect({ replace }: { replace: string | null }) {
  const caption = replace ? 'Change Oracle account' : 'Create a free server';
  return (
    <HubPage
      caption={caption}
      title="Connect your Oracle account"
      subtitle="The app uses it only to make your server."
      back={replace ? { href: `/settings/account/${replace}`, label: 'Account' } : { href: '/', label: 'Back' }}
    >
      <Section title="Choose how" lead={stepLead(1, 'Sign in, or use an API key.')}>
        <GroupedList label="Choose how">
          <ListRow icon="shield" title="Sign in with Oracle" secondary="Safest. Nothing permanent is saved" href={withReplace('/connect/sign-in', replace)} />
          <ListRow icon="key" title="Use an API key" secondary="Paste Oracle's text and pick the key file" href={withReplace('/connect/api-key', replace)} />
        </GroupedList>
      </Section>
      <Section title="No account yet?" lead={ONE_ACCOUNT_NOTE}>
        <GroupedList label="No account yet?">
          <ListRow icon="plus" title="Make a free Oracle account" secondary="Opens Oracle in your browser" onClick={() => void cctv.openLink('oracle-signup')} />
          <ListRow icon="info" title="What the free plan gives" secondary="Opens Oracle in your browser" onClick={() => void cctv.openLink('oracle-free-tier')} />
        </GroupedList>
      </Section>
    </HubPage>
  );
}

export function SignIn({ replace }: { replace: string | null }) {
  const toast = useToast();
  const state = useAppState();
  const replacing = state?.accounts.find((a) => a.id === replace) ?? null;
  const [region, setRegion] = useState<string>(DEFAULT_REGION);
  const [phase, setPhase] = useState<'idle' | 'waiting' | 'checking'>('idle');
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (replacing && isOciRegion(replacing.region)) setRegion(replacing.region);
  }, [replacing?.id]);

  useEvent('sign-in', (progress) => setPhase(progress.status), []);

  // Leaving the page stops a sign-in that is still open.
  useEffect(() => () => void cctv.cancelSignIn(), []);

  const submit = async (event: TargetedSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    setPhase('waiting');
    try {
      const account = await call(cctv.signIn(region, replace));
      toast.show({ message: 'Oracle account connected.', tone: 'success' });
      afterConnect(account, replace);
    } catch (err) {
      if (!isCancelled(err)) setError(errorText(err));
      setPhase('idle');
    }
  };

  const busy = phase !== 'idle';
  return (
    <FlowPage
      caption={replace ? 'Change Oracle account' : 'Create a free server'}
      title="Sign in with Oracle"
      subtitle="The app gets a sign-in that ends by itself within a day."
      back={{ href: withReplace('/connect', replace), label: 'Back' }}
    >
      <form class="stack-24" onSubmit={submit} noValidate>
        <Section title="Home region" lead={stepLead(1, 'Pick the region you chose when you made the account.')}>
          <div class="stack">
            <FormField label="Home region" hint="Shown at the top of the Oracle Cloud page." error={error}>
              <Select value={region} options={REGION_OPTIONS} onChange={setRegion} disabled={busy} />
            </FormField>
            {busy ? (
              <p class="notice k-body-s text-amber" role="status">
                <Spinner size={16} decorative />
                <span>{phase === 'checking' ? 'Checking your account...' : 'Finish signing in in your browser. This page carries on by itself.'}</span>
              </p>
            ) : (
              <p class="k-body-s">Your browser opens Oracle's sign-in page. The app never sees your Oracle password.</p>
            )}
          </div>
        </Section>
        <div class="actions row-between">
          {busy ? (
            <Button variant="ghost" icon="close" onClick={() => void cctv.cancelSignIn()} disabled={phase === 'checking'}>
              Cancel
            </Button>
          ) : (
            <Button variant="ghost" icon="chevron-left" href={withReplace('/connect', replace)}>
              Back
            </Button>
          )}
          <Button variant="primary" size="l" type="submit" loading={busy} loadingLabel="Signing in...">
            Sign in with Oracle
          </Button>
        </div>
      </form>
    </FlowPage>
  );
}

const CONFIG_PLACEHOLDER = '[DEFAULT]\nuser=ocid1.user.oc1..\nfingerprint=\ntenancy=ocid1.tenancy.oc1..\nregion=';

export function ApiKey({ replace }: { replace: string | null }) {
  const toast = useToast();
  const [configText, setConfigText] = useState('');
  const [keyFile, setKeyFile] = useState<{ token: string; fileName: string } | null>(null);
  const [errors, setErrors] = useState<{ config?: string; key?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);

  const pick = async () => {
    setPicking(true);
    try {
      const choice = await call(cctv.pickKeyFile());
      if (choice) {
        setKeyFile(choice);
        setErrors((e) => ({ ...e, key: undefined }));
      }
    } catch (err) {
      setErrors((e) => ({ ...e, key: errorText(err) }));
    } finally {
      setPicking(false);
    }
  };

  const submit = async (event: TargetedSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next: typeof errors = {};
    if (!configText.trim()) next.config = 'Paste the configuration file preview from Oracle.';
    if (!keyFile) next.key = 'Choose the private key file you downloaded.';
    setErrors(next);
    if (next.config || next.key || !keyFile) return;
    setBusy(true);
    try {
      const account = await call(cctv.addApiKey(configText, keyFile.token, replace));
      toast.show({ message: 'Oracle account connected.', tone: 'success' });
      afterConnect(account, replace);
    } catch (err) {
      const message = errorText(err);
      if (/key file/i.test(message)) setErrors({ key: message });
      else if (/text|line|region/i.test(message)) setErrors({ config: message });
      else setErrors({ form: message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <FlowPage
      caption={replace ? 'Change Oracle account' : 'Create a free server'}
      title="Use an API key"
      subtitle="For people who already work with Oracle API keys."
      back={{ href: withReplace('/connect', replace), label: 'Back' }}
    >
      <form class="stack-24" onSubmit={submit} noValidate>
        <Section title="API key" lead={stepLead(1, "Paste Oracle's text and pick the key file.")}>
          <div class="stack">
            <ol class="steps k-body-s">
              <li>In Oracle Cloud, open your profile, then API keys.</li>
              <li>Choose Add API key, then Download private key, then Add.</li>
              <li>Copy the configuration file preview Oracle shows and paste it below.</li>
            </ol>
            <FormField label="Configuration text" hint="Starts with [DEFAULT]." error={errors.config} required>
              <TextArea value={configText} onInput={setConfigText} placeholder={CONFIG_PLACEHOLDER} disabled={busy} />
            </FormField>
            <FormField label="Private key file" hint="The .pem file Oracle downloaded." error={errors.key} required>
              <div class="desk-file-row">
                <TextInput value={keyFile?.fileName ?? ''} onInput={() => undefined} readOnly placeholder="No file chosen" />
                <Button onClick={() => void pick()} loading={picking} loadingLabel="Choosing..." disabled={busy}>
                  Choose file
                </Button>
              </div>
            </FormField>
            <p class="notice k-body-s">
              <Icon name="shield" size={16} />
              <span>The key is saved locked to your Windows account and never leaves this computer except to sign Oracle requests.</span>
            </p>
            {errors.form && (
              <p class="k-body-s text-error" role="alert">
                {errors.form}
              </p>
            )}
            <div class="actions">
              <Button variant="ghost" icon="info" onClick={() => void cctv.openLink('oracle-api-keys')}>
                How API keys work
              </Button>
            </div>
          </div>
        </Section>
        <div class="actions row-between">
          <Button variant="ghost" icon="chevron-left" href={withReplace('/connect', replace)} disabled={busy}>
            Back
          </Button>
          <Button variant="primary" size="l" type="submit" loading={busy} loadingLabel="Checking...">
            Connect
          </Button>
        </div>
      </form>
    </FlowPage>
  );
}
