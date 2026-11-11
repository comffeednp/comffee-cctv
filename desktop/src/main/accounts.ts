/**
 * Oracle accounts: connecting (browser sign-in or API key), signing material for requests, session
 * refresh, removal. Private keys and tokens live only in the SecretStore.
 */

import { readFileSync, statSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { OciClient, OciError } from '../lib/oci-client.ts';
import type { OciAuth } from '../lib/oci-client.ts';
import { httpsTransport } from '../lib/https-transport.ts';
import { isOciRegion, serviceEndpoint } from '../lib/oci-regions.ts';
import { signRequest } from '../lib/oci-signer.ts';
import { apiKeyFingerprint, generateSessionKeyPair, loadPrivateKey, newNonce, readSessionToken, rsaModulus, signInPublicKeyParam } from '../lib/keys.ts';
import { parseConfigPreview } from '../lib/oci-config.ts';
import { SignInNeeded, UserError } from '../lib/errors.ts';
import type { AccountView } from '../lib/ipc-types.ts';
import type { SecretStore } from './secrets.ts';
import type { AccountRecord, Store } from './store.ts';
import { newId } from './store.ts';
import { buildAuthorizeUrl, startSignInListener } from './oracle-sign-in.ts';
import type { SignInListener } from './oracle-sign-in.ts';

/** Oracle lets a session be renewed for at most 24 hours after sign-in. */
export const SESSION_MAX_MS = 24 * 60 * 60_000;
/** Renew when less than this is left on the token. */
const REFRESH_MARGIN_MS = 5 * 60_000;
const KEY_FILE_MAX_BYTES = 32 * 1024;

const keyName = (id: string) => `account:${id}:key`;
const tokenName = (id: string) => `account:${id}:token`;

interface TenancyInfo {
  name?: string;
  homeRegionKey?: string;
}
interface RegionSubscription {
  regionName: string;
  isHomeRegion?: boolean;
}

export class Accounts {
  private readonly store: Store;
  private readonly secrets: SecretStore;
  private readonly openBrowser: (url: string) => Promise<void>;
  private readonly onChange: () => void;
  private signIn: SignInListener | null = null;
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(store: Store, secrets: SecretStore, openBrowser: (url: string) => Promise<void>, onChange: () => void) {
    this.store = store;
    this.secrets = secrets;
    this.openBrowser = openBrowser;
    this.onChange = onChange;
  }

  view(a: AccountRecord): AccountView {
    const renewableUntil = a.kind === 'session' && a.sessionStartedAt ? a.sessionStartedAt + SESSION_MAX_MS : null;
    const now = Date.now();
    let usable = a.usable;
    if (a.kind === 'session') {
      const tokenLeft = (a.sessionExpiresAt ?? 0) > now;
      usable = usable && tokenLeft && (renewableUntil ?? 0) > now;
    }
    return {
      id: a.id,
      kind: a.kind,
      label: a.label,
      region: a.region,
      homeRegion: a.homeRegion,
      sessionExpiresAt: a.kind === 'session' ? a.sessionExpiresAt : null,
      sessionRenewableUntil: renewableUntil,
      usable,
      addedAt: a.addedAt,
    };
  }

  // ---- signing material ------------------------------------------------------------------------

  private privateKey(a: AccountRecord): KeyObject {
    const pem = this.secrets.get(keyName(a.id));
    if (!pem) throw a.kind === 'session' ? new SignInNeeded() : new UserError('The key for this Oracle account is missing. Connect the account again.');
    return loadPrivateKey(pem);
  }

  private async refreshToken(a: AccountRecord, current: string, privateKey: KeyObject): Promise<string> {
    const url = `${serviceEndpoint('auth', a.region)}/v1/authentication/refresh`;
    const body = JSON.stringify({ currentToken: current });
    const signed = signRequest({ method: 'POST', url, keyId: `ST$${current}`, privateKey, body });
    let res;
    try {
      res = await httpsTransport({ method: 'POST', url, headers: { accept: 'application/json', ...signed.headers }, body, timeoutMs: 30_000 });
    } catch {
      throw new UserError('Could not reach Oracle to renew the sign-in. Check the internet connection and try again.');
    }
    if (res.status === 401) {
      this.markUnusable(a);
      throw new SignInNeeded();
    }
    if (res.status !== 200) throw new UserError('Oracle did not renew the sign-in. Try again in a minute.');
    let token: unknown;
    try {
      token = (JSON.parse(res.body) as { token?: unknown }).token;
    } catch {
      token = null;
    }
    const info = typeof token === 'string' ? readSessionToken(token) : null;
    if (!info || typeof token !== 'string') throw new UserError('Oracle sent a sign-in this app could not read. Sign in again.');
    this.secrets.set(tokenName(a.id), token);
    a.sessionExpiresAt = info.expiresAt;
    this.store.save();
    this.onChange();
    return token;
  }

  private markUnusable(a: AccountRecord): void {
    a.usable = false;
    this.store.save();
    this.onChange();
  }

  private async sessionToken(a: AccountRecord, privateKey: KeyObject): Promise<string> {
    const token = this.secrets.get(tokenName(a.id));
    const info = token ? readSessionToken(token) : null;
    if (!token || !info) throw new SignInNeeded();
    const now = Date.now();
    if (info.expiresAt - now > REFRESH_MARGIN_MS) return token;
    const startedAt = a.sessionStartedAt ?? 0;
    if (info.expiresAt <= now || now >= startedAt + SESSION_MAX_MS - REFRESH_MARGIN_MS) {
      if (info.expiresAt <= now) {
        this.markUnusable(a);
        throw new SignInNeeded();
      }
      return token; // Cannot renew past 24 hours; use what is left.
    }
    let pending = this.refreshing.get(a.id);
    if (!pending) {
      pending = this.refreshToken(a, token, privateKey).finally(() => this.refreshing.delete(a.id));
      this.refreshing.set(a.id, pending);
    }
    return pending;
  }

  async auth(accountId: string): Promise<OciAuth> {
    const a = this.store.account(accountId);
    if (!a) throw new UserError('That Oracle account is no longer in this app.');
    const privateKey = this.privateKey(a);
    if (a.kind === 'api-key') return { keyId: `${a.tenancyId}/${a.userId}/${a.fingerprint}`, privateKey };
    const token = await this.sessionToken(a, privateKey);
    return { keyId: `ST$${token}`, privateKey };
  }

  /** A client for the account's home region, where Always Free servers are made. */
  client(accountId: string): { client: OciClient; account: AccountRecord } {
    const account = this.store.account(accountId);
    if (!account) throw new UserError('That Oracle account is no longer in this app.');
    return { client: new OciClient({ region: account.homeRegion, auth: () => this.auth(accountId), transport: httpsTransport }), account };
  }

  // ---- connecting ------------------------------------------------------------------------------

  /** Tenancy name and home region, checked with a signed Identity call (proves the key or token works). */
  private async describeTenancy(region: string, tenancyId: string, auth: OciAuth, refused: string): Promise<{ label: string; homeRegion: string }> {
    const client = new OciClient({ region, auth: async () => auth, transport: httpsTransport });
    let tenancy: TenancyInfo;
    let subscriptions: RegionSubscription[];
    try {
      tenancy = await client.get<TenancyInfo>('identity', `/20160918/tenancies/${encodeURIComponent(tenancyId)}`);
      subscriptions = await client.get<RegionSubscription[]>('identity', `/20160918/tenancies/${encodeURIComponent(tenancyId)}/regionSubscriptions`);
    } catch (err) {
      if (err instanceof OciError && (err.status === 401 || err.status === 404)) throw new UserError(refused);
      throw err;
    }
    const home = (subscriptions ?? []).find((s) => s.isHomeRegion)?.regionName ?? region;
    if (!isOciRegion(home)) throw new UserError('This app does not know your Oracle home region yet. Update the app, then try again.');
    return { label: typeof tenancy.name === 'string' && tenancy.name ? tenancy.name : 'Oracle account', homeRegion: home };
  }

  private upsert(record: Omit<AccountRecord, 'id' | 'addedAt'>, secrets: { key: string; token?: string }, replaceAccountId: string | null): AccountRecord {
    let existing = this.store.data.accounts.find((a) => a.tenancyId === record.tenancyId && a.userId === record.userId && a.kind === record.kind);
    if (!existing) {
      existing = { ...record, id: newId(), addedAt: Date.now() };
      this.store.data.accounts.push(existing);
    } else {
      Object.assign(existing, record);
    }
    this.secrets.set(keyName(existing.id), secrets.key);
    if (secrets.token) this.secrets.set(tokenName(existing.id), secrets.token);
    else this.secrets.delete(tokenName(existing.id));
    if (replaceAccountId && replaceAccountId !== existing.id) this.removeRecord(replaceAccountId);
    this.store.save();
    this.onChange();
    return existing;
  }

  async signInWithBrowser(region: string, replaceAccountId: string | null, onProgress: (status: 'waiting' | 'checking') => void): Promise<AccountRecord> {
    if (this.signIn) throw new UserError('A sign-in is already open in your browser. Finish or cancel it first.');
    const keys = generateSessionKeyPair();
    const listener = await startSignInListener();
    this.signIn = listener;
    try {
      await this.openBrowser(buildAuthorizeUrl(region, signInPublicKeyParam(keys.publicKey), newNonce()));
      onProgress('waiting');
      const token = await listener.token;
      onProgress('checking');
      const info = readSessionToken(token);
      if (!info) throw new UserError('Oracle sent a sign-in this app could not read. Try again.');
      if (info.boundKeyN && info.boundKeyN !== rsaModulus(keys.publicKey)) {
        throw new UserError('That sign-in was not started by this app. Try again.');
      }
      const auth = { keyId: `ST$${token}`, privateKey: keys.privateKey };
      const tenancy = await this.describeTenancy(
        region,
        info.tenancyId,
        auth,
        'Oracle did not accept the sign-in in this region. Pick your home region, then try again.',
      );
      return this.upsert(
        {
          kind: 'session',
          label: tenancy.label,
          tenancyId: info.tenancyId,
          userId: info.userId,
          region,
          homeRegion: tenancy.homeRegion,
          fingerprint: null,
          sessionStartedAt: Date.now(),
          sessionExpiresAt: info.expiresAt,
          usable: true,
        },
        { key: keys.privateKeyPem, token },
        replaceAccountId,
      );
    } finally {
      listener.cancel();
      this.signIn = null;
    }
  }

  cancelSignIn(): void {
    this.signIn?.cancel();
  }

  /**
   * A session token lasts about an hour and can only be renewed while it is still valid, so the app
   * renews sign-ins in the background while it is open (up to Oracle's 24 hour limit).
   */
  keepSessionsAlive(): void {
    for (const a of this.store.data.accounts) {
      if (a.kind !== 'session' || !a.usable) continue;
      this.auth(a.id).catch(() => undefined);
    }
  }

  /** Reads and checks a picked key file. Returns the PEM (PKCS8) for the secret store. */
  static readKeyFile(path: string): { pem: string; key: KeyObject } {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      throw new UserError('That file could not be opened. Pick the key file again.');
    }
    if (size > KEY_FILE_MAX_BYTES) throw new UserError('That file is too large to be a key. Pick the .pem file Oracle gave you.');
    const text = readFileSync(path, 'utf8');
    if (/ENCRYPTED/.test(text)) throw new UserError('This key file has a passphrase. Use the key file Oracle made for you when you added the API key.');
    let key: KeyObject;
    try {
      key = createPrivateKey({ key: text, format: 'pem' });
    } catch {
      throw new UserError('That file is not a private key. Pick the .pem file Oracle gave you.');
    }
    if (key.asymmetricKeyType !== 'rsa') throw new UserError('Oracle API keys are RSA keys. Pick the .pem file Oracle gave you.');
    return { pem: key.export({ format: 'pem', type: 'pkcs8' }).toString(), key };
  }

  async connectApiKey(configText: string, keyFilePath: string, replaceAccountId: string | null): Promise<AccountRecord> {
    const parsed = parseConfigPreview(configText);
    if (!parsed.ok) throw new UserError(parsed.error);
    const { config } = parsed;
    const { pem, key } = Accounts.readKeyFile(keyFilePath);
    if (apiKeyFingerprint(key) !== config.fingerprint) {
      throw new UserError('This key file does not match the fingerprint in the text. Pick the key you downloaded with this API key.');
    }
    const auth = { keyId: `${config.tenancyId}/${config.userId}/${config.fingerprint}`, privateKey: key };
    const tenancy = await this.describeTenancy(
      config.region,
      config.tenancyId,
      auth,
      'Oracle did not accept this API key. A new key can take a minute to work; also check that the text and key file belong together.',
    );
    return this.upsert(
      {
        kind: 'api-key',
        label: tenancy.label,
        tenancyId: config.tenancyId,
        userId: config.userId,
        region: config.region,
        homeRegion: tenancy.homeRegion,
        fingerprint: config.fingerprint,
        sessionStartedAt: null,
        sessionExpiresAt: null,
        usable: true,
      },
      { key: pem },
      replaceAccountId,
    );
  }

  private removeRecord(accountId: string): void {
    this.store.data.accounts = this.store.data.accounts.filter((a) => a.id !== accountId);
    for (const server of this.store.data.servers) if (server.accountId === accountId) server.accountId = null;
    this.secrets.deletePrefix(`account:${accountId}:`);
  }

  remove(accountId: string): void {
    if (!this.store.account(accountId)) throw new UserError('That Oracle account is no longer in this app.');
    this.removeRecord(accountId);
    this.store.save();
    this.onChange();
  }
}
