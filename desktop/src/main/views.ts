/**
 * The selected server's dashboard, shown in a WebContentsView under the local top bar.
 *
 * - Each server has its own persistent session partition ("persist:server-<id>"), so sign-ins of
 *   different servers never mix. Removing a server from the app clears that partition.
 * - No preload, contextIsolation, sandbox, no Node.
 * - Navigation and window.open stay on the server's own origin; other http(s) links open in the
 *   system browser; everything else is refused.
 * - Every permission request is denied except fullscreen, and clipboard writes from the server's own
 *   origin (the dashboard's Copy buttons for setup codes and router scripts).
 * - Certificate errors are never ignored (see main.ts).
 */

import { BrowserWindow, WebContentsView, app, session, shell } from 'electron';
import type { Session, WebContents } from 'electron';
import { isHttpUrl, isSameOrigin } from '../lib/hub-url.ts';
import type { ViewStatus } from '../lib/ipc-types.ts';

export const TOP_BAR_HEIGHT = 56;

export function partitionFor(serverId: string): string {
  return `persist:server-${serverId}`;
}

function openOutside(url: string): void {
  if (isHttpUrl(url)) void shell.openExternal(url);
}

/** Session-wide rules for one server's partition (set again on every open, so they follow the current origin). */
function hardenSession(ses: Session, origin: string): void {
  const permitted = (permission: string, requestingUrl: string | undefined) => {
    if (permission === 'fullscreen') return true;
    return permission === 'clipboard-sanitized-write' && !!requestingUrl && isSameOrigin(requestingUrl, origin);
  };
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(permitted(permission, details.requestingUrl));
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => permitted(permission, requestingOrigin));
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_req, callback) => callback(null));
}

function hardenContents(contents: WebContents, origin: string): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (isSameOrigin(url, origin)) contents.loadURL(url).catch(() => undefined);
    else openOutside(url);
    return { action: 'deny' };
  });
  contents.on('will-frame-navigate', (event) => {
    const url = event.url;
    if (isSameOrigin(url, origin)) return;
    // Subframes may only be blank or the server itself.
    if (!event.isMainFrame && (url === 'about:blank' || url === 'about:srcdoc')) return;
    event.preventDefault();
    if (event.isMainFrame) openOutside(url);
  });
  contents.on('will-redirect', (event) => {
    if (!isSameOrigin(event.url, origin)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

interface Current {
  serverId: string;
  origin: string;
  view: WebContentsView;
  /** Last address asked for, to try again after a failed load. */
  url: string;
  /** The last main-frame load failed: the view stays hidden so the local message shows. */
  failed: boolean;
}

export class ServerViews {
  private readonly win: BrowserWindow;
  private readonly emit: (status: ViewStatus) => void;
  private current: Current | null = null;
  private visible = false;
  private overlay = false;
  private fullScreen = false;

  constructor(win: BrowserWindow, emit: (status: ViewStatus) => void) {
    this.win = win;
    this.emit = emit;
    win.on('resize', () => this.layout());
    win.on('enter-full-screen', () => this.layout());
    win.on('leave-full-screen', () => this.layout());
  }

  get currentServerId(): string | null {
    return this.current?.serverId ?? null;
  }

  private create(serverId: string, origin: string): Current {
    const ses = session.fromPartition(partitionFor(serverId));
    hardenSession(ses, origin);
    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        navigateOnDragDrop: false,
        spellcheck: false,
        safeDialogs: true,
        devTools: !app.isPackaged,
      },
    });
    view.setBackgroundColor('#0a0807');
    const contents = view.webContents;
    hardenContents(contents, origin);
    // Full screen video: the view takes the whole window, then goes back under the bar.
    contents.on('enter-html-full-screen', () => {
      this.fullScreen = true;
      this.win.setFullScreen(true);
      this.layout();
    });
    contents.on('leave-html-full-screen', () => {
      this.fullScreen = false;
      this.win.setFullScreen(false);
      this.layout();
    });
    const setFailed = (failed: boolean) => {
      if (this.current?.view === view && this.current.failed !== failed) {
        this.current.failed = failed;
        this.layout();
      }
    };
    contents.on('did-start-loading', () => {
      setFailed(false);
      this.emit({ serverId, state: 'loading', message: null });
    });
    contents.on('did-finish-load', () => this.emit({ serverId, state: 'ready', message: null }));
    contents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3: replaced by another navigation
      setFailed(true);
      this.emit({ serverId, state: 'failed', message: 'Could not open this server. Check the internet connection, then try again.' });
    });
    contents.on('render-process-gone', () => {
      setFailed(true);
      this.emit({ serverId, state: 'failed', message: 'The dashboard stopped. Open it again.' });
    });
    return { serverId, origin, view, url: '', failed: false };
  }

  private destroyCurrent(): void {
    if (!this.current) return;
    const { view } = this.current;
    this.win.contentView.removeChildView(view);
    view.webContents.close();
    this.current = null;
    if (this.fullScreen) {
      this.fullScreen = false;
      this.win.setFullScreen(false);
    }
  }

  /** Opens `url` (on `origin`) for this server; reuses the view when it is already that server. */
  open(serverId: string, origin: string, url: string, reload: boolean): void {
    if (!isSameOrigin(url, origin)) throw new Error('URL is not on the server origin.');
    if (this.current && (this.current.serverId !== serverId || this.current.origin !== origin)) this.destroyCurrent();
    if (!this.current) {
      this.current = this.create(serverId, origin);
      this.win.contentView.addChildView(this.current.view);
      reload = true;
    }
    if (reload) {
      this.current.url = url;
      this.current.view.webContents.loadURL(url).catch(() => undefined);
    }
    this.visible = true;
    this.layout();
  }

  reload(): void {
    if (!this.current) return;
    if (this.current.failed && this.current.url) this.current.view.webContents.loadURL(this.current.url).catch(() => undefined);
    else this.current.view.webContents.reload();
  }

  hide(): void {
    this.visible = false;
    this.layout();
  }

  setOverlay(open: boolean): void {
    this.overlay = open;
    this.layout();
  }

  /** Removes a server's view and wipes its local sign-in and storage (never anything on the server). */
  async forget(serverId: string): Promise<void> {
    if (this.current?.serverId === serverId) this.destroyCurrent();
    const ses = session.fromPartition(partitionFor(serverId));
    await ses.clearStorageData();
    await ses.clearCache();
  }

  layout(): void {
    if (!this.current) return;
    const { view } = this.current;
    const show = this.visible && !this.overlay && !this.current.failed;
    view.setVisible(show);
    if (!show) return;
    const [width, height] = this.win.getContentSize() as [number, number];
    const top = this.fullScreen ? 0 : TOP_BAR_HEIGHT;
    view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
  }
}
