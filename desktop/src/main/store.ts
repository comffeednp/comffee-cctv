/**
 * The app's own records (no secrets): Oracle accounts, servers, settings. Kept in
 * <userData>/comffee-cctv.json and written atomically.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountKind, ServerStatus, SettingsView } from '../lib/ipc-types.ts';
import { DEFAULT_REPO_REF, DEFAULT_REPO_URL, isSafeRepoRef, isSafeRepoUrl } from '../lib/cloud-init.ts';

export interface AccountRecord {
  id: string;
  kind: AccountKind;
  label: string;
  tenancyId: string;
  userId: string;
  region: string;
  homeRegion: string;
  /** API keys only. */
  fingerprint: string | null;
  /** Session sign-ins only (unix ms). */
  sessionStartedAt: number | null;
  sessionExpiresAt: number | null;
  /** False once a session can no longer be renewed. */
  usable: boolean;
  addedAt: number;
}

export interface ServerRecord {
  id: string;
  name: string;
  url: string;
  accountId: string | null;
  region: string | null;
  instanceId: string | null;
  status: ServerStatus;
  addedAt: number;
}

interface StoreData {
  version: 1;
  accounts: AccountRecord[];
  servers: ServerRecord[];
  selectedServerId: string | null;
  settings: SettingsView;
  sshPublicKey: string | null;
}

export const DEFAULT_SETTINGS: SettingsView = { repoUrl: DEFAULT_REPO_URL, repoRef: DEFAULT_REPO_REF };

export function newId(): string {
  return randomBytes(12).toString('hex');
}

function empty(): StoreData {
  return { version: 1, accounts: [], servers: [], selectedServerId: null, settings: { ...DEFAULT_SETTINGS }, sshPublicKey: null };
}

export class Store {
  private readonly file: string;
  data: StoreData;

  constructor(dir: string) {
    this.file = join(dir, 'comffee-cctv.json');
    this.data = empty();
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoreData>;
        const base = empty();
        const repoUrl: unknown = parsed.settings?.repoUrl;
        const repoRef: unknown = parsed.settings?.repoRef;
        this.data = {
          version: 1,
          accounts: Array.isArray(parsed.accounts) ? parsed.accounts : base.accounts,
          servers: Array.isArray(parsed.servers) ? parsed.servers : base.servers,
          selectedServerId: typeof parsed.selectedServerId === 'string' ? parsed.selectedServerId : null,
          settings: {
            repoUrl: isSafeRepoUrl(repoUrl) ? repoUrl : DEFAULT_SETTINGS.repoUrl,
            repoRef: isSafeRepoRef(repoRef) ? repoRef : DEFAULT_SETTINGS.repoRef,
          },
          sshPublicKey: typeof parsed.sshPublicKey === 'string' ? parsed.sshPublicKey : null,
        };
      } catch {
        // Unreadable: start fresh rather than refusing to open.
      }
    }
  }

  save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }

  account(id: string): AccountRecord | undefined {
    return this.data.accounts.find((a) => a.id === id);
  }

  server(id: string): ServerRecord | undefined {
    return this.data.servers.find((s) => s.id === id);
  }
}
