// Make a new recovery key (owner), one step per screen: choose a passphrase (the browser makes the key and
// offers its file), then save the file and confirm with the owner password. New footage is locked with the
// new key; older footage still needs the older key file.

import type { TargetedSubmitEvent } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { RECOVERY_PASSPHRASE_MIN_LENGTH } from '../../../../shared/api-types.ts';
import type { SetVaultKeyRequest, VaultKeyInfo, VaultKeysResponse } from '../../../../shared/api-types.ts';
import { Button, EmptyState, FormField, Icon, PageHeader, PasswordInput, Section, useToast } from '../../components/index.ts';
import { ApiFailure, apiGet, apiSend, describeError } from '../../lib/api.ts';
import { createRecoveryKey } from '../../lib/crypto/recovery.ts';
import type { CreatedRecoveryKey } from '../../lib/crypto/recovery.ts';
import { navigate } from '../../lib/router.ts';
import { isOwner, refreshSetupStatus, useMe } from '../../lib/session.ts';
import { saveBlob } from '../../app/download.ts';

type Step = 'passphrase' | 'save';
const TOTAL_STEPS = 2;

function stepLead(step: number, text: string): string {
  return `Step ${step} of ${TOTAL_STEPS}. ${text}`;
}

function errorText(error: unknown): string {
  if (error instanceof ApiFailure) return describeError(error);
  return error instanceof Error && error.message ? error.message : describeError(error);
}

export function NewRecoveryKeyPage() {
  const { me } = useMe();
  const toast = useToast();

  // Whether a key is in use already (then this is a change of key, and the warning applies).
  const [replacing, setReplacing] = useState<boolean | null>(null);
  const [step, setStep] = useState<Step>('passphrase');
  const [passphrase, setPassphrase] = useState('');
  const [passphraseConfirm, setPassphraseConfirm] = useState('');
  const [keyErrors, setKeyErrors] = useState<{ passphrase?: string; confirm?: string; form?: string }>({});
  const [created, setCreated] = useState<CreatedRecoveryKey | null>(null);
  const [saved, setSaved] = useState(false);
  const [password, setPassword] = useState('');
  const [saveErrors, setSaveErrors] = useState<{ password?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    apiGet<VaultKeysResponse>('/api/keys/vault')
      .then((keys) => {
        if (live) setReplacing(keys.activeKeyId !== null);
      })
      .catch(() => {
        // Not known: show the warning, it is true whenever a key exists.
        if (live) setReplacing(true);
      });
    return () => {
      live = false;
    };
  }, []);

  const header = (
    <PageHeader
      back={{ href: '/settings/recovery-key', label: 'Recovery key' }}
      title="New recovery key"
      subtitle="New footage is locked with the new key."
    />
  );

  if (!isOwner(me)) {
    return (
      <>
        {header}
        <EmptyState icon="shield" title="Owner only" message="Only the owner can make a recovery key." />
      </>
    );
  }

  const submitPassphrase = async (event: TargetedSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const errors: typeof keyErrors = {};
    if (passphrase.length < RECOVERY_PASSPHRASE_MIN_LENGTH) errors.passphrase = `Use at least ${RECOVERY_PASSPHRASE_MIN_LENGTH} characters.`;
    else if (passphraseConfirm !== passphrase) errors.confirm = 'The two passphrases are not the same.';
    setKeyErrors(errors);
    if (Object.keys(errors).length) return;
    setBusy(true);
    try {
      const key = await createRecoveryKey(passphrase);
      setCreated(key);
      saveBlob(key.recoveryFile, key.fileName);
      setPassphrase('');
      setPassphraseConfirm('');
      setSaved(false);
      setSaveErrors({});
      setStep('save');
      window.scrollTo(0, 0);
    } catch (err) {
      setKeyErrors({ form: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const submitSave = async (event: TargetedSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!created || !saved) return;
    if (!password) {
      setSaveErrors({ password: 'Type your password.' });
      return;
    }
    setBusy(true);
    try {
      const body: SetVaultKeyRequest = { spkiB64: created.spkiB64, password };
      await apiSend<VaultKeyInfo>('PUT', '/api/keys/vault', body);
      setPassword('');
      setSaveErrors({});
      await refreshSetupStatus();
      toast.show({ message: replacing ? 'New recovery key in use. Keep the old key file too.' : 'Recovery key in use.', tone: 'success' });
      navigate('/settings/recovery-key', { replace: true });
    } catch (err) {
      if (err instanceof ApiFailure && err.code === 'wrong_password') {
        setSaveErrors({ password: 'That password is not right. Type your own password.' });
      } else {
        setSaveErrors({ form: describeError(err) });
      }
    } finally {
      setBusy(false);
    }
  };

  if (step === 'passphrase') {
    return (
      <>
        {header}
        <form class="stack-24" onSubmit={(event) => void submitPassphrase(event)} noValidate>
          <Section title="Passphrase" lead={stepLead(1, 'Choose the passphrase that protects the new key file.')}>
            <div class="stack">
              {replacing !== false && (
                <p class="notice k-body-s text-amber" role="note">
                  <Icon name="warning" size={18} />
                  <span>Older footage still needs the older key file. Keep that file: the new key cannot open it.</span>
                </p>
              )}
              <p class="k-body">
                Your browser makes the new key and downloads its file. This browser also keeps a locked copy, so footage
                opens here without the file.
              </p>
              <FormField
                label="Passphrase"
                hint={`At least ${RECOVERY_PASSPHRASE_MIN_LENGTH} characters. Not your sign-in password.`}
                error={keyErrors.passphrase}
                required
              >
                <PasswordInput
                  value={passphrase}
                  onInput={setPassphrase}
                  autoComplete="new-password"
                  minLength={RECOVERY_PASSPHRASE_MIN_LENGTH}
                  autoFocus
                  required
                />
              </FormField>
              <FormField label="Passphrase again" error={keyErrors.confirm} required>
                <PasswordInput value={passphraseConfirm} onInput={setPassphraseConfirm} autoComplete="new-password" required />
              </FormField>
              {keyErrors.form && (
                <p class="k-body-s text-error" role="alert">
                  {keyErrors.form}
                </p>
              )}
            </div>
          </Section>
          <div class="actions row-between">
            <Button variant="ghost" icon="chevron-left" href="/settings/recovery-key" disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" size="l" type="submit" icon="key" loading={busy} loadingLabel="Making the key...">
              Make new key
            </Button>
          </div>
        </form>
      </>
    );
  }

  return (
    <>
      {header}
      <form class="stack-24" onSubmit={(event) => void submitSave(event)} noValidate>
        <Section title="Save the file" lead={stepLead(2, 'Put the new key file somewhere safe, then start using it.')}>
          <div class="stack">
            <p class="k-body">
              Your browser downloaded <span class="mono text-cream">{created?.fileName}</span>. Move it out of the downloads
              folder to a safe place, and keep a second copy if you can.
            </p>
            {replacing !== false && (
              <p class="k-body-s">Keep your older key file as well. Footage recorded before this change opens only with it.</p>
            )}
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
            <FormField label="Your password" hint="Your own sign-in password, to confirm it is you." error={saveErrors.password} required>
              <PasswordInput value={password} onInput={setPassword} autoComplete="current-password" required />
            </FormField>
            {saveErrors.form && (
              <p class="k-body-s text-error" role="alert">
                {saveErrors.form}
              </p>
            )}
          </div>
        </Section>
        <div class="actions row-between">
          <Button variant="ghost" icon="chevron-left" onClick={() => setStep('passphrase')} disabled={busy}>
            Back
          </Button>
          <Button variant="primary" size="l" type="submit" icon="check" disabled={!saved} loading={busy} loadingLabel="Saving...">
            Use new key
          </Button>
        </div>
      </form>
    </>
  );
}
