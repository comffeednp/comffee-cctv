/**
 * CCV1 vault writer for Node (see shared/vault-format.ts for the byte layout).
 *
 * Streams the plaintext file in chunkSize pieces with node:crypto, so a segment is never held in
 * memory as a whole. Output goes to "<dest>.part" first and is renamed into place once complete.
 */

import { constants, createCipheriv, createHash, createPublicKey, publicEncrypt, randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import {
  AES_KEY_BYTES,
  CHUNK_SIZE,
  KEY_ID_BYTES,
  NONCE_PREFIX_BYTES,
  TAG_BYTES,
  chunkAad,
  chunkNonce,
  encodeHeader,
} from '../../../shared/vault-format.ts';
import type { VaultMeta } from '../../../shared/vault-format.ts';

/** An imported vault public key with its keyId (hex). */
export interface VaultPublicKey {
  keyId: string;
  key: KeyObject;
}

/** keyId: hex of the first 16 bytes of SHA-256 over the SPKI DER bytes. */
export function vaultKeyIdFromSpki(spkiDer: Uint8Array): string {
  return createHash('sha256').update(spkiDer).digest().subarray(0, KEY_ID_BYTES).toString('hex');
}

/** Imports a vault public key from SPKI DER base64 (as stored in vault_keys.spki_b64). */
export function loadVaultPublicKey(spkiB64: string): VaultPublicKey {
  const der = Buffer.from(spkiB64, 'base64');
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'rsa') throw new Error('Vault key is not an RSA key');
  return { keyId: vaultKeyIdFromSpki(der), key };
}

/** Reads until `buf` is full or the file ends; returns the number of bytes read. */
async function readFull(fh: FileHandle, buf: Buffer): Promise<number> {
  let filled = 0;
  while (filled < buf.length) {
    const { bytesRead } = await fh.read(buf, filled, buf.length - filled, null);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled;
}

async function writeAll(fh: FileHandle, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await fh.write(data, offset, data.length - offset, null);
    offset += bytesWritten;
  }
}

/**
 * Encrypts `srcPath` into a CCV1 file at `destPath` (parent folders are created, mode 0700/0600).
 * Returns the encrypted size and the number of plaintext bytes read.
 */
export async function encryptFileToVault(
  srcPath: string,
  destPath: string,
  publicKey: VaultPublicKey,
  meta: VaultMeta,
  chunkSize: number = CHUNK_SIZE,
): Promise<{ sizeBytes: number; plainBytes: number }> {
  const rawKey = randomBytes(AES_KEY_BYTES);
  try {
    const wrappedKey = publicEncrypt(
      { key: publicKey.key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      rawKey,
    );
    const noncePrefix = randomBytes(NONCE_PREFIX_BYTES);
    const headerBytes = encodeHeader({ keyId: publicKey.keyId, wrappedKey, noncePrefix, chunkSize, meta });

    await mkdir(path.dirname(destPath), { recursive: true, mode: 0o700 });
    const tmpPath = `${destPath}.part`;
    const src = await open(srcPath, 'r');
    let dst: FileHandle | undefined;
    try {
      dst = await open(tmpPath, 'w', 0o600);
      await writeAll(dst, headerBytes);
      let sizeBytes = headerBytes.length;
      let plainBytes = 0;
      const buf = Buffer.allocUnsafe(chunkSize);
      for (let index = 0; ; index++) {
        const n = await readFull(src, buf);
        // Only the last chunk is shorter than chunkSize (it may be empty).
        const isLast = n < chunkSize;
        const cipher = createCipheriv('aes-256-gcm', rawKey, chunkNonce(noncePrefix, index), {
          authTagLength: TAG_BYTES,
        });
        cipher.setAAD(chunkAad(headerBytes, index, isLast));
        const body = cipher.update(buf.subarray(0, n));
        const rest = cipher.final();
        await writeAll(dst, body);
        if (rest.length > 0) await writeAll(dst, rest);
        await writeAll(dst, cipher.getAuthTag());
        sizeBytes += n + TAG_BYTES;
        plainBytes += n;
        if (isLast) break;
      }
      await dst.sync();
      await dst.close();
      dst = undefined;
      await rename(tmpPath, destPath);
      return { sizeBytes, plainBytes };
    } catch (err) {
      if (dst) await dst.close().catch(() => undefined);
      await unlink(tmpPath).catch(() => undefined);
      throw err;
    } finally {
      await src.close();
    }
  } finally {
    rawKey.fill(0);
  }
}
