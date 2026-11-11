/**
 * Hub server contract: database schema, configuration, shared service interfaces and the
 * route module layout. See docs/ARCHITECTURE.md for the full design.
 *
 * Route modules and factories that server/src/main.ts imports (each route module exports one
 * RegisterRoutes function; routes use full paths such as "/api/cameras", no prefix):
 *
 *   server/src/api/setup.ts        registerSetupRoutes       GET /api/setup/status, POST /api/setup/owner
 *   server/src/api/auth.ts         registerAuthRoutes        POST /api/auth/login, /api/auth/totp, /api/auth/logout
 *   server/src/api/me.ts           registerMeRoutes          GET /api/me, POST /api/me/password, /api/me/totp/reset
 *   server/src/api/users.ts        registerUserRoutes        GET/POST /api/users, PATCH/DELETE /api/users/:id
 *   server/src/api/audit.ts        registerAuditRoutes       GET /api/audit
 *   server/src/api/keys.ts         registerKeyRoutes         GET/PUT /api/keys/vault
 *   server/src/api/cameras.ts      registerCameraRoutes      GET/POST /api/cameras, PATCH/DELETE /api/cameras/:id,
 *                                                            POST /api/cameras/test, POST /api/cameras/:id/test,
 *                                                            POST /api/locations/:id/cameras/add-detected
 *   server/src/api/live.ts         registerLiveRoutes        POST /api/live/:cameraId/token
 *   server/src/api/recordings.ts   registerRecordingRoutes   GET /api/recordings, /api/recordings/days, /api/recordings/:id/file
 *   server/src/api/storage.ts      registerStorageRoutes     GET /api/storage
 *   server/src/api/internal.ts     registerInternalRoutes    POST /internal/mediamtx-auth (127.0.0.1 only)
 *   server/src/api/locations.ts    registerLocationRoutes    GET/POST /api/locations, GET/PATCH/DELETE /api/locations/:id,
 *                                                            GET /api/locations/:id/setup, POST /api/locations/:id/bridge-token,
 *                                                            POST /api/locations/:id/detect
 *   server/src/sites/bridge-hub.ts registerBridgeSocket      GET /bridge (WebSocket)
 *
 *   server/src/sites/connectors.ts createConnectorService: CreateConnectorService
 *   server/src/media/manager.ts    createMediaManager: CreateMediaManager
 *
 * Start order in main.ts: load config -> open database (PRAGMAs, SCHEMA_SQL, meta schema_version) ->
 * load or create secrets -> box -> audit -> auth -> connectors -> media -> Fastify app (security headers,
 * CSRF check, error handler, @fastify/websocket, static dashboard with SPA fallback) -> register routes ->
 * listen -> connectors.start() -> media.start(). Stop runs in reverse.
 *
 * CLI: `node server/src/main.ts setup-code` prints a one-time setup code and exits
 * (`setup-code --code <code>` registers a code made elsewhere, for example by the desktop app);
 * with no argument it runs the hub. Both read the config file named by CONFIG_PATH_ENV.
 *
 * Ids: users, locations and cameras use AUTOINCREMENT, so an id is never given out twice, even after
 * a delete (recordings and live paths are keyed by camera id).
 */

import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuditAction, DetectResponse, Role } from '../../shared/api-types.ts';

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','viewer')), totp_secret_enc TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_last_step INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0, failed_count INTEGER NOT NULL DEFAULT 0,
  first_failed_at INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  password_changed_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, timezone TEXT NOT NULL,
  connector TEXT NOT NULL CHECK (connector IN ('router','bridge','direct')), slot INTEGER UNIQUE,
  camera_subnet TEXT, wan_routing_table TEXT, upload_cap_kbps INTEGER NOT NULL DEFAULT 5000,
  router_public_key TEXT, bridge_token_hash TEXT, recording_paused INTEGER NOT NULL DEFAULT 0,
  retention_days INTEGER NOT NULL DEFAULT 20 CHECK (retention_days BETWEEN 1 AND 90), last_seen_at INTEGER,
  camera_username TEXT, camera_password_enc TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS user_locations (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE, PRIMARY KEY (user_id, location_id));
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ip TEXT, user_agent TEXT);
CREATE TABLE IF NOT EXISTS login_challenges (
  id_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('login','enroll','setup','reset')), totp_secret_enc TEXT,
  expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ip_failures (ip TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ip_failures_ip_kind_at ON ip_failures(ip, kind, at);
CREATE TABLE IF NOT EXISTS setup_codes (code_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, user_id INTEGER, username TEXT, action TEXT NOT NULL, target TEXT,
  detail TEXT, ip TEXT, user_agent TEXT);
CREATE INDEX IF NOT EXISTS audit_at ON audit_log(at);
CREATE TABLE IF NOT EXISTS vault_keys (key_id TEXT PRIMARY KEY, spki_b64 TEXT NOT NULL, created_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS cameras (
  id INTEGER PRIMARY KEY AUTOINCREMENT, location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE, name TEXT NOT NULL,
  lan_ip TEXT NOT NULL, rtsp_port INTEGER NOT NULL DEFAULT 554, onvif_port INTEGER,
  vendor TEXT NOT NULL CHECK (vendor IN ('tapo','onvif','custom')), main_path TEXT NOT NULL, sub_path TEXT,
  username TEXT NOT NULL, password_enc TEXT NOT NULL,
  quality TEXT NOT NULL DEFAULT '720p' CHECK (quality IN ('360p','720p','1080p')), recording INTEGER NOT NULL DEFAULT 1,
  manufacturer TEXT, model TEXT, created_at INTEGER NOT NULL, UNIQUE (location_id, lan_ip, rtsp_port));
CREATE TABLE IF NOT EXISTS segments (
  id INTEGER PRIMARY KEY, camera_id INTEGER NOT NULL, camera_name TEXT NOT NULL, location_id INTEGER NOT NULL,
  start_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL, size_bytes INTEGER NOT NULL, key_id TEXT NOT NULL,
  rel_path TEXT NOT NULL UNIQUE);
CREATE INDEX IF NOT EXISTS segments_cam_start ON segments(camera_id, start_at);
CREATE INDEX IF NOT EXISTS segments_loc_start ON segments(location_id, start_at);
`;

/** PRAGMAs run on every database open, before SCHEMA_SQL. */
export const DB_PRAGMAS_SQL = 'PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;';

/* ------------------------------------------------------------- config */

/** Environment variable naming the config file; default DEFAULT_CONFIG_PATH. */
export const CONFIG_PATH_ENV = 'COMFFEE_CCTV_CONFIG';
export const DEFAULT_CONFIG_PATH = '/etc/comffee-cctv/hub.json';

/** Hub configuration (JSON file). Values not in the file take HUB_CONFIG_DEFAULTS. */
export interface HubConfig {
  /** Default /var/lib/comffee-cctv. Holds db.sqlite, raw/, vault/, secrets/. */
  dataDir: string;
  /** Default 127.0.0.1 (Caddy in front). */
  listenHost: string;
  /** Default 8080. */
  listenPort: number;
  /** Exact browser origin, for example "https://cctv.example.com". Required. Used for the Origin check. */
  publicOrigin: string;
  /** Host name of publicOrigin. */
  publicHost: string;
  /** Public IPv4 of the hub: WireGuard endpoint for routers and the WebRTC ICE host. */
  publicIp: string;
  /** Built dashboard folder (dashboard/dist). */
  dashboardDir: string;
  /** Default http://127.0.0.1:9997 */
  mediamtxApi: string;
  /** Default rtsp://127.0.0.1:8554 */
  mediamtxRtsp: string;
  /** Default http://127.0.0.1:8889 */
  mediamtxWebrtc: string;
  /** Default "ffmpeg". */
  ffmpegPath: string;
  /** Default "ffprobe". */
  ffprobePath: string;
  wireguard: {
    /** False on hubs without WireGuard (router connector unavailable). */
    enabled: boolean;
    /** Default "wg0". */
    interface: string;
    /** Default 51820. */
    listenPort: number;
    /** Default "10.77.0.1/16". */
    hubAddress: string;
    /** Hub WireGuard public key (base64), put into router scripts. */
    publicKey: string;
  };
  /** Development only: session cookie without Secure. Default false. */
  devInsecureCookies: boolean;
  /** https:// page where owners download the bridge program (shown on bridge locations). Default null: none shown. */
  bridgeDownloadUrl: string | null;
}

/** Defaults for every config key that has one. dashboardDir is resolved relative to the code when empty. */
export const HUB_CONFIG_DEFAULTS: HubConfig = {
  dataDir: '/var/lib/comffee-cctv',
  listenHost: '127.0.0.1',
  listenPort: 8080,
  publicOrigin: '',
  publicHost: '',
  publicIp: '',
  dashboardDir: '',
  mediamtxApi: 'http://127.0.0.1:9997',
  mediamtxRtsp: 'rtsp://127.0.0.1:8554',
  mediamtxWebrtc: 'http://127.0.0.1:8889',
  ffmpegPath: 'ffmpeg',
  ffprobePath: 'ffprobe',
  wireguard: { enabled: false, interface: 'wg0', listenPort: 51820, hubAddress: '10.77.0.1/16', publicKey: '' },
  devInsecureCookies: false,
  bridgeDownloadUrl: null,
};

/** Secrets under <dataDir>/secrets (mode 0600), created on first start if missing. */
export interface Secrets {
  /** secrets/master.key, 32 random bytes. Seals TOTP secrets and camera passwords (Box). */
  masterKey: Buffer;
  /** secrets/stream-token.key, 32 random bytes. HMAC key for live tokens. */
  streamTokenKey: Buffer;
  /** secrets/mediamtx-internal.json {"user","password"}: how the hub and its ffmpeg jobs sign in to MediaMTX. */
  mediamtxUser: string;
  mediamtxPassword: string;
}

/* ---------------------------------------------------------- networks */

/** Marker on every RouterOS item the router script creates. */
export const ROUTER_COMMENT = 'comffee-cctv';
export const ROUTER_SLOT_MIN = 1;
export const ROUTER_SLOT_MAX = 250;
export const HUB_TUNNEL_IP = '10.77.0.1';

/** Router's tunnel address for slot S: 10.77.S.2 */
export function routerTunnelIp(slot: number): string {
  return `10.77.${slot}.2`;
}

/** Hub-side subnet that the router maps one-to-one onto the camera /24: 10.78.S.0/24 */
export function mappedCameraSubnet(slot: number): string {
  return `10.78.${slot}.0/24`;
}

/* ------------------------------------------------------------- media */

/** MediaMTX path that is viewed and recorded: c<cameraId> */
export function cameraPathName(cameraId: number): string {
  return `c${cameraId}`;
}

/** MediaMTX source path for 720p transcoding: c<cameraId>_src */
export function cameraSourcePathName(cameraId: number): string {
  return `c${cameraId}_src`;
}

export const LIVE_TOKEN_TTL_MS = 60_000;

/* ----------------------------------------------------------- accounts */

export interface SessionUser {
  id: number;
  username: string;
  role: Role;
  /** 'all' for the owner. */
  locationIds: number[] | 'all';
}

/** ip_failures.kind values. */
export type IpFailureKind = 'login' | 'setup' | 'bridge';

/** One audit log write. `at` is set by the audit function. */
export interface AuditEntry {
  /** Null when no account is known (for example a failed login with an unknown username). */
  userId: number | null;
  /** Username snapshot; looked up from userId when omitted. */
  username?: string;
  action: AuditAction;
  /** What was acted on, for example "camera:12", "location:3", "segment:991", "user:4". */
  target?: string;
  /** Short plain-text detail, never a password, token or key. */
  detail?: string;
  ip?: string;
  userAgent?: string;
}

/**
 * Error thrown by route code; the central error handler turns it into
 * {"error":{"code","message"}} with this status. `code` is an ApiErrorCode.
 */
export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

/** Seals short secrets (TOTP secrets, camera passwords) with the master key, AES-256-GCM. */
export interface Box {
  seal(plain: string): string;
  /** Throws if the sealed value was altered or sealed with another key. */
  open(sealed: string): string;
}

/** Session and access checks shared by every route module. */
export interface AuthHelpers {
  /** Signed-in user of this request; throws HttpError 401 not_signed_in. */
  requireUser(req: FastifyRequest): SessionUser;
  /** Signed-in owner; throws 401 not_signed_in or 403 owner_only. */
  requireOwner(req: FastifyRequest): SessionUser;
  canAccessLocation(user: SessionUser, locationId: number): boolean;
  /** Throws HttpError 404 not_found when the user may not see the location (or it does not exist). */
  assertLocationAccess(user: SessionUser, locationId: number): void;
  /** Password re-check for dangerous actions (scrypt, constant time). */
  verifyPassword(userId: number, password: string): Promise<boolean>;
  /** Live token check: user exists, is not disabled, and may still view this location. */
  userCanStillView(userId: number, locationId: number): boolean;
}

/* ---------------------------------------------------------- services */

/** Keeps MediaMTX paths in line with the database and runs the recording pipeline. */
export interface MediaManager {
  /** Reconciles at once, then every 60 s; starts the sweeper (15 s), retention (hourly) and disk guard. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Makes MediaMTX paths match every camera's settings. */
  reconcile(): Promise<void>;
  /** After a camera was created or changed. */
  applyCamera(cameraId: number): Promise<void>;
  /** After a camera was deleted (the row may already be gone). */
  removeCamera(cameraId: number): Promise<void>;
  /** After a location's pause, connector or address changed, or it was deleted. */
  applyLocation(locationId: number): Promise<void>;
  cameraStatus(cameraId: number): Promise<{ online: boolean; bitrateKbps: number | null }>;
}

/** How the hub reaches cameras at each location (router tunnel, bridge relay or direct). */
export interface ConnectorService {
  /** Applies WireGuard peers and routes for every router location; starts bridge relays. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Address the hub (MediaMTX, ffprobe, ONVIF) uses to reach lanIp:port at a location.
   * router -> 10.78.S.<last octet>:port; bridge -> 127.0.0.1:<relay port>; direct -> lanIp:port.
   * Throws HttpError 503 unavailable when the location cannot be reached that way right now.
   */
  resolveCameraAddress(locationId: number, lanIp: string, port: number): Promise<{ host: string; port: number }>;
  /** Runs camera detection for a location (rate limits are enforced by the caller). */
  detect(locationId: number): Promise<DetectResponse>;
  /** ONVIF GetDeviceInformation with WS-Security digest; null when ONVIF did not answer. */
  deviceInfo(
    locationId: number,
    lanIp: string,
    onvifPort: number,
    username: string,
    password: string,
  ): Promise<{ manufacturer: string | null; model: string | null } | null>;
  /** Tunnel up / bridge connected; direct is always online. lastSeen in unix ms. */
  locationStatus(locationId: number): { online: boolean; lastSeen: number | null };
  /** After a location was created, changed or deleted (the row may already be gone). */
  onLocationChanged(locationId: number): Promise<void>;
}

/** Everything a route module or service receives. */
export interface AppDeps {
  db: DatabaseSync;
  config: HubConfig;
  secrets: Secrets;
  box: Box;
  auth: AuthHelpers;
  /** Writes one audit row (never throws). */
  audit(entry: AuditEntry): void;
  media: MediaManager;
  connectors: ConnectorService;
}

export type RegisterRoutes = (app: FastifyInstance, deps: AppDeps) => void | Promise<void>;

export type MediaManagerDeps = Omit<AppDeps, 'media'>;
export type CreateMediaManager = (deps: MediaManagerDeps) => MediaManager;

export type ConnectorDeps = Pick<AppDeps, 'db' | 'config' | 'secrets' | 'box' | 'audit'>;
export type CreateConnectorService = (deps: ConnectorDeps) => ConnectorService;
