/**
 * IPC between the local screens and the main process. Every handler:
 * - accepts calls only from the main window's top frame on app://local (the remote dashboards have no
 *   preload and could not call anyway; this is the second lock),
 * - checks every argument,
 * - answers { ok, value } or { ok: false, error } with a sentence for the screen; secrets never cross.
 */

import { dialog, ipcMain, shell } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { randomBytes } from 'node:crypto';
import * as v from '../lib/validate.ts';
import { InvalidArgument } from '../lib/validate.ts';
import { Cancelled, describeError, UserError } from '../lib/errors.ts';
import { isOciRegion } from '../lib/oci-regions.ts';
import { CONFIG_TEXT_MAX } from '../lib/oci-config.ts';
import { isSafeRepoRef, isSafeRepoUrl } from '../lib/cloud-init.ts';
import { normaliseServerLink } from '../lib/hub-url.ts';
import { isLocalFrame } from '../lib/local-origin.ts';
import type { AppStateView, EventChannel, EventPayloads, LinkKey, Result, ServerView, SettingsView } from '../lib/ipc-types.ts';
import { Accounts } from './accounts.ts';
import type { Jobs } from './jobs.ts';
import { fetchSetupStatus, setupCodeName } from './jobs.ts';
import type { SecretStore } from './secrets.ts';
import type { ServerRecord, Store } from './store.ts';
import { newId } from './store.ts';
import type { ServerViews } from './views.ts';

const LINKS: Record<LinkKey, string> = {
  'oracle-signup': 'https://signup.cloud.oracle.com/',
  'oracle-console': 'https://cloud.oracle.com/',
  'oracle-api-keys': 'https://docs.oracle.com/en-us/iaas/Content/API/Concepts/apisigningkey.htm',
  'oracle-free-tier': 'https://www.oracle.com/cloud/free/',
};

const KEY_FILE_TTL_MS = 10 * 60_000;

export interface IpcDeps {
  win: BrowserWindow;
  store: Store;
  secrets: SecretStore;
  accounts: Accounts;
  jobs: Jobs;
  views: ServerViews;
}

export function serverView(s: ServerRecord): ServerView {
  return { id: s.id, name: s.name, url: s.url, accountId: s.accountId, region: s.region, status: s.status, addedAt: s.addedAt };
}

export function emit<C extends EventChannel>(win: BrowserWindow, channel: C, payload: EventPayloads[C]): void {
  if (!win.isDestroyed()) win.webContents.send(`event:${channel}`, payload);
}

export function registerIpc(deps: IpcDeps, stateView: () => AppStateView): void {
  const { win, store, secrets, accounts, jobs, views } = deps;
  const keyFiles = new Map<string, { path: string; fileName: string; expires: number }>();

  const fromLocalUi = (event: IpcMainInvokeEvent): boolean => {
    if (win.isDestroyed() || event.sender !== win.webContents) return false;
    const frame = event.senderFrame;
    if (!frame || frame !== event.sender.mainFrame) return false;
    return isLocalFrame(frame);
  };

  const handle = <T>(channel: string, fn: (...args: unknown[]) => Promise<T> | T) => {
    ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<Result<T>> => {
      if (!fromLocalUi(event)) return { ok: false, error: 'Not allowed.' };
      try {
        return { ok: true, value: await fn(...args) };
      } catch (err) {
        if (err instanceof InvalidArgument) return { ok: false, error: 'That did not go through. Try again.' };
        if (err instanceof Cancelled) return { ok: false, error: 'Cancelled.', cancelled: true };
        const { message, needsSignIn } = describeError(err);
        if (!(err instanceof UserError)) console.error(`[ipc] ${channel} failed: ${err instanceof Error ? err.name : 'error'}`);
        return { ok: false, error: message, needsSignIn };
      }
    });
  };

  const requireServer = (id: string): ServerRecord => {
    const server = store.server(id);
    if (!server) throw new UserError('That server is no longer in this app.');
    return server;
  };

  handle('state:get', () => stateView());

  handle('oracle:sign-in', async (region, replace) => {
    if (!isOciRegion(region)) throw new InvalidArgument('region');
    const replaceId = v.optionalId(replace, 'account');
    const record = await accounts.signInWithBrowser(region, replaceId, (status) => emit(win, 'sign-in', { status }));
    return accounts.view(record);
  });

  handle('oracle:cancel-sign-in', () => {
    accounts.cancelSignIn();
    return null;
  });

  handle('oracle:pick-key-file', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose your Oracle private key',
      buttonLabel: 'Choose',
      properties: ['openFile'],
      filters: [
        { name: 'Private key', extensions: ['pem', 'key'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    const path = result.filePaths[0];
    if (result.canceled || !path) return null;
    // Checked now so a wrong file shows at once; read again when connecting.
    Accounts.readKeyFile(path);
    const now = Date.now();
    for (const [token, entry] of keyFiles) if (entry.expires < now) keyFiles.delete(token);
    const token = randomBytes(16).toString('hex');
    const fileName = path.split(/[\\/]/).pop() ?? 'key.pem';
    keyFiles.set(token, { path, fileName, expires: now + KEY_FILE_TTL_MS });
    return { token, fileName };
  });

  handle('oracle:add-api-key', async (configText, keyToken, replace) => {
    const text = v.text(configText, 'configuration', CONFIG_TEXT_MAX, 1);
    const token = v.text(keyToken, 'key file', 32, 32);
    const replaceId = v.optionalId(replace, 'account');
    const file = keyFiles.get(token);
    if (!file || file.expires < Date.now()) throw new UserError('Pick the private key file again.');
    const record = await accounts.connectApiKey(text, file.path, replaceId);
    keyFiles.delete(token);
    return accounts.view(record);
  });

  handle('accounts:remove', (id) => {
    accounts.remove(v.id(id, 'account'));
    return null;
  });

  handle('server:plan', (accountId) => jobs.plan(v.id(accountId, 'account')));
  handle('server:start', (accountId) => jobs.start(v.id(accountId, 'account')));
  handle('server:cancel', () => {
    jobs.cancel();
    return null;
  });
  handle('server:job', () => jobs.status());
  handle('server:hub', (serverId) => {
    const id = v.id(serverId, 'server');
    requireServer(id);
    jobs.watchHub(id);
    return jobs.hubStatus(id);
  });

  handle('server:add-link', async (link) => {
    const parsed = normaliseServerLink(v.text(link, 'link', 300));
    if (!parsed.ok) throw new UserError(parsed.error);
    const existing = store.data.servers.find((s) => s.url === parsed.origin);
    if (existing) return serverView(existing);
    const status = await fetchSetupStatus(parsed.origin);
    if (!status) throw new UserError('That link does not answer like a Comffee CCTV server. Check it, then try again.');
    const server: ServerRecord = {
      id: newId(),
      name: new URL(parsed.origin).hostname.slice(0, 60),
      url: parsed.origin,
      accountId: null,
      region: null,
      instanceId: null,
      status: 'ready',
      addedAt: Date.now(),
    };
    store.data.servers.push(server);
    store.data.selectedServerId = server.id;
    store.save();
    emit(win, 'state', stateView());
    return serverView(server);
  });

  handle('server:rename', (serverId, name) => {
    const server = requireServer(v.id(serverId, 'server'));
    server.name = v.displayName(name);
    store.save();
    emit(win, 'state', stateView());
    return serverView(server);
  });

  handle('server:remove', async (serverId) => {
    const server = requireServer(v.id(serverId, 'server'));
    jobs.stopWatching(server.id);
    await views.forget(server.id);
    secrets.deletePrefix(`server:${server.id}:`);
    store.data.servers = store.data.servers.filter((s) => s.id !== server.id);
    if (store.data.selectedServerId === server.id) store.data.selectedServerId = store.data.servers[0]?.id ?? null;
    store.save();
    emit(win, 'state', stateView());
    return null;
  });

  handle('view:show', async (serverId) => {
    const server = requireServer(v.id(serverId, 'server'));
    if (store.data.selectedServerId !== server.id) {
      store.data.selectedServerId = server.id;
      store.save();
    }
    if (server.status === 'installing') {
      views.hide();
      jobs.watchHub(server.id);
      return null;
    }
    const switching = views.currentServerId !== server.id;
    let url = `${server.url}/`;
    const code = secrets.get(setupCodeName(server.id));
    if (code && switching) {
      const status = await fetchSetupStatus(server.url, 5_000);
      if (status && !status.needsSetup) secrets.delete(setupCodeName(server.id));
      else url = `${server.url}/setup#code=${encodeURIComponent(code)}`;
    }
    views.open(server.id, server.url, url, switching);
    return null;
  });

  handle('view:hide', () => {
    views.hide();
    return null;
  });

  handle('view:reload', () => {
    views.reload();
    return null;
  });

  handle('view:overlay', (open) => {
    views.setOverlay(v.bool(open, 'overlay'));
    return null;
  });

  handle('settings:update', (repoUrl, repoRef): SettingsView => {
    const url = typeof repoUrl === 'string' ? repoUrl.trim() : '';
    const ref = typeof repoRef === 'string' ? repoRef.trim() : '';
    if (!isSafeRepoUrl(url)) throw new UserError('Use a plain https address, like the default one.');
    if (!isSafeRepoRef(ref)) throw new UserError('Use a branch or tag name, like main.');
    store.data.settings = { repoUrl: url, repoRef: ref };
    store.save();
    emit(win, 'state', stateView());
    return store.data.settings;
  });

  handle('link:open', async (key) => {
    const k = v.oneOf(key, Object.keys(LINKS) as LinkKey[], 'link');
    await shell.openExternal(LINKS[k]);
    return null;
  });

}
