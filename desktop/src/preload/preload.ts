/**
 * Preload for the local screens only (never for a server's dashboard). Exposes window.cctv: a fixed list
 * of calls and event channels; nothing else of ipcRenderer reaches the page.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { CctvApi, EventChannel, LinkKey } from '../lib/ipc-types.ts';

const CHANNELS: readonly EventChannel[] = ['state', 'job', 'hub', 'view', 'sign-in'];

const api: CctvApi = {
  getState: () => ipcRenderer.invoke('state:get'),
  signIn: (region: string, replaceAccountId: string | null) => ipcRenderer.invoke('oracle:sign-in', region, replaceAccountId),
  cancelSignIn: () => ipcRenderer.invoke('oracle:cancel-sign-in'),
  pickKeyFile: () => ipcRenderer.invoke('oracle:pick-key-file'),
  addApiKey: (configText: string, keyFileToken: string, replaceAccountId: string | null) =>
    ipcRenderer.invoke('oracle:add-api-key', configText, keyFileToken, replaceAccountId),
  removeAccount: (accountId: string) => ipcRenderer.invoke('accounts:remove', accountId),
  planServer: (accountId: string) => ipcRenderer.invoke('server:plan', accountId),
  startServer: (accountId: string) => ipcRenderer.invoke('server:start', accountId),
  cancelServer: () => ipcRenderer.invoke('server:cancel'),
  jobStatus: () => ipcRenderer.invoke('server:job'),
  hubStatus: (serverId: string) => ipcRenderer.invoke('server:hub', serverId),
  addServerLink: (link: string) => ipcRenderer.invoke('server:add-link', link),
  renameServer: (serverId: string, name: string) => ipcRenderer.invoke('server:rename', serverId, name),
  removeServer: (serverId: string) => ipcRenderer.invoke('server:remove', serverId),
  showServer: (serverId: string) => ipcRenderer.invoke('view:show', serverId),
  hideServer: () => ipcRenderer.invoke('view:hide'),
  reloadServer: () => ipcRenderer.invoke('view:reload'),
  setOverlay: (open: boolean) => ipcRenderer.invoke('view:overlay', open),
  updateSettings: (repoUrl: string, repoRef: string) => ipcRenderer.invoke('settings:update', repoUrl, repoRef),
  openLink: (key: LinkKey) => ipcRenderer.invoke('link:open', key),
  on: (channel, listener) => {
    if (!CHANNELS.includes(channel)) throw new Error('Unknown channel.');
    const wrapped = (_event: unknown, payload: unknown) => listener(payload as never);
    ipcRenderer.on(`event:${channel}`, wrapped);
    return () => {
      ipcRenderer.removeListener(`event:${channel}`, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('cctv', api);
