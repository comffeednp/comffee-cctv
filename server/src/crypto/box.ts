/**
 * Box: seals short secrets with the master key.
 * Format: "v1:" + base64(iv 12 bytes | ciphertext | tag 16 bytes), AES-256-GCM.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Box } from '../contracts.ts';

const PREFIX = 'v1:';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function createBox(masterKey: Buffer): Box {
  if (masterKey.length !== 32) throw new Error('Master key must be 32 bytes');
  const key = Buffer.from(masterKey);
  return {
    seal(plain: string): string {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
      const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return PREFIX + Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64');
    },
    open(sealed: string): string {
      if (typeof sealed !== 'string' || !sealed.startsWith(PREFIX)) throw new Error('Unknown sealed value format');
      const raw = Buffer.from(sealed.slice(PREFIX.length), 'base64');
      if (raw.length < IV_BYTES + TAG_BYTES) throw new Error('Sealed value is too short');
      const iv = raw.subarray(0, IV_BYTES);
      const tag = raw.subarray(raw.length - TAG_BYTES);
      const ct = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    },
  };
}
