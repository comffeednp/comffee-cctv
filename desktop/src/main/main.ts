/**
 * Comffee CCTV desktop app, main process.
 *
 * - Local screens (setup, accounts, top bar) are served from app://local with a strict
 *   Content-Security-Policy; only they get the preload (window.cctv).
 * - The selected server's dashboard runs in a WebContentsView with no preload (views.ts).
 * - Every window: contextIsolation, sandbox, no Node; certificate errors are never ignored; no
 *   webviews; permissions denied on the local session.
 */

import { BrowserWindow, Menu, app, protocol, session, shell } from 'electron';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import type { AppStateView, HubWaitView, JobView, ViewStatus } from '../lib/ipc-types.ts';
import { Accounts } from './accounts.ts';
import { Jobs } from './jobs.ts';
import { LOCAL_ORIGIN, isLocalUrl } from '../lib/local-origin.ts';
import { emit, registerIpc, serverView } from './ipc.ts';
import { SecretStore } from './secrets.ts';
import { DEFAULT_SETTINGS, Store } from './store.ts';
import { ServerViews } from './views.ts';

declare const __CLOUD_INIT_TEMPLATE__: string;

const LOCAL_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

app.enableSandbox();
if (!app.requestSingleInstanceLock()) app.quit();

// Never trust a certificate the system does not trust.
app.on('certificate-error', (event, _contents, _url, _error, _certificate, callback) => {
  event.preventDefault();
  callback(false);
});

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

const appDir = app.getAppPath();
const rendererDir = join(appDir, 'dist', 'renderer');

function serveLocal(): void {
  protocol.handle('app', async (request) => {
    const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return notFound();
    }
    if (url.host !== 'local' || request.method !== 'GET') return notFound();
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return notFound();
    }
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = normalize(join(rendererDir, rel));
    if (!file.startsWith(rendererDir + sep)) return notFound();
    try {
      const body = await readFile(file);
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
          'Content-Security-Policy': LOCAL_CSP,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-cache',
        },
      });
    } catch {
      return notFound();
    }
  });
}

function createWindow(): BrowserWindow {
  const icon = join(rendererDir, 'icons', 'icon-512.png');
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 360,
    minHeight: 480,
    show: false,
    title: 'Comffee CCTV',
    backgroundColor: '#0a0807',
    autoHideMenuBar: true,
    ...(existsSync(icon) ? { icon } : {}),
    webPreferences: {
      preload: join(appDir, 'dist', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  const contents = win.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => {
    if (!isLocalUrl(event.url)) event.preventDefault();
  });
  contents.on('will-redirect', (event) => {
    if (!isLocalUrl(event.url)) event.preventDefault();
  });
  win.once('ready-to-show', () => win.show());
  return win;
}

async function start(): Promise<void> {
  Menu.setApplicationMenu(null);
  // The local screens need no permission at all.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setDevicePermissionHandler(() => false);
  serveLocal();

  const dataDir = app.getPath('userData');
  const store = new Store(dataDir);
  const secrets = new SecretStore(dataDir);
  const win = createWindow();

  let accounts: Accounts;
  const stateView = (): AppStateView => ({
    accounts: store.data.accounts.map((a) => accounts.view(a)),
    servers: store.data.servers.map(serverView),
    selectedServerId: store.data.selectedServerId,
    settings: store.data.settings,
    defaults: DEFAULT_SETTINGS,
    version: app.getVersion(),
  });
  const emitState = () => emit(win, 'state', stateView());
  accounts = new Accounts(store, secrets, (url) => shell.openExternal(url), emitState);
  const jobs = new Jobs({
    store,
    secrets,
    accounts,
    cloudInitTemplate: __CLOUD_INIT_TEMPLATE__,
    emitJob: (view: JobView) => emit(win, 'job', view),
    emitHub: (view: HubWaitView) => emit(win, 'hub', view),
    emitState,
  });
  const views = new ServerViews(win, (status: ViewStatus) => emit(win, 'view', status));
  registerIpc({ win, store, secrets, accounts, jobs, views }, stateView);

  // Servers still installing when the app closed: keep waiting for them.
  for (const server of store.data.servers) if (server.status === 'installing') jobs.watchHub(server.id);

  const keepAlive = setInterval(() => accounts.keepSessionsAlive(), 4 * 60_000);
  win.on('closed', () => {
    clearInterval(keepAlive);
    for (const server of store.data.servers) jobs.stopWatching(server.id);
  });

  await win.loadURL(`${LOCAL_ORIGIN}/index.html`);
}

app.on('second-instance', () => {
  const [win] = BrowserWindow.getAllWindows();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('window-all-closed', () => app.quit());

app.whenReady().then(start).catch((err: unknown) => {
  console.error(`Comffee CCTV could not start: ${err instanceof Error ? err.message : 'unknown error'}`);
  app.quit();
});
