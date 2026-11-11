/**
 * ConnectorService: how the hub reaches the cameras of each location.
 * - router: WireGuard peer per location (slot S), cameras at 10.78.S.<last octet>.
 * - bridge: the location's bridge program relays TCP through the /bridge WebSocket (bridge-hub.ts).
 * - direct: the hub reaches camera IPs itself.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { DetectResponse } from '../../../shared/api-types.ts';
import { isAllowedBridgeTarget, parseIpv4, type BridgeDetectedDevice } from '../../../shared/bridge-protocol.ts';
import { HttpError, type ConnectorDeps, type ConnectorService, type CreateConnectorService } from '../contracts.ts';
import { BridgeHub, attachBridgeHub, markAlreadyAdded } from './bridge-hub.ts';
import {
  checkRouterCameraSubnet,
  checkSmallCameraSubnet,
  intToIpv4,
  isPort,
  isValidSlot,
  isWireguardKey,
  networkContains,
  networkHosts,
  routerMappedAddress,
  type Ipv4Network,
} from './net.ts';
import { onvifDeviceInfo } from './onvif.ts';
import { scanTargets, type ProbeTarget } from './probe.ts';
import { TUNNEL_UP_WINDOW_MS, WireGuard, type CommandRunner, type Peer } from './wireguard.ts';

/** Ports the router firewall opens from the tunnel to the camera network. */
export const ROUTER_PORTS: readonly number[] = [554, 2020];
const HANDSHAKE_POLL_MS = 30_000;

interface LocationRow {
  id: number;
  connector: 'router' | 'bridge' | 'direct';
  slot: number | null;
  camera_subnet: string | null;
  router_public_key: string | null;
  last_seen_at: number | null;
}

export interface ConnectorOptions {
  /** Runs `wg` and `ip` (tests pass a fake). */
  runCommand?: CommandRunner;
}

function warn(message: string, err?: unknown): void {
  const detail = err instanceof Error ? `: ${err.message}` : '';
  console.warn(`comffee-cctv connectors: ${message}${detail}`);
}

function getLocation(db: DatabaseSync, id: number): LocationRow | undefined {
  const row = db
    .prepare('SELECT id, connector, slot, camera_subnet, router_public_key, last_seen_at FROM locations WHERE id = ?')
    .get(id) as LocationRow | undefined;
  if (!row) return undefined;
  return {
    ...row,
    id: Number(row.id),
    slot: row.slot === null ? null : Number(row.slot),
    last_seen_at: row.last_seen_at === null ? null : Number(row.last_seen_at),
  };
}

function wantedPeer(row: LocationRow | undefined): Peer | null {
  if (!row || row.connector !== 'router') return null;
  if (!isValidSlot(row.slot) || !isWireguardKey(row.router_public_key)) return null;
  return { slot: row.slot, publicKey: row.router_public_key };
}

export function createConnectorServiceWith(deps: ConnectorDeps, opts: ConnectorOptions = {}): ConnectorService {
  const { db, config } = deps;
  const wg = new WireGuard(config.wireguard, opts.runCommand);
  const bridge = new BridgeHub(db);
  /** Peers currently applied on the hub interface, by location id. */
  const applied = new Map<number, Peer>();
  let handshakes = new Map<string, number>();
  let handshakesAt = 0;
  let pollTimer: NodeJS.Timeout | null = null;

  const requireLocation = (id: number): LocationRow => {
    const row = Number.isInteger(id) && id > 0 ? getLocation(db, id) : undefined;
    if (!row) throw new HttpError(404, 'not_found', 'Location not found.');
    return row;
  };

  /** Brings one location's hub peer in line with the database. */
  async function syncPeer(locationId: number): Promise<void> {
    if (!wg.enabled) return;
    const want = wantedPeer(getLocation(db, locationId));
    const have = applied.get(locationId) ?? null;
    const same = have !== null && want !== null && have.slot === want.slot && have.publicKey === want.publicKey;
    if (same) return;
    if (have) {
      await wg.removePeer(have);
      applied.delete(locationId);
      // Another location may hold the same slot now; put its route back.
      for (const other of applied.values()) if (other.slot === have.slot) await wg.applyPeer(other);
    }
    if (want) {
      await wg.applyPeer(want);
      applied.set(locationId, want);
    }
  }

  async function syncAll(): Promise<void> {
    if (!wg.enabled) return;
    const rows = db.prepare("SELECT id FROM locations WHERE connector = 'router'").all() as Array<{ id: number }>;
    const ids = new Set<number>([...rows.map((r) => Number(r.id)), ...applied.keys()]);
    for (const id of ids) {
      try {
        await syncPeer(id);
      } catch (err) {
        warn(`could not apply the tunnel peer of location ${id}`, err);
      }
    }
  }

  async function pollHandshakes(): Promise<void> {
    if (!wg.enabled) return;
    try {
      handshakes = await wg.latestHandshakes();
      handshakesAt = Date.now();
    } catch (err) {
      warn('could not read WireGuard handshakes', err);
      return;
    }
    const update = db.prepare(
      'UPDATE locations SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)',
    );
    for (const [locationId, peer] of applied) {
      const at = handshakes.get(peer.publicKey);
      if (at !== undefined) update.run(at, locationId, at);
    }
  }

  async function tick(): Promise<void> {
    await syncAll();
    await pollHandshakes();
  }

  function routerStatus(row: LocationRow): { online: boolean; lastSeen: number | null } {
    const peer = applied.get(row.id);
    const at = peer ? handshakes.get(peer.publicKey) : undefined;
    if (at !== undefined) return { online: Date.now() - at < TUNNEL_UP_WINDOW_MS, lastSeen: at };
    return { online: false, lastSeen: row.last_seen_at };
  }

  function routerReady(row: LocationRow): { slot: number; net: Ipv4Network } {
    if (!wg.enabled) {
      throw new HttpError(503, 'unavailable', 'This hub has no WireGuard tunnel set up, so the router connector cannot be used.');
    }
    if (!isValidSlot(row.slot) || !isWireguardKey(row.router_public_key)) {
      throw new HttpError(
        503,
        'unavailable',
        "The router tunnel for this location is not set up yet. Run the router script and paste the router's key.",
      );
    }
    const net = subnetOf(row);
    if (!net) throw new HttpError(422, 'invalid_input', 'Set the camera network of this location first (exactly a /24).');
    return { slot: row.slot, net };
  }

  function subnetOf(row: LocationRow): Ipv4Network | null {
    const r = checkRouterCameraSubnet(row.camera_subnet ?? '');
    return 'error' in r ? null : r.net;
  }

  const service: ConnectorService = {
    async start() {
      bridge.start();
      if (!wg.enabled) return;
      try {
        // Remove peers this hub made for locations that no longer want them, then apply every wanted peer.
        const rows = db.prepare("SELECT id FROM locations WHERE connector = 'router'").all() as Array<{ id: number }>;
        const wanted = rows.map((r) => wantedPeer(getLocation(db, Number(r.id)))).filter((p): p is Peer => p !== null);
        for (const peer of await wg.listManagedPeers()) {
          if (!wanted.some((w) => w.publicKey === peer.publicKey && w.slot === peer.slot)) await wg.removePeer(peer);
        }
      } catch (err) {
        warn('could not clean up old tunnel peers', err);
      }
      await tick();
      pollTimer = setInterval(() => void tick(), HANDSHAKE_POLL_MS);
      pollTimer.unref();
    },

    async stop() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      await bridge.stop();
    },

    async resolveCameraAddress(locationId, lanIp, port) {
      const row = requireLocation(locationId);
      if (parseIpv4(lanIp) === null) throw new HttpError(422, 'invalid_input', 'The camera IP must be an IPv4 address.');
      if (!isPort(port)) throw new HttpError(422, 'invalid_input', 'The camera port must be 1 to 65535.');
      switch (row.connector) {
        case 'direct':
          return { host: lanIp, port };
        case 'router': {
          const { slot, net } = routerReady(row);
          if (!networkContains(net, lanIp)) {
            throw new HttpError(422, 'invalid_input', `The camera IP is outside this location's camera network ${net.cidr}.`);
          }
          if (!ROUTER_PORTS.includes(port)) {
            throw new HttpError(422, 'invalid_input', 'Through the router tunnel only ports 554 (RTSP) and 2020 (ONVIF) are open.');
          }
          return { host: routerMappedAddress(slot, lanIp), port };
        }
        case 'bridge': {
          if (!isAllowedBridgeTarget(lanIp, port)) {
            throw new HttpError(
              422,
              'invalid_input',
              'The bridge only reaches private IPv4 addresses on ports 554, 2020, 80 and 8000.',
            );
          }
          if (!bridge.isConnected(locationId)) {
            throw new HttpError(503, 'unavailable', 'The bridge for this location is not connected.');
          }
          return bridge.relayAddress(locationId, lanIp, port);
        }
        default:
          throw new HttpError(422, 'invalid_input', 'Unknown connector.');
      }
    },

    async detect(locationId): Promise<DetectResponse> {
      const started = Date.now();
      const row = requireLocation(locationId);
      let devices: BridgeDetectedDevice[];
      let scanned: number;
      if (row.connector === 'bridge') {
        const result = await bridge.detect(locationId);
        devices = result.devices;
        scanned = result.scanned;
      } else {
        let targets: ProbeTarget[];
        if (row.connector === 'router') {
          const { slot, net } = routerReady(row);
          if (Date.now() - handshakesAt > 5_000) await pollHandshakes();
          if (!routerStatus(row).online) {
            throw new HttpError(503, 'unavailable', 'The router tunnel of this location is not connected right now.');
          }
          targets = [];
          for (let h = 1; h <= 254; h++) targets.push({ probeHost: `10.78.${slot}.${h}`, ip: intToIpv4(net.base + h) });
        } else {
          const r = checkSmallCameraSubnet(row.camera_subnet ?? '', false);
          if ('error' in r) {
            throw new HttpError(422, 'invalid_input', 'Set the camera network of this location first (at most a /24).');
          }
          targets = networkHosts(r.net).map((ip) => ({ probeHost: ip, ip }));
        }
        devices = await scanTargets(targets);
        scanned = targets.length;
      }
      return { devices: markAlreadyAdded(db, locationId, devices), scanned, tookMs: Date.now() - started };
    },

    async deviceInfo(locationId, lanIp, onvifPort, username, password) {
      requireLocation(locationId);
      let addr: { host: string; port: number };
      try {
        addr = await service.resolveCameraAddress(locationId, lanIp, onvifPort);
      } catch {
        return null;
      }
      return onvifDeviceInfo({ host: addr.host, port: addr.port, hostHeader: `${lanIp}:${onvifPort}` }, username, password);
    },

    locationStatus(locationId) {
      const row = getLocation(db, locationId);
      if (!row) return { online: false, lastSeen: null };
      if (row.connector === 'direct') return { online: true, lastSeen: null };
      if (row.connector === 'bridge') return bridge.status(locationId);
      return routerStatus(row);
    },

    async onLocationChanged(locationId) {
      try {
        await syncPeer(locationId);
      } catch (err) {
        warn(`could not apply the tunnel peer of location ${locationId}; retrying in the background`, err);
      }
      await bridge.locationChanged(locationId);
    },
  };

  attachBridgeHub(service, bridge);
  return service;
}

export const createConnectorService: CreateConnectorService = (deps) => createConnectorServiceWith(deps);
