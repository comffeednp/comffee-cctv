// Shown with the player when this browser does not hold the private key the footage was locked with:
// pick the recovery file, type its passphrase, and the key is kept (locked) on this device.

import { useRef, useState } from 'preact/hooks';
import type { TargetedEvent } from 'preact';
import type { VaultKeyInfo } from '../../../../shared/api-types.ts';
import { Button, FormField, PasswordInput } from '../../components/index.ts';
import { formatDate } from '../../lib/format.ts';
import { RecoveryError, importRecoveryFile } from '../../lib/crypto/recovery.ts';

export interface KeyImportProps {
  /** keyId the recording needs. */
  keyId: string;
  /** All recording keys the hub knows, to say which file is needed. */
  keys: readonly VaultKeyInfo[] | null;
  owner: boolean;
  /** Called after a key was kept; `matches` is false when it was a different key than the one needed. */
  onImported: (matches: boolean) => void;
}

export function KeyImport({ keyId, keys, owner, onImported }: KeyImportProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [fileError, setFileError] = useState<string | undefined>();
  const [passError, setPassError] = useState<string | undefined>();

  const needed = keys?.find((key) => key.keyId === keyId);
  const which = needed ? `the recovery file made on ${formatDate(needed.createdAt)}` : 'its recovery file';

  const onPick = (event: TargetedEvent<HTMLInputElement, Event>) => {
    const picked = event.currentTarget.files?.[0] ?? null;
    setFile(picked);
    setFileError(undefined);
    event.currentTarget.value = '';
  };

  const unlock = async (event: Event) => {
    event.preventDefault();
    setFileError(undefined);
    setPassError(undefined);
    if (!file) {
      setFileError('Choose the recovery file first.');
      return;
    }
    if (!passphrase) {
      setPassError('Type the passphrase of the recovery file.');
      return;
    }
    setBusy(true);
    try {
      const result = await importRecoveryFile(file, passphrase);
      setPassphrase('');
      onImported(result.keyId === keyId);
    } catch (err) {
      if (err instanceof RecoveryError && err.reason === 'wrong-passphrase') setPassError(err.message);
      else setFileError(err instanceof Error && err.message ? err.message : 'That file could not be read. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="stack" onSubmit={(event) => void unlock(event)}>
      <p class="k-body">
        This footage is locked with a recovery key that is not on this device yet.{' '}
        {owner ? `Open ${which} to watch it here.` : `Ask the owner for ${which} and its passphrase.`}
      </p>
      <div class="stack-8">
        <span class="k-body-s">Recovery file</span>
        <div class="row wrap">
          <input
            ref={inputRef}
            type="file"
            accept=".json,application/json"
            class="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={onPick}
          />
          <Button icon="key" onClick={() => inputRef.current?.click()} disabled={busy}>
            {file ? 'Choose another file' : 'Choose file'}
          </Button>
          {file ? <span class="k-body-s text-cream truncate">{file.name}</span> : null}
        </div>
        {fileError ? (
          <p class="k-xs text-error" role="alert">
            {fileError}
          </p>
        ) : null}
      </div>
      <FormField label="Passphrase" hint="The passphrase chosen when the recovery key was made." error={passError}>
        <PasswordInput value={passphrase} onInput={setPassphrase} autoComplete="off" disabled={busy} />
      </FormField>
      <div class="row wrap">
        <Button variant="primary" type="submit" icon="key" loading={busy} loadingLabel="Unlocking...">
          Unlock recordings
        </Button>
      </div>
      <p class="footnote">The key stays locked in this browser and is never sent to the hub.</p>
    </form>
  );
}
