/**
 * Location routes. Owners manage locations; viewers list and read only the locations given to them
 * (anything else is 404). Router locations get the lowest free slot; bridge tokens are shown once and
 * stored as a SHA-256 hash; deleting a location re-checks the owner's password.
 * Each location can keep one saved camera login (username + password sealed with the box) that
 * cameras added without their own login use; the password is never returned or logged.
 */

import type { FastifyRequest } from 'fastify';
import type {
  AuditAction,
  BridgeSetup,
  BridgeTokenResponse,
  ConnectorKind,
  DetectResponse,
  LocationSetup,
  LocationSummary,
  LocationsResponse,
  OkResponse,
} from '../../../shared/api-types.ts';
import {
  PASSWORD_MAX_LENGTH,
  RETENTION_DAYS_DEFAULT,
  RETENTION_DAYS_MAX,
  RETENTION_DAYS_MIN,
  UPLOAD_CAP_KBPS_DEFAULT,
} from '../../../shared/api-types.ts';
import { BRIDGE_PATH, parseIpv4 } from '../../../shared/bridge-protocol.ts';
import type { AppDeps, RegisterRoutes, SessionUser } from '../contracts.ts';
import { HttpError } from '../contracts.ts';
import { hashBridgeToken, newBridgeToken } from '../sites/bridge-hub.ts';
import {
  checkRouterCameraSubnet,
  checkSmallCameraSubnet,
  isRoutingTableName,
  isWireguardKey,
  lowestFreeSlot,
} from '../sites/net.ts';
import {
  RouterScriptError,
  UPLOAD_CAP_MAX_KBPS,
  UPLOAD_CAP_MIN_KBPS,
  genericWireguardConfig,
  routerOsScript,
  routerOsUndoScript,
} from '../sites/routeros.ts';

export const DETECT_MAX_PER_HOUR = 6;
/** Saved camera login: username and password 1..128 characters each. */
export const CAMERA_LOGIN_MAX = 128;
const NAME_MAX = 80;
/** Audit action for saving or removing a location's camera login (detail "saved" or "removed", never the values). */
const CAMERA_LOGIN_ACTION: AuditAction = 'location.camera_login';

interface LocationRow {
  id: number;
  name: string;
  timezone: string;
  connector: ConnectorKind;
  slot: number | null;
  camera_subnet: string | null;
  wan_routing_table: string | null;
  upload_cap_kbps: number;
  router_public_key: string | null;
  bridge_token_hash: string | null;
  recording_paused: number;
  retention_days: number;
  last_seen_at: number | null;
  camera_username: string | null;
  camera_password_enc: string | null;
  created_at: number;
}

type IdParams = { Params: { id: string } };

function invalid(message: string): HttpError {
  return new HttpError(422, 'invalid_input', message);
}

function notFound(): HttpError {
  return new HttpError(404, 'not_found', 'Location not found.');
}

function parseId(text: string): number {
  if (!/^[1-9]\d{0,9}$/.test(text)) throw notFound();
  const id = Number(text);
  if (!Number.isSafeInteger(id)) throw notFound();
  return id;
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function bodyOf(req: FastifyRequest): Record<string, unknown> {
  const b = req.body;
  if (b === undefined || b === null) return {};
  if (typeof b !== 'object' || Array.isArray(b)) throw invalid('The request body must be a JSON object.');
  return b as Record<string, unknown>;
}

function has(b: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(b, key) && b[key] !== undefined;
}

/* ----------------------------------------------------------- validation */

function validName(v: unknown): string {
  if (typeof v !== 'string') throw invalid('Name is required.');
  const name = v.trim();
  if (name.length < 1 || name.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) {
    throw invalid(`Name must be 1 to ${NAME_MAX} characters.`);
  }
  return name;
}

function validTimezone(v: unknown): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_+\-/]{1,64}$/.test(v)) throw invalid('Time zone must be an IANA name such as Asia/Manila.');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v });
  } catch {
    throw invalid('Time zone must be an IANA name such as Asia/Manila.');
  }
  return v;
}

function validConnector(v: unknown): ConnectorKind {
  if (v === 'router' || v === 'bridge' || v === 'direct') return v;
  throw invalid('Connector must be router, bridge or direct.');
}

function validRetention(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < RETENTION_DAYS_MIN || v > RETENTION_DAYS_MAX) {
    throw invalid(`Keep recordings for ${RETENTION_DAYS_MIN} to ${RETENTION_DAYS_MAX} days.`);
  }
  return v;
}

function validUploadCap(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < UPLOAD_CAP_MIN_KBPS || v > UPLOAD_CAP_MAX_KBPS) {
    throw invalid(`Upload cap must be a whole number from ${UPLOAD_CAP_MIN_KBPS} to ${UPLOAD_CAP_MAX_KBPS} kbps.`);
  }
  return v;
}

function validRoutingTable(v: unknown): string | null {
  if (v === null || v === '') return null;
  if (!isRoutingTableName(v)) throw invalid('Routing table names may use only letters, digits, "_" and "-" (at most 32).');
  return v;
}

/** Normalised camera network for the connector, or null when none is set (not allowed for router). */
function validSubnet(connector: ConnectorKind, v: unknown): string | null {
  if (v === null || v === undefined || v === '') {
    if (connector === 'router') throw invalid('The router connector needs the camera network, exactly a /24 such as 192.168.1.0/24.');
    return null;
  }
  if (typeof v !== 'string') throw invalid('Camera network must be text such as 192.168.1.0/24.');
  const r = connector === 'router' ? checkRouterCameraSubnet(v) : checkSmallCameraSubnet(v, connector === 'bridge');
  if ('error' in r) throw invalid(r.error);
  return r.net.cidr;
}

function validCameraLoginPart(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.length < 1 || v.length > CAMERA_LOGIN_MAX || /[\u0000-\u001f\u007f]/.test(v)) {
    throw invalid(`Enter the camera ${what} (1 to ${CAMERA_LOGIN_MAX} characters).`);
  }
  return v;
}

/* ----------------------------------------------------------------- routes */

export const registerLocationRoutes: RegisterRoutes = (app, deps: AppDeps) => {
  const { db, config, auth, connectors, media } = deps;
  const detectRunning = new Set<number>();
  const detectHistory = new Map<number, number[]>();

  const loadRow = (id: number): LocationRow | undefined => {
    const row = db.prepare('SELECT * FROM locations WHERE id = ?').get(id) as LocationRow | undefined;
    if (!row) return undefined;
    return {
      ...row,
      id: Number(row.id),
      slot: row.slot === null ? null : Number(row.slot),
      upload_cap_kbps: Number(row.upload_cap_kbps),
      recording_paused: Number(row.recording_paused),
      retention_days: Number(row.retention_days),
      last_seen_at: row.last_seen_at === null ? null : Number(row.last_seen_at),
    };
  };

  const requireRow = (id: number): LocationRow => {
    const row = loadRow(id);
    if (!row) throw notFound();
    return row;
  };

  const hasActiveKey = (): boolean => db.prepare('SELECT 1 AS x FROM vault_keys WHERE active = 1 LIMIT 1').get() !== undefined;

  const summary = (row: LocationRow, user: SessionUser, activeKey: boolean): LocationSummary => {
    const counts = db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN recording = 1 THEN 1 ELSE 0 END), 0) AS r FROM cameras WHERE location_id = ?')
      .get(row.id) as { n: number; r: number };
    const status = connectors.locationStatus(row.id);
    const owner = user.role === 'owner';
    const paused = row.recording_paused === 1;
    return {
      id: row.id,
      name: row.name,
      timezone: row.timezone,
      connector: row.connector,
      online: status.online,
      lastSeen: iso(status.lastSeen),
      recordingPaused: paused,
      retentionDays: row.retention_days,
      cameraCount: Number(counts.n),
      recordingCameraCount: paused || !activeKey ? 0 : Number(counts.r),
      uploadCapKbps: row.upload_cap_kbps,
      cameraSubnet: owner ? row.camera_subnet : null,
      slot: owner ? row.slot : null,
      wanRoutingTable: owner ? row.wan_routing_table : null,
      hasCameraLogin: row.camera_username !== null && row.camera_password_enc !== null,
      cameraUsername: owner ? row.camera_username : null,
    };
  };

  const usedSlots = (exceptId: number | null): number[] =>
    (db.prepare('SELECT id, slot FROM locations WHERE slot IS NOT NULL').all() as Array<{ id: number; slot: number }>)
      .filter((r) => Number(r.id) !== exceptId)
      .map((r) => Number(r.slot));

  const requireRouterAvailable = (): void => {
    if (!config.wireguard.enabled) {
      throw invalid('This hub has no WireGuard tunnel set up, so use the bridge or direct connector.');
    }
  };

  const auditLocation = (
    req: FastifyRequest,
    user: SessionUser,
    action: Parameters<AppDeps['audit']>[0]['action'],
    id: number,
    detail?: string,
  ): void => {
    deps.audit({
      userId: user.id,
      username: user.username,
      action,
      target: `location:${id}`,
      detail,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  };

  const bridgeHubUrl = (): string => {
    try {
      const url = new URL(config.publicOrigin);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('bad scheme');
      return `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}${BRIDGE_PATH}`;
    } catch {
      throw new HttpError(503, 'unavailable', "The hub's public address is not configured.");
    }
  };

  const bridgeCommand = (token: string): string => `comffee-cctv-bridge --hub ${bridgeHubUrl()} --token ${token}`;

  const afterChange = async (req: FastifyRequest, id: number, mediaToo: boolean): Promise<void> => {
    await connectors.onLocationChanged(id);
    if (!mediaToo) return;
    try {
      await media.applyLocation(id);
    } catch (err) {
      req.log.warn({ err, locationId: id }, 'media update after a location change failed; the next reconcile retries');
    }
  };

  /* GET /api/locations */
  app.get('/api/locations', async (req): Promise<LocationsResponse> => {
    const user = auth.requireUser(req);
    const rows = (db.prepare('SELECT id FROM locations ORDER BY name COLLATE NOCASE, id').all() as Array<{ id: number }>)
      .map((r) => Number(r.id))
      .filter((id) => auth.canAccessLocation(user, id))
      .map((id) => loadRow(id))
      .filter((r): r is LocationRow => r !== undefined);
    const activeKey = hasActiveKey();
    return { locations: rows.map((r) => summary(r, user, activeKey)) };
  });

  /* GET /api/locations/:id */
  app.get<IdParams>('/api/locations/:id', async (req): Promise<LocationSummary> => {
    const user = auth.requireUser(req);
    const id = parseId(req.params.id);
    auth.assertLocationAccess(user, id);
    return summary(requireRow(id), user, hasActiveKey());
  });

  /* POST /api/locations */
  app.post('/api/locations', async (req): Promise<LocationSummary> => {
    const user = auth.requireOwner(req);
    const b = bodyOf(req);
    const name = validName(b.name);
    const timezone = validTimezone(b.timezone);
    const connector = validConnector(b.connector);
    if (connector === 'router') requireRouterAvailable();
    const subnet = validSubnet(connector, b.cameraSubnet);
    const cap = has(b, 'uploadCapKbps') ? validUploadCap(b.uploadCapKbps) : UPLOAD_CAP_KBPS_DEFAULT;
    const table = has(b, 'wanRoutingTable') ? validRoutingTable(b.wanRoutingTable) : null;
    const retention = has(b, 'retentionDays') ? validRetention(b.retentionDays) : RETENTION_DAYS_DEFAULT;
    let slot: number | null = null;
    if (connector === 'router') {
      slot = lowestFreeSlot(usedSlots(null));
      if (slot === null) throw new HttpError(409, 'conflict', 'All 250 router slots on this hub are in use.');
    }
    const res = db
      .prepare(
        `INSERT INTO locations (name, timezone, connector, slot, camera_subnet, wan_routing_table, upload_cap_kbps,
           retention_days, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(name, timezone, connector, slot, subnet, table, cap, retention, Date.now());
    const id = Number(res.lastInsertRowid);
    auditLocation(req, user, 'location.create', id, `${connector}: ${name}`);
    await afterChange(req, id, false);
    return summary(requireRow(id), user, hasActiveKey());
  });

  /* PATCH /api/locations/:id */
  app.patch<IdParams>('/api/locations/:id', async (req): Promise<LocationSummary> => {
    const user = auth.requireOwner(req);
    const id = parseId(req.params.id);
    const row = requireRow(id);
    const b = bodyOf(req);
    const next: LocationRow = { ...row };
    if (has(b, 'name')) next.name = validName(b.name);
    if (has(b, 'timezone')) next.timezone = validTimezone(b.timezone);
    if (has(b, 'connector')) next.connector = validConnector(b.connector);
    if (has(b, 'uploadCapKbps')) next.upload_cap_kbps = validUploadCap(b.uploadCapKbps);
    if (has(b, 'wanRoutingTable')) next.wan_routing_table = validRoutingTable(b.wanRoutingTable);
    if (has(b, 'retentionDays')) next.retention_days = validRetention(b.retentionDays);
    if (has(b, 'recordingPaused')) {
      if (typeof b.recordingPaused !== 'boolean') throw invalid('recordingPaused must be true or false.');
      next.recording_paused = b.recordingPaused ? 1 : 0;
    }
    if (next.connector !== row.connector) {
      if (row.connector === 'router') {
        next.slot = null;
        next.router_public_key = null;
      }
      if (row.connector === 'bridge') next.bridge_token_hash = null;
      if (next.connector === 'router') {
        requireRouterAvailable();
        next.slot = lowestFreeSlot(usedSlots(id));
        if (next.slot === null) throw new HttpError(409, 'conflict', 'All 250 router slots on this hub are in use.');
      }
    }
    if (has(b, 'routerPublicKey')) {
      const key = b.routerPublicKey;
      if (key !== null && key !== '' && !isWireguardKey(key)) {
        throw invalid('The router key must be the 44-character WireGuard public key the router script printed.');
      }
      next.router_public_key = key === null || key === '' ? null : (key as string);
    }
    next.camera_subnet = validSubnet(next.connector, has(b, 'cameraSubnet') ? b.cameraSubnet : next.camera_subnet);
    let loginChange: 'saved' | 'removed' | null = null;
    if (has(b, 'clearCameraLogin') && typeof b.clearCameraLogin !== 'boolean') throw invalid('clearCameraLogin must be true or false.');
    if (has(b, 'cameraUsername') || has(b, 'cameraPassword')) {
      if (b.clearCameraLogin === true) throw invalid('Save a new camera login or remove it, not both at once.');
      if (!has(b, 'cameraUsername') || !has(b, 'cameraPassword')) throw invalid('Enter both the camera username and password.');
      next.camera_username = validCameraLoginPart(b.cameraUsername, 'username');
      next.camera_password_enc = deps.box.seal(validCameraLoginPart(b.cameraPassword, 'password'));
      loginChange = 'saved';
    } else if (b.clearCameraLogin === true && (row.camera_username !== null || row.camera_password_enc !== null)) {
      next.camera_username = null;
      next.camera_password_enc = null;
      loginChange = 'removed';
    }
    if (next.router_public_key !== null) {
      if (next.connector !== 'router') throw invalid('Only router locations have a router key.');
      if (next.router_public_key === config.wireguard.publicKey) throw invalid("That is the hub's own key, not the router's.");
      const dup = db
        .prepare('SELECT 1 AS x FROM locations WHERE router_public_key = ? AND id <> ? LIMIT 1')
        .get(next.router_public_key, id);
      if (dup) throw new HttpError(409, 'conflict', 'Another location already uses this router key.');
    }

    db.prepare(
      `UPDATE locations SET name = ?, timezone = ?, connector = ?, slot = ?, camera_subnet = ?, wan_routing_table = ?,
         upload_cap_kbps = ?, router_public_key = ?, bridge_token_hash = ?, recording_paused = ?, retention_days = ?,
         camera_username = ?, camera_password_enc = ?
       WHERE id = ?`,
    ).run(
      next.name,
      next.timezone,
      next.connector,
      next.slot,
      next.camera_subnet,
      next.wan_routing_table,
      next.upload_cap_kbps,
      next.router_public_key,
      next.bridge_token_hash,
      next.recording_paused,
      next.retention_days,
      next.camera_username,
      next.camera_password_enc,
      id,
    );

    const fields: Array<[string, unknown, unknown]> = [
      ['name', row.name, next.name],
      ['timezone', row.timezone, next.timezone],
      ['connector', row.connector, next.connector],
      ['camera network', row.camera_subnet, next.camera_subnet],
      ['upload cap', row.upload_cap_kbps, next.upload_cap_kbps],
      ['routing table', row.wan_routing_table, next.wan_routing_table],
      ['retention', row.retention_days, next.retention_days],
      ['router key', row.router_public_key, next.router_public_key],
    ];
    const changed = fields.filter(([, a, c]) => a !== c).map(([f]) => f);
    if (changed.length > 0) auditLocation(req, user, 'location.update', id, `changed: ${changed.join(', ')}`);
    if (row.recording_paused !== next.recording_paused) {
      auditLocation(req, user, next.recording_paused === 1 ? 'location.recording_off' : 'location.recording_on', id);
    }
    if (loginChange !== null) auditLocation(req, user, CAMERA_LOGIN_ACTION, id, loginChange);
    const reachChanged =
      row.connector !== next.connector ||
      row.camera_subnet !== next.camera_subnet ||
      row.router_public_key !== next.router_public_key ||
      row.recording_paused !== next.recording_paused;
    await afterChange(req, id, reachChanged);
    return summary(requireRow(id), user, hasActiveKey());
  });

  /* DELETE /api/locations/:id {password} */
  app.delete<IdParams>('/api/locations/:id', async (req): Promise<OkResponse> => {
    const user = auth.requireOwner(req);
    const id = parseId(req.params.id);
    const row = requireRow(id);
    const b = bodyOf(req);
    if (typeof b.password !== 'string' || b.password.length === 0 || b.password.length > PASSWORD_MAX_LENGTH) {
      throw invalid('Enter your password to delete a location.');
    }
    if (!(await auth.verifyPassword(user.id, b.password))) {
      throw new HttpError(422, 'wrong_password', 'Wrong password.');
    }
    const cameraIds = (db.prepare('SELECT id FROM cameras WHERE location_id = ?').all(id) as Array<{ id: number }>).map((c) =>
      Number(c.id),
    );
    db.prepare('DELETE FROM locations WHERE id = ?').run(id);
    auditLocation(req, user, 'location.delete', id, row.name);
    await connectors.onLocationChanged(id);
    for (const cameraId of cameraIds) {
      try {
        await media.removeCamera(cameraId);
      } catch (err) {
        req.log.warn({ err, cameraId }, 'media cleanup after a location delete failed; the next reconcile retries');
      }
    }
    try {
      await media.applyLocation(id);
    } catch (err) {
      req.log.warn({ err, locationId: id }, 'media update after a location delete failed; the next reconcile retries');
    }
    return { ok: true };
  });

  /* GET /api/locations/:id/setup */
  app.get<IdParams>('/api/locations/:id/setup', async (req): Promise<LocationSetup> => {
    auth.requireOwner(req);
    const id = parseId(req.params.id);
    const row = requireRow(id);
    const status = connectors.locationStatus(id);
    if (row.connector === 'router') {
      const wgc = config.wireguard;
      if (!wgc.enabled || !isWireguardKey(wgc.publicKey) || parseIpv4(config.publicIp) === null) {
        throw new HttpError(503, 'unavailable', "This hub's WireGuard settings are incomplete (public IP or hub key missing).");
      }
      if (row.slot === null) throw new HttpError(409, 'conflict', 'This router location has no slot; save it again.');
      const input = {
        locationId: id,
        slot: row.slot,
        cameraSubnet: row.camera_subnet ?? '',
        hubPublicKey: wgc.publicKey,
        hubIp: config.publicIp,
        hubPort: wgc.listenPort,
        uploadCapKbps: row.upload_cap_kbps,
        routingTable: row.wan_routing_table,
      };
      try {
        return {
          connector: 'router',
          router: {
            slot: row.slot,
            routerOsScript: routerOsScript(input),
            routerOsUndoScript: routerOsUndoScript(),
            genericWireguardConfig: genericWireguardConfig(input),
            routerPublicKeySet: row.router_public_key !== null,
            tunnelUp: status.online,
            lastHandshake: iso(status.lastSeen),
          },
        };
      } catch (err) {
        if (err instanceof RouterScriptError) throw invalid(err.message);
        throw err;
      }
    }
    if (row.connector === 'bridge') {
      const bridge: BridgeSetup = {
        connected: status.online,
        lastSeen: iso(status.lastSeen),
        downloadUrl: config.bridgeDownloadUrl,
        command: bridgeCommand('<token>'),
        hasToken: row.bridge_token_hash !== null,
      };
      return { connector: 'bridge', bridge };
    }
    return {
      connector: 'direct',
      direct: {
        note:
          'The hub reaches these cameras on its own network. Detection scans the camera network set for this location (at most a /24).',
      },
    };
  });

  /* POST /api/locations/:id/bridge-token */
  app.post<IdParams>('/api/locations/:id/bridge-token', async (req): Promise<BridgeTokenResponse> => {
    const user = auth.requireOwner(req);
    const id = parseId(req.params.id);
    const row = requireRow(id);
    if (row.connector !== 'bridge') throw invalid('This location does not use the bridge connector.');
    const command = bridgeCommand('<token>');
    const token = newBridgeToken();
    db.prepare('UPDATE locations SET bridge_token_hash = ? WHERE id = ?').run(hashBridgeToken(token), id);
    auditLocation(req, user, 'location.bridge_token', id);
    await afterChange(req, id, false);
    return { token, command: command.replace('<token>', token) };
  });

  /* POST /api/locations/:id/detect */
  app.post<IdParams>('/api/locations/:id/detect', async (req): Promise<DetectResponse> => {
    const user = auth.requireOwner(req);
    const id = parseId(req.params.id);
    requireRow(id);
    if (detectRunning.has(id)) throw new HttpError(409, 'conflict', 'Detection is already running for this location.');
    const now = Date.now();
    const recent = (detectHistory.get(id) ?? []).filter((t) => now - t < 3600_000);
    if (recent.length >= DETECT_MAX_PER_HOUR) {
      throw new HttpError(429, 'throttled', `Detection can run at most ${DETECT_MAX_PER_HOUR} times an hour per location.`);
    }
    recent.push(now);
    detectHistory.set(id, recent);
    detectRunning.add(id);
    try {
      const result = await connectors.detect(id);
      auditLocation(req, user, 'location.detect', id, `found ${result.devices.length} of ${result.scanned} scanned`);
      return result;
    } catch (err) {
      auditLocation(req, user, 'location.detect', id, 'failed');
      throw err;
    } finally {
      detectRunning.delete(id);
    }
  });
};
