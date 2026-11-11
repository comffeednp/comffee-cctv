/**
 * Secrets (Oracle private keys, session tokens, the app's SSH private key, pending setup codes) are kept
 * only encrypted with Electron safeStorage (Windows DPAPI, tied to this Windows user) in
 * <userData>/secrets.json. Values are never logged or sent to the screens.
 */

import { safeStorage } from 'electron';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UserError } from '../lib/errors.ts';

export class SecretStore {
  private readonly file: string;
  private data: Record<string, string>;

  constructor(dir: string) {
    this.file = join(dir, 'secrets.json');
    this.data = Object.create(null) as Record<string, string>;
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') this.data[k] = v;
        }
      } catch {
        // A damaged file is treated as empty; accounts then need a new sign-in.
      }
    }
  }

  private requireEncryption(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new UserError('Windows could not protect saved keys on this computer, so nothing was saved.');
    }
  }

  get(name: string): string | null {
    const sealed = this.data[name];
    if (!sealed) return null;
    this.requireEncryption();
    try {
      return safeStorage.decryptString(Buffer.from(sealed, 'base64'));
    } catch {
      return null;
    }
  }

  set(name: string, value: string): void {
    this.requireEncryption();
    this.data[name] = safeStorage.encryptString(value).toString('base64');
    this.flush();
  }

  delete(name: string): void {
    if (!(name in this.data)) return;
    delete this.data[name];
    this.flush();
  }

  deletePrefix(prefix: string): void {
    let changed = false;
    for (const name of Object.keys(this.data)) {
      if (name.startsWith(prefix)) {
        delete this.data[name];
        changed = true;
      }
    }
    if (changed) this.flush();
  }

  private flush(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
