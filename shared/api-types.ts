/**
 * Request and response types for the hub HTTP API.
 *
 * Conventions (see docs/ARCHITECTURE.md, "HTTP API"):
 * - JSON bodies only. Every non-GET/HEAD request under /api carries the header `X-CCTV: 1`.
 * - All times are ISO 8601 UTC strings (`IsoTime`). The dashboard shows them in the location's IANA timezone.
 * - Lists are wrapped in an object (`{ users: [...] }`, `{ items: [...], nextCursor }`), never a bare array.
 * - Errors use `ApiErrorBody` with the HTTP status listed on `ApiErrorCode`.
 * - A viewer asking for a location, camera or recording outside their list gets 404, never 403.
 *
 * This file is shared by the hub and the dashboard: types and plain constants only.
 */

/** ISO 8601 UTC timestamp, for example "2026-01-31T13:05:00.000Z". */
export type IsoTime = string;

/** Account role. Exactly one owner exists; any number of viewers. */
export type Role = 'owner' | 'viewer';

/** How the hub reaches the cameras of a location. */
export type ConnectorKind = 'router' | 'bridge' | 'direct';

/** Viewed and recorded quality of a camera. 360p = camera sub stream, 1080p = main stream, 720p = main stream transcoded by the hub. */
export type Quality = '360p' | '720p' | '1080p';

/** Camera family. Tapo defaults: main path "/stream1", sub path "/stream2", ONVIF on 2020. */
export type Vendor = 'tapo' | 'onvif' | 'custom';

/** Limits shared by the hub (validation) and the dashboard (form hints). */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 200;
export const RECOVERY_PASSPHRASE_MIN_LENGTH = 12;
export const RETENTION_DAYS_MIN = 1;
export const RETENTION_DAYS_MAX = 90;
export const RETENTION_DAYS_DEFAULT = 20;
export const UPLOAD_CAP_KBPS_DEFAULT = 5000;
export const RECORDINGS_PAGE_MAX = 500;
export const AUDIT_PAGE_MAX = 200;
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_ISSUER = 'Comffee CCTV';

/** CSRF header every non-GET/HEAD /api request must carry (header names are case-insensitive). */
export const CSRF_HEADER = 'X-CCTV';
export const CSRF_HEADER_VALUE = '1';

/** Session cookie name (HttpOnly, Secure, SameSite=Strict, Path=/). */
export const SESSION_COOKIE = 'ccv_session';

/**
 * Error codes and the HTTP status each one is sent with.
 * - not_signed_in 401: no valid session.
 * - wrong_credentials 401: login or 2-step code rejected (message is always "Wrong username or password" for login).
 * - challenge_expired 401: login/enroll challenge unknown, used or older than 5 minutes.
 * - owner_only 403: a viewer called an owner-only endpoint.
 * - csrf 403: missing X-CCTV header, foreign Origin or non-JSON body.
 * - not_found 404: missing, or outside the caller's locations.
 * - conflict 409: duplicate username, camera already added, owner already exists, detect already running.
 * - wrong_password 422: the password re-check on a dangerous action failed.
 * - invalid_input 422: body or query failed validation.
 * - throttled 429: IP throttle, user lockout, setup-code tries, detect or camera-test rate limit.
 * - unavailable 503: a dependency (MediaMTX, ffprobe, the location connector) did not answer.
 * - internal 500: unexpected error (message is generic).
 */
export type ApiErrorCode =
  | 'not_signed_in'
  | 'wrong_credentials'
  | 'challenge_expired'
  | 'owner_only'
  | 'csrf'
  | 'not_found'
  | 'conflict'
  | 'wrong_password'
  | 'invalid_input'
  | 'throttled'
  | 'unavailable'
  | 'internal';

/** Body of every error response: {"error":{"code","message"}}. */
export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string };
}

/** Plain success body for endpoints with nothing else to return (logout, password change, deletes). */
export interface OkResponse {
  ok: true;
}

/* ------------------------------------------------------------------ setup */

/** GET /api/setup/status (public). */
export interface SetupStatus {
  /** True while no owner account exists. */
  needsSetup: boolean;
  /** True once an active vault (recording) key is stored. */
  hasVaultKey: boolean;
}

/** POST /api/setup/owner (public). Response: TotpEnrollment (challenge purpose 'setup'), completed by POST /api/auth/totp. */
export interface SetupOwnerRequest {
  /** One-time code printed by the hub CLI "setup-code". */
  setupCode: string;
  username: string;
  /** 12..200 characters. */
  password: string;
}

/**
 * 2-step enrollment data. Returned by POST /api/setup/owner, POST /api/me/totp/reset and,
 * inside LoginResponse, by POST /api/auth/login for users without 2-step yet.
 * Completed by POST /api/auth/totp {challenge, code}.
 */
export interface TotpEnrollment {
  challenge: string;
  /** RFC 4648 base32 secret without padding. */
  secretBase32: string;
  /** otpauth://totp/Comffee%20CCTV:<username>?secret=...&issuer=Comffee%20CCTV&algorithm=SHA1&digits=6&period=30 */
  otpauthUrl: string;
}

/* ------------------------------------------------------------------- auth */

/** POST /api/auth/login (public). */
export interface LoginRequest {
  username: string;
  password: string;
}

/** POST /api/auth/login response: ask for the 2-step code, or enroll 2-step first. */
export type LoginResponse =
  | { next: 'totp'; challenge: string }
  | ({ next: 'enroll-totp' } & TotpEnrollment);

/** POST /api/auth/totp (public). Response: Me, plus the session cookie. */
export interface TotpRequest {
  challenge: string;
  /** 6 digits. */
  code: string;
}

/** POST /api/auth/totp response. */
export type TotpResponse = Me;

/** POST /api/auth/logout (signed in). Response: OkResponse. */
export type LogoutResponse = OkResponse;

/* --------------------------------------------------------------------- me */

/** GET /api/me (signed in). Also the response of POST /api/auth/totp. */
export interface Me {
  id: number;
  username: string;
  role: Role;
  /** 'all' for the owner, otherwise the viewer's location ids. */
  locationIds: number[] | 'all';
  totpEnabled: boolean;
}

/** POST /api/me/password (signed in). Response: OkResponse. Signs out the user's other sessions. */
export interface ChangePasswordRequest {
  currentPassword: string;
  /** 12..200 characters. */
  newPassword: string;
}

/** POST /api/me/totp/reset (signed in, password re-check). Response: TotpEnrollment (challenge purpose 'reset'). */
export interface ResetTotpRequest {
  password: string;
}

/* ------------------------------------------------------------------ users */

/** One account as the owner sees it. Item of GET /api/users; response of POST /api/users and PATCH /api/users/:id. */
export interface UserSummary {
  id: number;
  username: string;
  role: Role;
  locationIds: number[] | 'all';
  totpEnabled: boolean;
  disabled: boolean;
  /** Set while the account is locked after repeated failures. */
  lockedUntil: IsoTime | null;
  createdAt: IsoTime;
  passwordChangedAt: IsoTime;
}

/** GET /api/users (owner only). */
export interface UsersResponse {
  users: UserSummary[];
}

/** POST /api/users (owner only). Creates a viewer; the viewer enrolls 2-step at first login. Response: UserSummary. */
export interface CreateViewerRequest {
  username: string;
  /** Initial password, 12..200 characters. */
  password: string;
  locationIds: number[];
}

/**
 * PATCH /api/users/:id (owner only, viewers only). Response: UserSummary.
 * `password` (the owner's own password) is required when `newPassword` or `resetTotp` is set.
 * Disabling a user, setting a new password or resetting 2-step deletes that user's sessions.
 */
export interface UpdateUserRequest {
  locationIds?: number[];
  disabled?: boolean;
  /** New password for the viewer, 12..200 characters. */
  newPassword?: string;
  /** Clears the viewer's 2-step so they enroll again at next login. */
  resetTotp?: boolean;
  /** The owner's own password (re-check). */
  password?: string;
}

/** DELETE /api/users/:id (owner only, viewers only). Response: OkResponse. */
export type DeleteUserResponse = OkResponse;

/* ------------------------------------------------------------------ audit */

/** Action names written to the audit log. */
export type AuditAction =
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'auth.totp_enrolled'
  | 'setup.owner'
  | 'account.password'
  | 'account.totp_reset'
  | 'user.create'
  | 'user.update'
  | 'user.delete'
  | 'vault.key_set'
  | 'location.create'
  | 'location.update'
  | 'location.delete'
  | 'location.bridge_token'
  | 'location.detect'
  | 'location.recording_on'
  | 'location.recording_off'
  | 'location.camera_login'
  | 'camera.create'
  | 'camera.update'
  | 'camera.delete'
  | 'camera.recording_on'
  | 'camera.recording_off'
  | 'live.start'
  | 'recording.download'
  | 'storage.prune';

/** One audit row. Item of GET /api/audit. */
export interface AuditItem {
  id: number;
  at: IsoTime;
  userId: number | null;
  /** Username at the time of the action. */
  username: string | null;
  action: AuditAction;
  target: string | null;
  detail: string | null;
  ip: string | null;
  userAgent: string | null;
}

/** GET /api/audit?limit&cursor (owner only), newest first. limit <= AUDIT_PAGE_MAX. */
export interface AuditPage {
  items: AuditItem[];
  /** Opaque; pass as `cursor` for the next page. Null when there is no more. */
  nextCursor: string | null;
}

/* ------------------------------------------------------------- vault keys */

/** One recording public key. Item of GET /api/keys/vault; response of PUT /api/keys/vault. */
export interface VaultKeyInfo {
  /** Hex, first 16 bytes of SHA-256 of the SPKI DER (32 hex characters). */
  keyId: string;
  /** Public key, SPKI DER base64. */
  spkiB64: string;
  createdAt: IsoTime;
  active: boolean;
}

/** GET /api/keys/vault (signed in). Old keys stay listed so older recordings can still be opened. */
export interface VaultKeysResponse {
  keys: VaultKeyInfo[];
  activeKeyId: string | null;
}

/** PUT /api/keys/vault (owner only, password re-check). The new key becomes active. Response: VaultKeyInfo. */
export interface SetVaultKeyRequest {
  /** RSA-OAEP 3072 / SHA-256 public key, SPKI DER base64. */
  spkiB64: string;
  password: string;
}

/* -------------------------------------------------------------- locations */

/**
 * One location. Item of GET /api/locations; response of GET /api/locations/:id, POST and PATCH.
 * For viewers the hub sends cameraSubnet, slot and wanRoutingTable as null.
 */
export interface LocationSummary {
  id: number;
  name: string;
  /** IANA timezone, for example "Asia/Manila". */
  timezone: string;
  connector: ConnectorKind;
  /** Tunnel up (router), bridge connected (bridge), or always true (direct). */
  online: boolean;
  lastSeen: IsoTime | null;
  recordingPaused: boolean;
  retentionDays: number;
  cameraCount: number;
  /** Cameras that are recording right now (camera on, location not paused, vault key present). */
  recordingCameraCount: number;
  uploadCapKbps: number;
  /** Camera network, IPv4 CIDR. Router: exactly a /24. Direct: at most a /24. Bridge: optional. */
  cameraSubnet: string | null;
  /** Router slot 1..250, null for other connectors. */
  slot: number | null;
  /** Optional RouterOS routing table the tunnel uses (router connector). */
  wanRoutingTable: string | null;
  /** True when a saved camera login exists for this location (used for every camera added without its own login). */
  hasCameraLogin: boolean;
  /** Saved camera login username (owner only; null for viewers or when none is saved). The password is never returned. */
  cameraUsername: string | null;
}

/** GET /api/locations (signed in; viewers get only their own). */
export interface LocationsResponse {
  locations: LocationSummary[];
}

/** POST /api/locations (owner only). Response: LocationSummary. A router location gets the lowest free slot. */
export interface CreateLocationRequest {
  name: string;
  timezone: string;
  connector: ConnectorKind;
  cameraSubnet?: string | null;
  uploadCapKbps?: number;
  wanRoutingTable?: string | null;
  retentionDays?: number;
}

/**
 * PATCH /api/locations/:id (owner only). Response: LocationSummary.
 * Changing `connector` assigns or releases the router slot. `recordingPaused` is audited as location.recording_on/off.
 */
export interface UpdateLocationRequest {
  name?: string;
  timezone?: string;
  connector?: ConnectorKind;
  cameraSubnet?: string | null;
  uploadCapKbps?: number;
  wanRoutingTable?: string | null;
  retentionDays?: number;
  recordingPaused?: boolean;
  /** The router's wg-cctv WireGuard public key (base64), printed by the last line of the router script. Null clears it. */
  routerPublicKey?: string | null;
  /** Saved camera login for this location. Send both to set or replace it; the password is stored sealed and never returned. */
  cameraUsername?: string;
  cameraPassword?: string;
  /** True removes the saved camera login. Cameras that were added with it keep their own copy. */
  clearCameraLogin?: boolean;
}

/** DELETE /api/locations/:id (owner only, password re-check). Response: OkResponse. Recordings stay until retention. */
export interface DeleteLocationRequest {
  password: string;
}

/** Router connector setup details. */
export interface RouterSetup {
  slot: number;
  /** RouterOS 7 script; every item tagged comment="comffee-cctv". */
  routerOsScript: string;
  /** Removes every item tagged comment="comffee-cctv". */
  routerOsUndoScript: string;
  /** Generic WireGuard config for other routers, with the 10.78.S.0/24 mapping note. */
  genericWireguardConfig: string;
  routerPublicKeySet: boolean;
  tunnelUp: boolean;
  lastHandshake: IsoTime | null;
}

/** Bridge connector setup details. */
export interface BridgeSetup {
  connected: boolean;
  lastSeen: IsoTime | null;
  /** Where to download the bridge program (hub setting bridgeDownloadUrl); null when the hub has none set. */
  downloadUrl: string | null;
  /** Command line to start the bridge, with the literal placeholder <token> (the token is shown only once, at rotation). */
  command: string;
  /** False until a bridge token was generated. */
  hasToken: boolean;
}

/** Direct connector setup details. */
export interface DirectSetup {
  note: string;
}

/** GET /api/locations/:id/setup (owner only). */
export type LocationSetup =
  | { connector: 'router'; router: RouterSetup }
  | { connector: 'bridge'; bridge: BridgeSetup }
  | { connector: 'direct'; direct: DirectSetup };

/** POST /api/locations/:id/bridge-token (owner only, bridge locations). Replaces any old token and disconnects the old bridge. */
export interface BridgeTokenResponse {
  /** Shown once; the hub stores only its hash. */
  token: string;
  /** BridgeSetup.command with the token filled in. */
  command: string;
}

/* -------------------------------------------------------------- detection */

/** One device found by POST /api/locations/:id/detect. */
export interface DetectedDevice {
  /** Real LAN IP of the device. */
  ip: string;
  rtspPort: number | null;
  onvifPort: number | null;
  rtsp: boolean;
  onvif: boolean;
  /** 'tapo' = ONVIF on 2020 plus RTSP on 554. */
  guessVendor: Vendor | null;
  /** A camera with this IP and RTSP port already exists in the location. */
  alreadyAdded: boolean;
}

/** POST /api/locations/:id/detect (owner only). Max 1 running and 6 per hour per location. Body: {}. */
export interface DetectResponse {
  devices: DetectedDevice[];
  /** Number of addresses probed. */
  scanned: number;
  tookMs: number;
}

/* ---------------------------------------------------------------- cameras */

/** One camera. Item of GET /api/cameras; response of POST and PATCH. Never contains the camera password. */
export interface CameraSummary {
  id: number;
  locationId: number;
  name: string;
  lanIp: string;
  rtspPort: number;
  onvifPort: number | null;
  vendor: Vendor;
  mainPath: string;
  subPath: string | null;
  quality: Quality;
  /** The camera's own recording switch. */
  recording: boolean;
  /** recording AND location not paused AND an active vault key exists. */
  effectiveRecording: boolean;
  online: boolean;
  bitrateKbps: number | null;
  lastSegmentAt: IsoTime | null;
  manufacturer: string | null;
  model: string | null;
  /** Camera login name; null for viewers. */
  username: string | null;
  createdAt: IsoTime;
}

/** GET /api/cameras?locationId= (signed in; viewers only their locations; locationId optional). */
export interface CamerasResponse {
  cameras: CameraSummary[];
}

/** Query of GET /api/cameras. */
export interface CamerasQuery {
  locationId?: number;
}

/** POST /api/cameras (owner only). Response: CameraSummary. Tapo defaults apply when paths are omitted. */
export interface CreateCameraRequest {
  locationId: number;
  name: string;
  lanIp: string;
  /** Default 554. */
  rtspPort?: number;
  onvifPort?: number | null;
  vendor: Vendor;
  mainPath?: string;
  subPath?: string | null;
  /** Omit both to use the location's saved camera login (422 when the location has none). */
  username?: string;
  password?: string;
  /** Default '720p'. */
  quality?: Quality;
  /** Default true. */
  recording?: boolean;
}

/**
 * POST /api/locations/:id/cameras/add-detected (owner only). Adds every listed device with the location's saved camera
 * login, named "Camera 1", "Camera 2", ... (next free numbers), vendor from the detection guess, Tapo paths for Tapo.
 * Each device is stream-tested first; failures are reported and not added. 422 when the location has no saved login.
 */
export interface AddDetectedRequest {
  devices: { ip: string; rtspPort?: number | null; onvifPort?: number | null; vendor?: Vendor | null }[];
  /** Default '720p'. */
  quality?: Quality;
}

/** Response of POST /api/locations/:id/cameras/add-detected. */
export interface AddDetectedResponse {
  added: CameraSummary[];
  failed: { ip: string; error: string }[];
}

/** PATCH /api/cameras/:id (owner only). Response: CameraSummary. Omit `password` to keep the stored one. */
export interface UpdateCameraRequest {
  name?: string;
  lanIp?: string;
  rtspPort?: number;
  onvifPort?: number | null;
  vendor?: Vendor;
  mainPath?: string;
  subPath?: string | null;
  username?: string;
  password?: string;
  quality?: Quality;
  /** Audited as camera.recording_on/off. */
  recording?: boolean;
}

/** DELETE /api/cameras/:id (owner only). Response: OkResponse. Recordings stay until retention. */
export type DeleteCameraResponse = OkResponse;

/**
 * POST /api/cameras/test (owner only): test a camera before adding it. Response: CameraTestResponse.
 * POST /api/cameras/:id/test (owner only) takes body {} and uses the stored settings.
 * Max 30 tests per hour per user.
 */
export interface CameraTestRequest {
  locationId: number;
  lanIp: string;
  rtspPort?: number;
  onvifPort?: number | null;
  vendor: Vendor;
  mainPath?: string;
  subPath?: string | null;
  /** Omit both to test with the location's saved camera login. */
  username?: string;
  password?: string;
}

/** Result of probing one stream with ffprobe (8 s timeout, RTSP over TCP). */
export interface StreamInfo {
  ok: boolean;
  /** Stream path tested, for example "/stream1". */
  path: string;
  codec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  /** Short plain-language reason when ok is false. */
  error: string | null;
}

/** Response of POST /api/cameras/test and POST /api/cameras/:id/test. */
export interface CameraTestResponse {
  main: StreamInfo;
  /** Null when the camera has no sub path. */
  sub: StreamInfo | null;
  /** From ONVIF GetDeviceInformation, when ONVIF answered. */
  manufacturer: string | null;
  model: string | null;
}

/* ------------------------------------------------------------------- live */

/** POST /api/live/:cameraId/token (signed in, audited as live.start). Body: {}. */
export interface LiveTokenResponse {
  /** "/live/c<cameraId>/whep" */
  whepUrl: string;
  /** Sent as "Authorization: Bearer <token>" on the WHEP request. Valid 60 s. */
  token: string;
  expiresAt: IsoTime;
}

/* ------------------------------------------------------------- recordings */

/** One recorded segment (about 5 minutes). Item of GET /api/recordings. */
export interface RecordingItem {
  id: number;
  cameraId: number;
  /** Camera name when the segment was recorded. */
  cameraName: string;
  locationId: number;
  start: IsoTime;
  end: IsoTime;
  durationMs: number;
  /** Size of the encrypted file. */
  sizeBytes: number;
  /** Vault key the file is encrypted with (hex). */
  keyId: string;
}

/** Query of GET /api/recordings. All optional; viewers only see their locations. */
export interface RecordingsQuery {
  locationId?: number;
  cameraId?: number;
  /** Inclusive: segments whose end is after `from`. */
  from?: IsoTime;
  /** Exclusive: segments whose start is before `to`. */
  to?: IsoTime;
  /** Default 'desc' (newest first). */
  order?: 'asc' | 'desc';
  /** Default 100, max RECORDINGS_PAGE_MAX. */
  limit?: number;
  cursor?: string;
}

/** GET /api/recordings (signed in). The file itself: GET /api/recordings/:id/file (CCV1 bytes, audited). */
export interface RecordingsPage {
  items: RecordingItem[];
  nextCursor: string | null;
}

/** One calendar day with recordings, in the location's timezone. */
export interface RecordingDay {
  /** YYYY-MM-DD in the location timezone. */
  date: string;
  segmentCount: number;
  coveredMinutes: number;
}

/** Query of GET /api/recordings/days. */
export interface RecordingDaysQuery {
  locationId: number;
  cameraId?: number;
  /** YYYY-MM in the location timezone. */
  month: string;
}

/** GET /api/recordings/days?locationId&cameraId&month=YYYY-MM (signed in). */
export interface RecordingDaysResponse {
  days: RecordingDay[];
}

/* ---------------------------------------------------------------- storage */

/** Storage use of one location. */
export interface StorageLocation {
  locationId: number;
  name: string;
  bytes: number;
  oldest: IsoTime | null;
  newest: IsoTime | null;
  avgBytesPerDay: number;
  /** Days of recording the free space plus this location's current use would hold at its average rate; null without data. */
  estimatedDaysFit: number | null;
  retentionDays: number;
}

/** GET /api/storage (owner only). */
export interface StorageResponse {
  totalBytes: number;
  freeBytes: number;
  vaultBytes: number;
  /** Disk guard threshold: max(10% of disk, 5 GiB). Oldest recordings are deleted below it. */
  minFreeBytes: number;
  perLocation: StorageLocation[];
}
