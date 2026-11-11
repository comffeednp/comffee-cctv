import type { TargetedSubmitEvent } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { PASSWORD_MIN_LENGTH, RECOVERY_PASSPHRASE_MIN_LENGTH } from '../../../../shared/api-types.ts';
import type { Me, SetVaultKeyRequest, SetupOwnerRequest, TotpEnrollment as Enrollment, TotpRequest, VaultKeyInfo } from '../../../../shared/api-types.ts';
import { Button, Card, FormField, PageHeader, PasswordInput, Section, TextInput } from '../../components/index.ts';
import { ApiFailure, apiSend, describeError } from '../../lib/api.ts';
import { createRecoveryKey } from '../../lib/crypto/recovery.ts';
import type { CreatedRecoveryKey } from '../../lib/crypto/recovery.ts';
import { isOwner, refreshSetupStatus, setMe, useMe, useSetupStatus } from '../../lib/session.ts';
import { saveBlob } from '../../app/download.ts';
import { Redirect } from '../../app/Redirect.tsx';
import { CodeField, TotpEnrollment, isFullCode } from '../../app/TotpParts.tsx';

type Step = 'code' | 'account' | 'totp' | 'recovery' | 'save' | 'done';
const TOTAL_STEPS = 5;

function stepLead(step: number, text: string): string {
  return `Step ${step} of ${TOTAL_STEPS}. ${text}`;
}

function errorText(error: unknown): string {
  return error instanceof Error && !(error instanceof ApiFailure) && error.message ? error.message : describeError(error);
}

/** Longest value taken from a setup link; a real code is far shorter. */
const MAX_LINK_CODE_LENGTH = 64;

/** The setup code from a link like /setup#code=ABC123, or ''. The fragment never reaches the hub's logs. */
function codeFromHash(): string {
  if (typeof window === 'undefined' || !window.location.hash) return '';
  try {
    const code = new URLSearchParams(window.location.hash.slice(1)).get('code') ?? '';
    return code.replace(/\s+/g, '').slice(0, MAX_LINK_CODE_LENGTH);
  } catch {
    return '';
  }
}

/** First-time setup, one step per screen: setup code, owner account, 2-step, recovery key, save the file. */
export function SetupPage() {
  const setup = useSetupStatus();
  const session = useMe();

  // Decided once: later status refreshes must not throw the owner out of the flow halfway.
  const [start] = useState<Step | 'login' | 'live'>(() => {
    if (setup.status?.needsSetup) return 'code';
    if (!session.me) return 'login';
    if (isOwner(session.me) && !setup.status?.hasVaultKey) return 'recovery';
    return 'live';
  });
  const [step, setStep] = useState<Step>(start === 'login' || start === 'live' ? 'code' : start);

  const [setupCode, setSetupCode] = useState(codeFromHash);
  const [codeFromLink] = useState(() => setupCode !== '');
  const [codeError, setCodeError] = useState<string | undefined>();

  // Take the code out of the address bar and history once it is read, so it is not left behind.
  useEffect(() => {
    if (!window.location.hash) return;
    if (!new URLSearchParams(window.location.hash.slice(1)).has('code')) return;
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  }, []);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [accountErrors, setAccountErrors] = useState<{ username?: string; password?: string; confirm?: string; form?: string }>({});

  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [totpError, setTotpError] = useState<string | undefined>();
  const [totpExpired, setTotpExpired] = useState(false);

  const [passphrase, setPassphrase] = useState('');
  const [passphraseConfirm, setPassphraseConfirm] = useState('');
  const [recoveryErrors, setRecoveryErrors] = useState<{ passphrase?: string; confirm?: string; form?: string }>({});
  const [created, setCreated] = useState<CreatedRecoveryKey | null>(null);

  const [saved, setSaved] = useState(false);
  // The owner password is kept in memory only while this page is open, for the recovery key step.
  const [ownerPassword, setOwnerPassword] = useState('');
  const [askPassword, setAskPassword] = useState(start === 'recovery');
  const [saveErrors, setSaveErrors] = useState<{ password?: string; form?: string }>({});

  const [busy, setBusy] = useState(false);

  if (start === 'login') return <Redirect to="/login" />;
  if (start === 'live') return <Redirect to="/live" />;

  const submitCode = (event: TargetedSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!setupCode.trim()) {
      setCodeError('Type the setup code from your hub.');
      return;
    }
    setCodeError(undefined);
    setStep('account');
  };

  const submitAccount = async (event: TargetedSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const errors: typeof accountErrors = {};
    if (!username.trim()) errors.username = 'Choose a username.';
    if (password.length < PASSWORD_MIN_LENGTH) errors.password = `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
    else if (confirm !== password) errors.confirm = 'The two passwords are not the same.';
    setAccountErrors(errors);
    if (Object.keys(errors).length) return;
    setBusy(true);
    try {
      const body: SetupOwnerRequest = { setupCode: setupCode.trim(), username: username.trim(), password };
      const result = await apiSend<Enrollment>('POST', '/api/setup/owner', body);
      setEnrollment(result);
      setOwnerPassword(password);
      setAskPassword(false);
      setPassword('');
      setConfirm('');
      setStep('totp');
      void refreshSetupStatus();
    } catch (err) {
      const message = describeError(err);
      if (err instanceof ApiFailure && err.code === 'invalid_input' && /setup code/i.test(err.message)) {
        setCodeError(message);
        setStep('code');
      } else if (err instanceof ApiFailure && err.code === 'invalid_input' && /username/i.test(err.message)) {
        setAccountErrors({ username: message });
      } else if (err instanceof ApiFailure && err.code === 'invalid_input' && /password/i.test(err.message)) {
        setAccountErrors({ password: message });
      } else if (err instanceof ApiFailure && err.code === 'conflict') {
        setAccountErrors({ form: 'This hub already has an owner. Sign in instead.' });
      } else {
        setAccountErrors({ form: message });
      }
    } finally {
      setBusy(false);
    }
  };

  const submitTotp = async (event: TargetedSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!enrollment) return;
    if (!isFullCode(totpCode)) {
      setTotpError('Type the 6 digits the app shows.');
      return;
    }
    setBusy(true);
    try {
      const body: TotpRequest = { challenge: enrollment.challenge, code: totpCode };
      const me = await apiSend<Me>('POST', '/api/auth/totp', body);
      setMe(me);
      setTotpError(undefined);
      setStep('recovery');
    } catch (err) {
      if (err instanceof ApiFailure && err.code === 'challenge_expired') {
        setTotpExpired(true);
        setTotpError('This step took longer than 5 minutes. Sign in to finish setting up.');
      } else {
        setTotpError(
          describeError(err, { wrong_credentials: 'That code is not right. Check that your phone shows the right time, then type the newest code.' }),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const submitRecovery = async (event: TargetedSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const errors: typeof recoveryErrors = {};
    if (passphrase.length < RECOVERY_PASSPHRASE_MIN_LENGTH) errors.passphrase = `Use at least ${RECOVERY_PASSPHRASE_MIN_LENGTH} characters.`;
    else if (passphraseConfirm !== passphrase) errors.confirm = 'The two passphrases are not the same.';
    setRecoveryErrors(errors);
    if (Object.keys(errors).length) return;
    setBusy(true);
    try {
      const key = await createRecoveryKey(passphrase);
      setCreated(key);
      saveBlob(key.recoveryFile, key.fileName);
      setPassphrase('');
      setPassphraseConfirm('');
      setSaved(false);
      setStep('save');
    } catch (err) {
      setRecoveryErrors({ form: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const submitSave = async (event: TargetedSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!created || !saved) return;
    if (askPassword && !ownerPassword) {
      setSaveErrors({ password: 'Type your owner password.' });
      return;
    }
    setBusy(true);
    try {
      const body: SetVaultKeyRequest = { spkiB64: created.spkiB64, password: ownerPassword };
      await apiSend<VaultKeyInfo>('PUT', '/api/keys/vault', body);
      setOwnerPassword('');
      setSaveErrors({});
      await refreshSetupStatus();
      setStep('done');
    } catch (err) {
      if (err instanceof ApiFailure && err.code === 'wrong_password') {
        setAskPassword(true);
        setSaveErrors({ password: 'That password is not right. Type your owner password.' });
      } else {
        setSaveErrors({ form: describeError(err) });
      }
    } finally {
      setBusy(false);
    }
  };

  let body;
  if (step === 'code') {
    body = (
      <form class="stack-24" onSubmit={submitCode} noValidate>
        <Section title="Setup code" lead={stepLead(1, 'Type the code your hub printed when it was installed.')}>
          <div class="stack">
            <FormField
              label="Setup code"
              hint={
                codeFromLink && setupCode
                  ? 'Filled in from your setup link. Press Next.'
                  : 'Lost it? Run the setup-code command on the hub for a new one.'
              }
              error={codeError}
              required
            >
              <TextInput
                value={setupCode}
                onInput={setSetupCode}
                mono
                autoComplete="off"
                autoCapitalize="characters"
                spellcheck={false}
                autoFocus
                required
              />
            </FormField>
            <p class="footnote">A setup code works once. A code the hub prints lasts 24 hours; one made by the desktop app lasts 30 days.</p>
          </div>
        </Section>
        <div class="actions actions-end">
          <Button variant="primary" size="l" type="submit">
            Next
          </Button>
        </div>
      </form>
    );
  } else if (step === 'account') {
    body = (
      <form class="stack-24" onSubmit={submitAccount} noValidate>
        <Section title="Owner account" lead={stepLead(2, 'Choose the username and password you will sign in with.')}>
          <div class="stack">
            <FormField label="Username" hint="Letters, digits, dot, dash or underscore." error={accountErrors.username} required>
              <TextInput
                value={username}
                onInput={setUsername}
                autoComplete="username"
                autoCapitalize="none"
                spellcheck={false}
                autoFocus
                required
              />
            </FormField>
            <FormField label="Password" hint={`At least ${PASSWORD_MIN_LENGTH} characters. A short sentence works well.`} error={accountErrors.password} required>
              <PasswordInput value={password} onInput={setPassword} autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} required />
            </FormField>
            <FormField label="Password again" error={accountErrors.confirm} required>
              <PasswordInput value={confirm} onInput={setConfirm} autoComplete="new-password" required />
            </FormField>
            {accountErrors.form && <p class="k-body-s text-error" role="alert">{accountErrors.form}</p>}
          </div>
        </Section>
        <div class="actions row-between">
          <Button variant="ghost" icon="chevron-left" onClick={() => setStep('code')} disabled={busy}>
            Back
          </Button>
          <Button variant="primary" size="l" type="submit" loading={busy} loadingLabel="Creating...">
            Create account
          </Button>
        </div>
      </form>
    );
  } else if (step === 'totp') {
    body = (
      <form class="stack-24" onSubmit={submitTotp} noValidate>
        <Section title="2-step sign-in" lead={stepLead(3, 'Link an authenticator app, so a password alone is never enough.')}>
          <div class="stack">
            {enrollment && <TotpEnrollment otpauthUrl={enrollment.otpauthUrl} secretBase32={enrollment.secretBase32} />}
            <CodeField value={totpCode} onInput={setTotpCode} error={totpError} />
          </div>
        </Section>
        <div class="actions actions-end">
          {totpExpired ? (
            <Button variant="primary" size="l" href="/login">
              Sign in
            </Button>
          ) : (
            <Button variant="primary" size="l" type="submit" loading={busy} loadingLabel="Checking...">
              Next
            </Button>
          )}
        </div>
      </form>
    );
  } else if (step === 'recovery') {
    body = (
      <form class="stack-24" onSubmit={submitRecovery} noValidate>
        <Section title="Recovery key" lead={stepLead(4, 'Make the key that unlocks your recordings.')}>
          <div class="stack">
            <p class="k-body">
              Every recording is locked before it is stored. Only your recovery key can unlock it. The hub never has
              this key, so nobody who gets into the hub can watch your recordings.
            </p>
            <p class="k-body">
              You will get a small file, protected by a passphrase you choose now. This browser also keeps a locked copy,
              so recordings open here without the file.
            </p>
            <p class="k-body">
              Keep the file somewhere safe, like a USB stick or your password manager. If the file is lost or the
              passphrase is forgotten, those recordings can never be opened by anyone.
            </p>
            <FormField
              label="Passphrase"
              hint={`At least ${RECOVERY_PASSPHRASE_MIN_LENGTH} characters. Not your sign-in password.`}
              error={recoveryErrors.passphrase}
              required
            >
              <PasswordInput value={passphrase} onInput={setPassphrase} autoComplete="new-password" minLength={RECOVERY_PASSPHRASE_MIN_LENGTH} autoFocus required />
            </FormField>
            <FormField label="Passphrase again" error={recoveryErrors.confirm} required>
              <PasswordInput value={passphraseConfirm} onInput={setPassphraseConfirm} autoComplete="new-password" required />
            </FormField>
            {recoveryErrors.form && <p class="k-body-s text-error" role="alert">{recoveryErrors.form}</p>}
          </div>
        </Section>
        <div class="actions actions-end">
          <Button variant="primary" size="l" type="submit" icon="key" loading={busy} loadingLabel="Making the key...">
            Create recovery key
          </Button>
        </div>
      </form>
    );
  } else if (step === 'save') {
    body = (
      <form class="stack-24" onSubmit={submitSave} noValidate>
        <Section title="Save the file" lead={stepLead(5, 'Put the recovery file somewhere safe, then finish.')}>
          <div class="stack">
            <p class="k-body">
              Your browser downloaded <span class="mono text-cream">{created?.fileName}</span>. Move it out of the
              downloads folder to a safe place, and keep a second copy if you can.
            </p>
            <div class="actions">
              <Button
                icon="download"
                onClick={() => {
                  if (created) saveBlob(created.recoveryFile, created.fileName);
                }}
              >
                Download again
              </Button>
            </div>
            <label class="check k-body">
              <input type="checkbox" checked={saved} onChange={(event) => setSaved(event.currentTarget.checked)} />
              <span>I saved the file and I will remember the passphrase.</span>
            </label>
            {askPassword && (
              <FormField label="Your password" hint="Your owner password, to confirm it is you." error={saveErrors.password} required>
                <PasswordInput value={ownerPassword} onInput={setOwnerPassword} autoComplete="current-password" required />
              </FormField>
            )}
            {saveErrors.form && <p class="k-body-s text-error" role="alert">{saveErrors.form}</p>}
          </div>
        </Section>
        <div class="actions row-between">
          <Button variant="ghost" icon="chevron-left" onClick={() => setStep('recovery')} disabled={busy}>
            Back
          </Button>
          <Button variant="primary" size="l" type="submit" disabled={!saved} loading={busy} loadingLabel="Finishing...">
            Finish setup
          </Button>
        </div>
      </form>
    );
  } else {
    body = (
      <div class="stack-24">
        <Section title="All set" lead="Your hub is ready. Next, add the place where your cameras are.">
          <p class="k-body">
            Recording starts once a location and its cameras are added. You can sign in from any phone or computer.
          </p>
        </Section>
        <div class="actions actions-end">
          <Button variant="primary" size="l" icon="plus" href="/locations/new">
            Add location
          </Button>
        </div>
      </div>
    );
  }

  return (
    <main id="main" class="app-main auth-main">
      <PageHeader caption="First-time setup" title="Set up your hub" subtitle="About five minutes. Keep your phone nearby." />
      <Card>{body}</Card>
    </main>
  );
}
