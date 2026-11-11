/**
 * Camera routes: GET/POST /api/cameras, PATCH/DELETE /api/cameras/:id,
 * POST /api/cameras/test, POST /api/cameras/:id/test, POST /api/locations/:id/cameras/add-detected.
 * Camera passwords are sealed with the box and never returned. A camera added or tested without its
 * own login uses the location's saved camera login; the camera keeps its own sealed copy.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type {
  AddDetectedResponse,
  CameraSummary,
  CameraTestResponse,
  ConnectorKind,
  Quality,
  StreamInfo,
  Vendor,
} from '../../../shared/api-types.ts';
import { BRIDGE_ALLOWED_PORTS, isPrivateIpv4, parseIpv4 } from '../../../shared/bridge-protocol.ts';
import { HttpError } from '../contracts.ts';
import type { AppDeps, SessionUser } from '../contracts.ts';
import { requestMeta } from '../audit.ts';
import { asObject, invalidInput, iso, notFound, parseIdParam, queryInt } from '../media/params.ts';
import { cameraRtspUrl } from '../media/paths.ts';
import { probeStream } from '../media/probe.ts';
import type { ProbeResult } from '../media/probe.ts';
import { mapLimit } from '../sites/probe.ts';

const VENDORS: readonly Vendor[] = ['tapo', 'onvif', 'custom'];
const QUALITIES: readonly Quality[] = ['360p', '720p', '1080p'];
const TAPO_MAIN_PATH = '/stream1';
const TAPO_SUB_PATH = '/stream2';
const TAPO_ONVIF_PORT = 2020;
const DEFAULT_RTSP_PORT = 554;
const ROUTER_ALLOWED_PORTS: readonly number[] = [554, 2020];
const NAME_MAX = 80;
const PATH_MAX = 200;
const USERNAME_MAX = 100;
const PASSWORD_MAX = 200;
const TESTS_PER_HOUR = 30;
const HOUR_MS = 3_600_000;
const DEVICE_INFO_TIMEOUT_MS = 8_000;
/** Add-detected: at most one /24 worth of devices per request, stream-tested 3 at a time. */
const ADD_DETECTED_MAX = 254;
const ADD_DETECTED_PARALLEL = 3;
const NO_SAVED_LOGIN = 'Save a camera login for this location first';
const TOO_MANY_TESTS = 'Too many camera tests in the last hour. Try again later.';

/** Stream test used by the camera routes (ffprobe by default; tests pass their own). */
export type StreamProbe = (ffprobePath: string, url: string) => Promise<ProbeResult>;

export interface CameraRouteOptions {
  probe?: StreamProbe;
}

interface CameraRow {
  id: number;
  location_id: number;
  name: string;
  lan_ip: string;
  rtsp_port: number;
  onvif_port: number | null;
  vendor: Vendor;
  main_path: string;
  sub_path: string | null;
  username: string;
  password_enc: string;
  quality: Quality;
  recording: number;
  manufacturer: string | null;
  model: string | null;
  created_at: number;
}

interface LocationRow {
  id: number;
  connector: ConnectorKind;
  camera_subnet: string | null;
  recording_paused: number;
  camera_username: string | null;
  camera_password_enc: string | null;
}

interface CameraLogin {
  username: string;
  password: string;
}

/** Camera settings after validation and defaults. */
interface CameraFields {
  name: string;
  lanIp: string;
  rtspPort: number;
  onvifPort: number | null;
  vendor: Vendor;
  mainPath: string;
  subPath: string | null;
  username: string;
  quality: Quality;
  recording: boolean;
}

/* ------------------------------------------------------------ validation */

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function text(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string') throw invalidInput(`${field} must be text`);
  const v = field === 'name' ? value.trim() : value;
  if (v.length < min || v.length > max) throw invalidInput(`${field} must be ${min} to ${max} characters`);
  if (CONTROL_CHARS.test(v)) throw invalidInput(`${field} contains characters that are not allowed`);
  return v;
}

function port(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw invalidInput(`${field} must be a port number from 1 to 65535`);
  }
  return value;
}

function streamPath(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > PATH_MAX || !value.startsWith('/')) {
    throw invalidInput(`${field} must start with "/" and be at most ${PATH_MAX} characters`);
  }
  if (!/^[\x21-\x7e]+$/.test(value) || value.includes('#') || value.includes('\\')) {
    throw invalidInput(`${field} contains characters that are not allowed`);
  }
  return value;
}

function ipToInt(p: [number, number, number, number]): number {
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

/** True when ip is inside the IPv4 CIDR (false for anything malformed). */
export function ipv4InCidr(ip: string, cidr: string): boolean {
  const [net, bitsText] = cidr.split('/');
  const ipParts = parseIpv4(ip);
  const netParts = net ? parseIpv4(net) : null;
  const bits = Number(bitsText);
  if (!ipParts || !netParts || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ipToInt(ipParts) & mask) >>> 0) === ((ipToInt(netParts) & mask) >>> 0);
}

function checkLanIp(value: unknown): string {
  if (typeof value !== 'string') throw invalidInput('lanIp must be an IPv4 address');
  const p = parseIpv4(value);
  if (!p) throw invalidInput('lanIp must be an IPv4 address such as 192.168.1.20');
  // Never the hub itself, link-local (cloud metadata), multicast or broadcast.
  if (p[0] === 0 || p[0] === 127 || (p[0] === 169 && p[1] === 254) || p[0] >= 224) {
    throw invalidInput('lanIp must be a camera address on the business network');
  }
  return value;
}

/** Connector limits: the router tunnel opens only 554 and 2020; the bridge only its allowed ports and private IPs. */
function checkReachable(loc: LocationRow, f: { lanIp: string; rtspPort: number; onvifPort: number | null }): void {
  if (loc.camera_subnet && (loc.connector === 'router' || loc.connector === 'direct') && !ipv4InCidr(f.lanIp, loc.camera_subnet)) {
    throw invalidInput(`The camera address must be inside the location's camera network ${loc.camera_subnet}`);
  }
  if (loc.connector === 'router' && !loc.camera_subnet) {
    throw invalidInput('Set the camera network of this location first');
  }
  const allowed = loc.connector === 'router' ? ROUTER_ALLOWED_PORTS : loc.connector === 'bridge' ? BRIDGE_ALLOWED_PORTS : null;
  if (allowed) {
    for (const p of [f.rtspPort, f.onvifPort]) {
      if (p !== null && !allowed.includes(p)) {
        throw invalidInput(`With this connection type the camera ports must be one of ${allowed.join(', ')}`);
      }
    }
  }
  if (loc.connector === 'bridge') {
    if (!isPrivateIpv4(f.lanIp)) throw invalidInput('With the bridge the camera address must be a private network address');
  }
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw invalidInput(`${field} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

/** Validates a create (or test) body, applying Tapo defaults. The login is read separately (givenLogin). */
function newCameraFields(body: Record<string, unknown>, withName: boolean): Omit<CameraFields, 'username'> {
  const vendor = oneOf(body.vendor, VENDORS, 'vendor');
  const tapo = vendor === 'tapo';
  const mainRaw = body.mainPath ?? (tapo ? TAPO_MAIN_PATH : undefined);
  if (mainRaw === undefined) throw invalidInput('mainPath is required for this camera type');
  const subRaw = body.subPath === undefined ? (tapo ? TAPO_SUB_PATH : null) : body.subPath;
  const onvifRaw = body.onvifPort === undefined ? (tapo ? TAPO_ONVIF_PORT : null) : body.onvifPort;
  return {
    name: withName ? text(body.name, 'name', 1, NAME_MAX) : '',
    lanIp: checkLanIp(body.lanIp),
    rtspPort: body.rtspPort === undefined ? DEFAULT_RTSP_PORT : port(body.rtspPort, 'rtspPort'),
    onvifPort: onvifRaw === null ? null : port(onvifRaw, 'onvifPort'),
    vendor,
    mainPath: streamPath(mainRaw, 'mainPath'),
    subPath: subRaw === null ? null : streamPath(subRaw, 'subPath'),
    quality: body.quality === undefined ? '720p' : oneOf(body.quality, QUALITIES, 'quality'),
    recording: body.recording === undefined ? true : bool(body.recording, 'recording'),
  };
}

/** The login sent in the body, or null when both username and password are left out (use the saved one). */
function givenLogin(body: Record<string, unknown>): CameraLogin | null {
  if (body.username === undefined && body.password === undefined) return null;
  if (body.username === undefined || body.password === undefined) {
    throw invalidInput("Enter both the camera username and password, or leave both out to use the location's saved camera login");
  }
  return { username: text(body.username, 'username', 0, USERNAME_MAX), password: text(body.password, 'password', 0, PASSWORD_MAX) };
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw invalidInput(`${field} must be true or false`);
  return value;
}

function positiveId(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw invalidInput(`${field} is invalid`);
  return value;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

function isUniqueViolation(err: unknown): boolean {
  return /UNIQUE constraint failed/i.test(err instanceof Error ? err.message : String(err));
}

/* ------------------------------------------------------------ routes */

export function registerCameraRoutes(app: FastifyInstance, deps: AppDeps, options: CameraRouteOptions = {}): void {
  const { db, auth, box, media, connectors, audit, config } = deps;
  const probeUrl: StreamProbe = options.probe ?? ((ffprobePath, url) => probeStream(ffprobePath, url));

  const locationStmt = db.prepare(
    'SELECT id, connector, camera_subnet, recording_paused, camera_username, camera_password_enc FROM locations WHERE id = ?',
  );
  const cameraStmt = db.prepare('SELECT * FROM cameras WHERE id = ?');
  const lastSegmentStmt = db.prepare(
    // Only this camera row's own footage (a deleted camera with the same id may have left segments).
    'SELECT start_at, duration_ms FROM segments WHERE camera_id = ? AND start_at >= ? ORDER BY start_at DESC LIMIT 1',
  );
  const activeKeyStmt = db.prepare('SELECT 1 AS one FROM vault_keys WHERE active = 1 LIMIT 1');
  const testHistory = new Map<number, number[]>();
  const addDetectedRunning = new Set<number>();

  function loadLocation(id: number): LocationRow {
    const loc = locationStmt.get(id) as unknown as LocationRow | undefined;
    if (!loc) throw notFound('Location not found');
    return loc;
  }

  /** The location's saved camera login; 422 when none is saved. */
  function savedLogin(loc: LocationRow): CameraLogin {
    if (loc.camera_username === null || loc.camera_password_enc === null) throw invalidInput(NO_SAVED_LOGIN);
    try {
      return { username: loc.camera_username, password: box.open(loc.camera_password_enc) };
    } catch {
      throw new HttpError(409, 'conflict', 'The saved camera login of this location cannot be read. Save it again.');
    }
  }

  function loadCamera(id: number): CameraRow {
    const row = cameraStmt.get(id) as unknown as CameraRow | undefined;
    if (!row) throw notFound('Camera not found');
    return row;
  }

  async function summarize(rows: CameraRow[], user: SessionUser): Promise<CameraSummary[]> {
    const keyExists = activeKeyStmt.get() !== undefined;
    const paused = new Map<number, boolean>();
    const statuses = await Promise.all(
      rows.map((r) => media.cameraStatus(r.id).catch(() => ({ online: false, bitrateKbps: null }))),
    );
    return rows.map((r, i) => {
      if (!paused.has(r.location_id)) {
        const loc = locationStmt.get(r.location_id) as unknown as LocationRow | undefined;
        paused.set(r.location_id, !loc || loc.recording_paused === 1);
      }
      const last = lastSegmentStmt.get(r.id, r.created_at) as { start_at: number; duration_ms: number } | undefined;
      const status = statuses[i] ?? { online: false, bitrateKbps: null };
      return {
        id: r.id,
        locationId: r.location_id,
        name: r.name,
        lanIp: r.lan_ip,
        rtspPort: r.rtsp_port,
        onvifPort: r.onvif_port,
        vendor: r.vendor,
        mainPath: r.main_path,
        subPath: r.sub_path,
        quality: r.quality,
        recording: r.recording === 1,
        effectiveRecording: r.recording === 1 && !paused.get(r.location_id) && keyExists,
        online: status.online,
        bitrateKbps: status.bitrateKbps,
        lastSegmentAt: last ? iso(last.start_at + last.duration_ms) : null,
        manufacturer: r.manufacturer,
        model: r.model,
        username: user.role === 'owner' ? r.username : null,
        createdAt: iso(r.created_at),
      };
    });
  }

  async function applyToMedia(cameraId: number): Promise<void> {
    try {
      await media.applyCamera(cameraId);
    } catch (err) {
      // The 60-second reconcile retries; the saved change stands.
      warn(`camera ${cameraId}: media update postponed: ${(err as Error).message}`);
    }
  }

  function warn(message: string): void {
    app.log.warn(message);
  }

  /** Takes up to `wanted` camera tests from the user's hourly allowance; 429 when none is left. Returns how many. */
  function takeTestSlots(userId: number, wanted: number): number {
    const now = Date.now();
    const recent = (testHistory.get(userId) ?? []).filter((t) => now - t < HOUR_MS);
    const granted = Math.max(0, Math.min(wanted, TESTS_PER_HOUR - recent.length));
    for (let i = 0; i < granted; i++) recent.push(now);
    testHistory.set(userId, recent);
    if (granted === 0) throw new HttpError(429, 'throttled', TOO_MANY_TESTS);
    return granted;
  }

  function takeTestSlot(userId: number): void {
    takeTestSlots(userId, 1);
  }

  async function runTest(
    locationId: number,
    f: { lanIp: string; rtspPort: number; onvifPort: number | null; mainPath: string; subPath: string | null; username: string },
    password: string,
  ): Promise<CameraTestResponse> {
    const target = await connectors.resolveCameraAddress(locationId, f.lanIp, f.rtspPort);
    const probe = async (p: string): Promise<StreamInfo> => ({
      path: p,
      ...(await probeUrl(config.ffprobePath, cameraRtspUrl(target, p, f.username, password))),
    });
    const [main, sub, info] = await Promise.all([
      probe(f.mainPath),
      f.subPath ? probe(f.subPath) : Promise.resolve(null),
      f.onvifPort !== null
        ? withTimeout(connectors.deviceInfo(locationId, f.lanIp, f.onvifPort, f.username, password), DEVICE_INFO_TIMEOUT_MS)
        : Promise.resolve(null),
    ]);
    return { main, sub, manufacturer: info?.manufacturer ?? null, model: info?.model ?? null };
  }

  /* GET /api/cameras?locationId= */
  app.get('/api/cameras', async (req: FastifyRequest) => {
    const user = auth.requireUser(req);
    const locationId = queryInt(req.query, 'locationId', 1, Number.MAX_SAFE_INTEGER);
    let rows: CameraRow[];
    if (locationId !== undefined) {
      auth.assertLocationAccess(user, locationId);
      rows = db.prepare('SELECT * FROM cameras WHERE location_id = ? ORDER BY name COLLATE NOCASE, id').all(locationId) as unknown as CameraRow[];
    } else if (user.locationIds === 'all') {
      rows = db.prepare('SELECT * FROM cameras ORDER BY location_id, name COLLATE NOCASE, id').all() as unknown as CameraRow[];
    } else if (user.locationIds.length === 0) {
      rows = [];
    } else {
      const ids = user.locationIds;
      rows = db
        .prepare(`SELECT * FROM cameras WHERE location_id IN (${ids.map(() => '?').join(',')}) ORDER BY location_id, name COLLATE NOCASE, id`)
        .all(...ids) as unknown as CameraRow[];
    }
    return { cameras: await summarize(rows, user) };
  });

  /* POST /api/cameras */
  app.post('/api/cameras', async (req: FastifyRequest) => {
    const user = auth.requireOwner(req);
    const body = asObject(req.body);
    const locationId = positiveId(body.locationId, 'locationId');
    const base = newCameraFields(body, true);
    const given = givenLogin(body);
    const loc = loadLocation(locationId);
    checkReachable(loc, base);
    const login = given ?? savedLogin(loc);
    const f: CameraFields = { ...base, username: login.username };

    let manufacturer: string | null = null;
    let model: string | null = null;
    if (f.onvifPort !== null) {
      const info = await withTimeout(
        connectors.deviceInfo(locationId, f.lanIp, f.onvifPort, f.username, login.password),
        DEVICE_INFO_TIMEOUT_MS,
      );
      manufacturer = info?.manufacturer?.slice(0, 100) ?? null;
      model = info?.model?.slice(0, 100) ?? null;
    }

    let id: number;
    try {
      const res = db
        .prepare(
          `INSERT INTO cameras (location_id, name, lan_ip, rtsp_port, onvif_port, vendor, main_path, sub_path, username,
            password_enc, quality, recording, manufacturer, model, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          locationId,
          f.name,
          f.lanIp,
          f.rtspPort,
          f.onvifPort,
          f.vendor,
          f.mainPath,
          f.subPath,
          f.username,
          box.seal(login.password),
          f.quality,
          f.recording ? 1 : 0,
          manufacturer,
          model,
          Date.now(),
        );
      id = Number(res.lastInsertRowid);
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'conflict', 'This camera is already added to the location');
      throw err;
    }
    audit({ userId: user.id, username: user.username, action: 'camera.create', target: `camera:${id}`, detail: f.name, ...requestMeta(req) });
    await applyToMedia(id);
    const [summary] = await summarize([loadCamera(id)], user);
    return summary;
  });

  /* PATCH /api/cameras/:id */
  app.patch('/api/cameras/:id', async (req: FastifyRequest) => {
    const user = auth.requireOwner(req);
    const id = parseIdParam((req.params as Record<string, unknown>).id);
    const row = loadCamera(id);
    const body = asObject(req.body);
    const loc = loadLocation(row.location_id);

    const next: CameraFields = {
      name: body.name === undefined ? row.name : text(body.name, 'name', 1, NAME_MAX),
      lanIp: body.lanIp === undefined ? row.lan_ip : checkLanIp(body.lanIp),
      rtspPort: body.rtspPort === undefined ? row.rtsp_port : port(body.rtspPort, 'rtspPort'),
      onvifPort: body.onvifPort === undefined ? row.onvif_port : body.onvifPort === null ? null : port(body.onvifPort, 'onvifPort'),
      vendor: body.vendor === undefined ? row.vendor : oneOf(body.vendor, VENDORS, 'vendor'),
      mainPath: body.mainPath === undefined ? row.main_path : streamPath(body.mainPath, 'mainPath'),
      subPath: body.subPath === undefined ? row.sub_path : body.subPath === null ? null : streamPath(body.subPath, 'subPath'),
      username: body.username === undefined ? row.username : text(body.username, 'username', 0, USERNAME_MAX),
      quality: body.quality === undefined ? row.quality : oneOf(body.quality, QUALITIES, 'quality'),
      recording: body.recording === undefined ? row.recording === 1 : bool(body.recording, 'recording'),
    };
    const newPassword = body.password === undefined ? null : text(body.password, 'password', 0, PASSWORD_MAX);
    checkReachable(loc, next);

    const changed: string[] = [];
    const cmp: [string, unknown, unknown][] = [
      ['name', next.name, row.name],
      ['lanIp', next.lanIp, row.lan_ip],
      ['rtspPort', next.rtspPort, row.rtsp_port],
      ['onvifPort', next.onvifPort, row.onvif_port],
      ['vendor', next.vendor, row.vendor],
      ['mainPath', next.mainPath, row.main_path],
      ['subPath', next.subPath, row.sub_path],
      ['username', next.username, row.username],
      ['quality', next.quality, row.quality],
    ];
    for (const [field, a, b] of cmp) if (a !== b) changed.push(field);
    if (newPassword !== null) changed.push('password');
    const recordingChanged = next.recording !== (row.recording === 1);

    try {
      db.prepare(
        `UPDATE cameras SET name = ?, lan_ip = ?, rtsp_port = ?, onvif_port = ?, vendor = ?, main_path = ?, sub_path = ?,
          username = ?, password_enc = ?, quality = ?, recording = ? WHERE id = ?`,
      ).run(
        next.name,
        next.lanIp,
        next.rtspPort,
        next.onvifPort,
        next.vendor,
        next.mainPath,
        next.subPath,
        next.username,
        newPassword === null ? row.password_enc : box.seal(newPassword),
        next.quality,
        next.recording ? 1 : 0,
        id,
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'conflict', 'Another camera in this location already uses that address and port');
      throw err;
    }

    const meta = { userId: user.id, username: user.username, target: `camera:${id}`, ...requestMeta(req) };
    if (changed.length > 0) audit({ ...meta, action: 'camera.update', detail: `Changed: ${changed.join(', ')}` });
    if (recordingChanged) audit({ ...meta, action: next.recording ? 'camera.recording_on' : 'camera.recording_off' });
    if (changed.length > 0 || recordingChanged) await applyToMedia(id);
    const [summary] = await summarize([loadCamera(id)], user);
    return summary;
  });

  /* DELETE /api/cameras/:id */
  app.delete('/api/cameras/:id', async (req: FastifyRequest) => {
    const user = auth.requireOwner(req);
    const id = parseIdParam((req.params as Record<string, unknown>).id);
    const row = loadCamera(id);
    db.prepare('DELETE FROM cameras WHERE id = ?').run(id);
    audit({ userId: user.id, username: user.username, action: 'camera.delete', target: `camera:${id}`, detail: row.name, ...requestMeta(req) });
    try {
      await media.removeCamera(id);
    } catch (err) {
      warn(`camera ${id}: media removal postponed: ${(err as Error).message}`);
    }
    return { ok: true as const };
  });

  /* POST /api/cameras/test */
  app.post('/api/cameras/test', async (req: FastifyRequest) => {
    const user = auth.requireOwner(req);
    const body = asObject(req.body);
    const locationId = positiveId(body.locationId, 'locationId');
    const base = newCameraFields(body, false);
    const given = givenLogin(body);
    const loc = loadLocation(locationId);
    checkReachable(loc, base);
    const login = given ?? savedLogin(loc);
    takeTestSlot(user.id);
    return runTest(locationId, { ...base, username: login.username }, login.password);
  });

  /* POST /api/cameras/:id/test */
  app.post('/api/cameras/:id/test', async (req: FastifyRequest) => {
    const user = auth.requireOwner(req);
    const id = parseIdParam((req.params as Record<string, unknown>).id);
    const row = loadCamera(id);
    takeTestSlot(user.id);
    let password: string;
    try {
      password = box.open(row.password_enc);
    } catch {
      throw new HttpError(409, 'conflict', 'The stored camera password cannot be read. Enter it again.');
    }
    const result = await runTest(
      row.location_id,
      {
        lanIp: row.lan_ip,
        rtspPort: row.rtsp_port,
        onvifPort: row.onvif_port,
        mainPath: row.main_path,
        subPath: row.sub_path,
        username: row.username,
      },
      password,
    );
    if (result.manufacturer !== null || result.model !== null) {
      db.prepare('UPDATE cameras SET manufacturer = ?, model = ? WHERE id = ?').run(
        result.manufacturer?.slice(0, 100) ?? row.manufacturer,
        result.model?.slice(0, 100) ?? row.model,
        id,
      );
    }
    return result;
  });

  /* POST /api/locations/:id/cameras/add-detected */
  app.post('/api/locations/:id/cameras/add-detected', async (req: FastifyRequest): Promise<AddDetectedResponse> => {
    const user = auth.requireOwner(req);
    const locationId = parseIdParam((req.params as Record<string, unknown>).id);
    const loc = loadLocation(locationId);
    const body = asObject(req.body);
    const quality = body.quality === undefined ? '720p' : oneOf(body.quality, QUALITIES, 'quality');
    if (!Array.isArray(body.devices) || body.devices.length < 1 || body.devices.length > ADD_DETECTED_MAX) {
      throw invalidInput(`devices must list 1 to ${ADD_DETECTED_MAX} cameras`);
    }
    if (loc.connector !== 'bridge' && !loc.camera_subnet) throw invalidInput('Set the camera network of this location first');

    // Validate every device first, so a bad list changes nothing.
    const wanted: Omit<CameraFields, 'name' | 'username'>[] = [];
    const seen = new Set<string>();
    for (const raw of body.devices as unknown[]) {
      const d = asObject(raw, 'Each device');
      if (typeof d.ip !== 'string' || !isPrivateIpv4(d.ip)) {
        throw invalidInput(`${typeof d.ip === 'string' ? d.ip.slice(0, 40) : 'A device'} is not a private network address`);
      }
      const lanIp = d.ip;
      const onvifPort = d.onvifPort === undefined || d.onvifPort === null ? null : port(d.onvifPort, 'onvifPort');
      const vendor: Vendor =
        d.vendor === undefined || d.vendor === null ? (onvifPort !== null ? 'onvif' : 'custom') : oneOf(d.vendor, VENDORS, 'vendor');
      const tapo = vendor === 'tapo';
      const f = {
        lanIp,
        rtspPort: d.rtspPort === undefined || d.rtspPort === null ? DEFAULT_RTSP_PORT : port(d.rtspPort, 'rtspPort'),
        onvifPort: d.onvifPort === undefined && tapo ? TAPO_ONVIF_PORT : onvifPort,
        vendor,
        mainPath: TAPO_MAIN_PATH,
        subPath: tapo ? TAPO_SUB_PATH : null,
        quality,
        recording: true,
      };
      try {
        checkReachable(loc, f);
      } catch (err) {
        if (err instanceof HttpError) throw invalidInput(`${lanIp}: ${err.message}`);
        throw err;
      }
      if (seen.has(lanIp)) continue;
      seen.add(lanIp);
      wanted.push(f);
    }
    const login = savedLogin(loc);
    if (addDetectedRunning.has(locationId)) throw new HttpError(409, 'conflict', 'Cameras are already being added to this location.');

    const failed: AddDetectedResponse['failed'] = [];
    const alreadyAdded = db.prepare('SELECT 1 AS one FROM cameras WHERE location_id = ? AND lan_ip = ? LIMIT 1');
    const toTest: typeof wanted = [];
    for (const f of wanted) {
      if (alreadyAdded.get(locationId, f.lanIp)) failed.push({ ip: f.lanIp, error: 'This camera is already added' });
      else if (f.vendor !== 'tapo') failed.push({ ip: f.lanIp, error: 'Its stream address is not known. Add this camera by hand.' });
      else toTest.push(f);
    }
    if (toTest.length === 0) return { added: [], failed };

    const granted = takeTestSlots(user.id, toTest.length);
    for (const f of toTest.splice(granted)) failed.push({ ip: f.lanIp, error: TOO_MANY_TESTS });

    addDetectedRunning.add(locationId);
    const passed: { f: (typeof wanted)[number]; manufacturer: string | null; model: string | null }[] = [];
    try {
      const results = await mapLimit(toTest, ADD_DETECTED_PARALLEL, async (f) => {
        try {
          return await runTest(locationId, { ...f, username: login.username }, login.password);
        } catch (err) {
          return err instanceof HttpError ? err.message : 'The stream test could not run';
        }
      });
      results.forEach((r, i) => {
        const f = toTest[i]!;
        if (typeof r === 'string') failed.push({ ip: f.lanIp, error: r });
        else if (!r.main.ok) failed.push({ ip: f.lanIp, error: r.main.error ?? 'The stream could not be opened' });
        else if (r.sub && !r.sub.ok) failed.push({ ip: f.lanIp, error: r.sub.error ?? 'The second stream could not be opened' });
        else passed.push({ f, manufacturer: r.manufacturer?.slice(0, 100) ?? null, model: r.model?.slice(0, 100) ?? null });
      });
    } finally {
      addDetectedRunning.delete(locationId);
    }

    // No await from here to the last insert, so the names and the "already added" check cannot race.
    if (!locationStmt.get(locationId)) throw notFound('Location not found');
    const used = new Set(
      (db.prepare('SELECT name FROM cameras WHERE location_id = ?').all(locationId) as { name: string }[])
        .map((r) => /^Camera (\d{1,6})$/i.exec(r.name.trim())?.[1])
        .filter((n): n is string => n !== undefined)
        .map(Number),
    );
    let nextNumber = 1;
    const insert = db.prepare(
      `INSERT INTO cameras (location_id, name, lan_ip, rtsp_port, onvif_port, vendor, main_path, sub_path, username,
        password_enc, quality, recording, manufacturer, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const addedIds: number[] = [];
    for (const { f, manufacturer, model } of passed) {
      if (alreadyAdded.get(locationId, f.lanIp)) {
        failed.push({ ip: f.lanIp, error: 'This camera is already added' });
        continue;
      }
      while (used.has(nextNumber)) nextNumber++;
      const name = `Camera ${nextNumber}`;
      try {
        const res = insert.run(
          locationId,
          name,
          f.lanIp,
          f.rtspPort,
          f.onvifPort,
          f.vendor,
          f.mainPath,
          f.subPath,
          login.username,
          box.seal(login.password),
          f.quality,
          1,
          manufacturer,
          model,
          Date.now(),
        );
        used.add(nextNumber);
        const id = Number(res.lastInsertRowid);
        addedIds.push(id);
        audit({
          userId: user.id,
          username: user.username,
          action: 'camera.create',
          target: `camera:${id}`,
          detail: `${name} at ${f.lanIp}, from the camera search`,
          ...requestMeta(req),
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        failed.push({ ip: f.lanIp, error: 'This camera is already added' });
      }
    }

    for (const id of addedIds) await applyToMedia(id);
    const added = await summarize(addedIds.map((id) => loadCamera(id)), user);
    return { added, failed };
  });
}
