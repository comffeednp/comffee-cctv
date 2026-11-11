import type { TargetedSubmitEvent } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { VaultKeysResponse } from '../../../../shared/api-types.ts';
import { Badge, Button, Dialog, EmptyState, FormField, GroupedList, ListRow, PageHeader, PasswordInput, Section, useToast } from '../../components/index.ts';
import { ApiFailure, apiGet, describeError } from '../../lib/api.ts';
import { forgetDeviceKey, listDeviceKeys } from '../../lib/crypto/keystore.ts';
import { importRecoveryFile } from '../../lib/crypto/recovery.ts';
import { browserTimezone, formatDate } from '../../lib/format.ts';
import { isOwner, useMe } from '../../lib/session.ts';
import { PageLoading } from '../../app/Redirect.tsx';

function shortId(keyId: string): string {
  return keyId.slice(0, 8);
}

function errorText(error: unknown): string {
  if (error instanceof ApiFailure) return describeError(error);
  return error instanceof Error && error.message ? error.message : describeError(error);
}

/** Recovery key: which keys this browser holds, adding one from a recovery file, and what losing it means. */
export function RecoveryKeyPage() {
  const { me } = useMe();
  const toast = useToast();
  const owner = isOwner(me);

  const [deviceKeys, setDeviceKeys] = useState<string[] | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [hubKeys, setHubKeys] = useState<VaultKeysResponse | null>(null);
  const [reload, setReload] = useState(0);

  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [importErrors, setImportErrors] = useState<{ file?: string; passphrase?: string }>({});
  const [importing, setImporting] = useState(false);

  const [forgetId, setForgetId] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const [forgetError, setForgetError] = useState<string | undefined>();

  useEffect(() => {
    let live = true;
    listDeviceKeys()
      .then((keys) => {
        if (!live) return;
        setDeviceKeys(keys);
        setDeviceError(null);
      })
      .catch((err) => {
        if (!live) return;
        setDeviceKeys([]);
        setDeviceError(errorText(err));
      });
    apiGet<VaultKeysResponse>('/api/keys/vault')
      .then((keys) => {
        if (live) setHubKeys(keys);
      })
      .catch(() => {
        if (live) setHubKeys({ keys: [], activeKeyId: null });
      });
    return () => {
      live = false;
    };
  }, [reload]);

  const submitImport = async (event: TargetedSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const errors: typeof importErrors = {};
    if (!file) errors.file = 'Choose the recovery file you saved.';
    if (!passphrase) errors.passphrase = 'Type the passphrase of that file.';
    setImportErrors(errors);
    if (!file || Object.keys(errors).length) return;
    setImporting(true);
    try {
      const { keyId } = await importRecoveryFile(file, passphrase);
      setPassphrase('');
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      toast.show({ message: `Key ${shortId(keyId)} added to this browser.`, tone: 'success' });
      setReload((n) => n + 1);
    } catch (err) {
      const message = errorText(err);
      if (/passphrase/i.test(message)) setImportErrors({ passphrase: message });
      else setImportErrors({ file: message });
    } finally {
      setImporting(false);
    }
  };

  const forget = async () => {
    if (!forgetId) return;
    setForgetting(true);
    setForgetError(undefined);
    try {
      await forgetDeviceKey(forgetId);
      toast.show({ message: 'Key removed from this browser.', tone: 'success' });
      setForgetId(null);
      setReload((n) => n + 1);
    } catch (err) {
      setForgetError(errorText(err));
    } finally {
      setForgetting(false);
    }
  };

  const tz = browserTimezone();
  const hubKeyFor = (keyId: string) => hubKeys?.keys.find((key) => key.keyId === keyId);
  const noHubKey = hubKeys !== null && hubKeys.activeKeyId === null;

  return (
    <>
      <PageHeader back={{ href: '/settings', label: 'Settings' }} title="Recovery key" subtitle="The key that unlocks your recordings." />

      <Section title="What it is" lead="Recordings are locked; this key is the only thing that opens them.">
        <div class="stack">
          <p class="k-body">
            Every recording is locked before it is stored, and the hub cannot unlock it. Your recovery key can. It is a
            small file with a passphrase. A browser that has the key opens recordings on its own; another phone or computer
            needs the file and passphrase once.
          </p>
          <p class="k-body">
            If the file is lost and no browser still has the key, nobody can open those recordings, ever. New recordings
            still work. Keep the file in two safe places.
          </p>
        </div>
      </Section>

      {owner && (
        <Section title="New key" lead={noHubKey ? 'Nothing is recorded until a key exists.' : 'For new footage. Older footage keeps its old key.'}>
          <GroupedList label="New key">
            <ListRow
              icon="key"
              title={noHubKey ? 'Make your recovery key' : 'Make a new recovery key'}
              secondary={noHubKey ? 'Takes a minute: a passphrase and a file to keep' : 'Older footage still needs the older key file'}
              trailing={noHubKey ? <Badge tone="amber">Not made</Badge> : undefined}
              href="/settings/recovery-key/new"
            />
          </GroupedList>
        </Section>
      )}

      <Section title="On this device" lead="Keys this browser holds. It can open recordings made with them.">
        {deviceKeys === null ? (
          <PageLoading label="Checking this browser" />
        ) : deviceError ? (
          <p class="k-body-s text-error" role="alert">
            {deviceError}
          </p>
        ) : deviceKeys.length === 0 ? (
          <EmptyState icon="key" title="No key on this device" message="Add one from your recovery file below to open recordings here." />
        ) : (
          <GroupedList label="Keys on this device">
            {deviceKeys.map((keyId) => {
              const info = hubKeyFor(keyId);
              return (
                <ListRow
                  key={keyId}
                  icon="key"
                  title={`Key ${shortId(keyId)}`}
                  secondary={info ? `Made ${formatDate(info.createdAt, tz)}` : 'Not known to this hub'}
                  trailing={info?.active ? <Badge tone="ok">In use</Badge> : undefined}
                  onClick={() => setForgetId(keyId)}
                  linkTitle={`Remove key ${shortId(keyId)} from this browser`}
                />
              );
            })}
          </GroupedList>
        )}
      </Section>

      <Section title="Add from a file" lead="Open your recovery file so this device can play recordings.">
        <form class="stack" onSubmit={submitImport} noValidate>
          <FormField label="Recovery file" hint={file ? file.name : 'The .json file you saved at setup.'} error={importErrors.file}>
            <div class="actions">
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                class="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(event) => {
                  setFile(event.currentTarget.files?.[0] ?? null);
                  setImportErrors({});
                }}
              />
              <Button icon="download" onClick={() => fileRef.current?.click()}>
                {file ? 'Choose another file' : 'Choose file'}
              </Button>
            </div>
          </FormField>
          <FormField label="Passphrase" error={importErrors.passphrase}>
            <PasswordInput value={passphrase} onInput={setPassphrase} autoComplete="off" />
          </FormField>
          <div class="actions">
            <Button variant="primary" type="submit" icon="key" loading={importing} loadingLabel="Opening...">
              Add key
            </Button>
          </div>
        </form>
      </Section>


      <Dialog
        open={forgetId !== null}
        tone="danger"
        title="Remove this key from this browser?"
        message="Recordings made with it will not open here until you add it again from the recovery file. The file itself is not touched."
        confirmLabel="Remove key"
        busyLabel="Removing..."
        busy={forgetting}
        error={forgetError}
        onConfirm={() => void forget()}
        onCancel={() => {
          setForgetId(null);
          setForgetError(undefined);
        }}
      />
    </>
  );
}
