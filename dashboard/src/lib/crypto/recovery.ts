// The owner's recording key pair. The browser makes it, the hub only ever gets the public half, and the
// private half lives in a passphrase-protected recovery file (contract section 11) plus, locked, in this
// browser's key store.

import {
  RECOVERY_PASSPHRASE_MIN,
  bytesToBase64,
  createRecoveryFile,
  exportSpki,
  generateVaultKeyPair,
  keyIdFromSpki,
  openRecoveryFile,
} from '../../../../shared/vault-format.ts';
import { saveKey } from './keystore.ts';

/** Largest file accepted as a recovery file (a real one is about 4 KB). */
const MAX_RECOVERY_FILE_BYTES = 64 * 1024;

export type RecoveryErrorReason = 'passphrase-too-short' | 'not-a-recovery-file' | 'wrong-passphrase' | 'key-mismatch' | 'storage' | 'unsupported';

/** Every failure of this module, with a sentence that can be shown as is. */
export class RecoveryError extends Error {
  readonly reason: RecoveryErrorReason;

  constructor(reason: RecoveryErrorReason, message: string) {
    super(message);
    this.name = 'RecoveryError';
    this.reason = reason;
  }
}

export interface CreatedRecoveryKey {
  /** 32 hex characters; the hub lists the key under this id. */
  keyId: string;
  /** Public key, SPKI DER base64, for PUT /api/keys/vault. */
  spkiB64: string;
  /** The recovery file to download and keep safe. */
  recoveryFile: Blob;
  fileName: string;
}

function checkPassphrase(passphrase: string): void {
  if (passphrase.length < RECOVERY_PASSPHRASE_MIN) {
    throw new RecoveryError('passphrase-too-short', `Use a passphrase of at least ${RECOVERY_PASSPHRASE_MIN} characters.`);
  }
}

function checkCrypto(): void {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new RecoveryError('unsupported', 'This browser cannot do this. Open the dashboard over https in an up-to-date browser.');
  }
}

async function keep(keyId: string, key: CryptoKey): Promise<void> {
  try {
    await saveKey(keyId, key);
  } catch (err) {
    throw new RecoveryError('storage', err instanceof Error && err.message ? err.message : 'This browser could not keep the key.');
  }
}

/**
 * Makes a new RSA-OAEP 3072 / SHA-256 recording key pair, builds its recovery file and keeps the private key
 * (locked, non-extractable) in this browser. The caller sends `spkiB64` to the hub and offers the file for
 * download. The key kept in the browser is the one read back from the new recovery file, which proves the
 * file opens with this passphrase before anyone relies on it.
 */
export async function createRecoveryKey(passphrase: string): Promise<CreatedRecoveryKey> {
  checkPassphrase(passphrase);
  checkCrypto();
  const pair = await generateVaultKeyPair();
  const spki = await exportSpki(pair.publicKey);
  const keyId = await keyIdFromSpki(spki);
  const file = await createRecoveryFile(pair.privateKey, keyId, passphrase);
  const reopened = await openRecoveryFile(file, passphrase, false);
  if (reopened.keyId !== keyId) throw new RecoveryError('key-mismatch', 'The new recovery file did not check out. Try again.');
  await keep(keyId, reopened.privateKey);
  const recoveryFile = new Blob([JSON.stringify(file, null, 2) + '\n'], { type: 'application/json' });
  const date = file.createdAt.slice(0, 10);
  return {
    keyId,
    spkiB64: bytesToBase64(spki),
    recoveryFile,
    fileName: `comffee-cctv-recovery-key-${date}-${keyId.slice(0, 8)}.json`,
  };
}

/**
 * Opens a recovery file with its passphrase and keeps the private key (locked) in this browser, so
 * recordings made with that key open here.
 */
export async function importRecoveryFile(file: File, passphrase: string): Promise<{ keyId: string }> {
  checkCrypto();
  if (!passphrase) throw new RecoveryError('wrong-passphrase', 'Type the passphrase of the recovery file.');
  if (file.size === 0 || file.size > MAX_RECOVERY_FILE_BYTES) {
    throw new RecoveryError('not-a-recovery-file', 'That is not a Comffee CCTV recovery file. Choose the .json file you saved.');
  }
  let value: unknown;
  try {
    value = JSON.parse(await file.text());
  } catch {
    throw new RecoveryError('not-a-recovery-file', 'That is not a Comffee CCTV recovery file. Choose the .json file you saved.');
  }
  let opened: { keyId: string; privateKey: CryptoKey };
  try {
    opened = await openRecoveryFile(value, passphrase, false);
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (message.startsWith('Not a Comffee CCTV recovery file')) {
      throw new RecoveryError('not-a-recovery-file', 'That is not a Comffee CCTV recovery file. Choose the .json file you saved.');
    }
    if (message.startsWith('Recovery file key does not match')) {
      throw new RecoveryError('key-mismatch', 'This recovery file is damaged: its key does not match its id.');
    }
    throw new RecoveryError('wrong-passphrase', 'Wrong passphrase, or the file is damaged. Check the passphrase and try again.');
  }
  await keep(opened.keyId, opened.privateKey);
  return { keyId: opened.keyId };
}
