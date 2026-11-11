/**
 * Router connector setup text: the RouterOS 7 script, its undo script and a generic WireGuard config.
 *
 * Every value that ends up in the text is validated first (numbers are integers in range, keys are
 * canonical 44-character base64, addresses are strict dotted quads, the routing table name is
 * [A-Za-z0-9_-]{1,32}), so nothing a user typed can break out of a quoted value or start a new command.
 */

import { HUB_TUNNEL_IP, ROUTER_COMMENT, mappedCameraSubnet, routerTunnelIp } from '../contracts.ts';
import { parseIpv4 } from '../../../shared/bridge-protocol.ts';
import { checkRouterCameraSubnet, isPort, isRoutingTableName, isValidSlot, isWireguardKey } from './net.ts';

export const ROUTER_INTERFACE = 'wg-cctv';
export const UPLOAD_CAP_MIN_KBPS = 100;
export const UPLOAD_CAP_MAX_KBPS = 1_000_000;

export interface RouterScriptInput {
  locationId: number;
  slot: number;
  /** Camera network, exactly a /24 (host bits are cleared). */
  cameraSubnet: string;
  /** Hub WireGuard public key (config.wireguard.publicKey). */
  hubPublicKey: string;
  /** Hub public IPv4 (config.publicIp). */
  hubIp: string;
  /** Hub WireGuard UDP port (config.wireguard.listenPort). */
  hubPort: number;
  uploadCapKbps: number;
  /** Optional RouterOS routing table for the tunnel's own packets. */
  routingTable: string | null;
}

/** Thrown when a value is not safe to put into router setup text. */
export class RouterScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouterScriptError';
  }
}

/** Checks every field and returns a normalised copy (camera subnet as network address). */
export function validateRouterScriptInput(input: RouterScriptInput): RouterScriptInput {
  if (!Number.isInteger(input.locationId) || input.locationId < 1) throw new RouterScriptError('Invalid location id.');
  if (!isValidSlot(input.slot)) throw new RouterScriptError('Invalid router slot.');
  const subnet = checkRouterCameraSubnet(input.cameraSubnet);
  if ('error' in subnet) throw new RouterScriptError(subnet.error);
  if (!isWireguardKey(input.hubPublicKey)) throw new RouterScriptError('The hub WireGuard public key is missing or invalid.');
  const ip = parseIpv4(input.hubIp);
  if (!ip || input.hubIp === '0.0.0.0') throw new RouterScriptError('The hub public IP is missing or invalid.');
  if (!isPort(input.hubPort)) throw new RouterScriptError('The hub WireGuard port is invalid.');
  if (
    !Number.isInteger(input.uploadCapKbps) ||
    input.uploadCapKbps < UPLOAD_CAP_MIN_KBPS ||
    input.uploadCapKbps > UPLOAD_CAP_MAX_KBPS
  ) {
    throw new RouterScriptError(`Upload cap must be a whole number from ${UPLOAD_CAP_MIN_KBPS} to ${UPLOAD_CAP_MAX_KBPS} kbps.`);
  }
  if (input.routingTable !== null && !isRoutingTableName(input.routingTable)) {
    throw new RouterScriptError('Routing table names may use only letters, digits, "_" and "-" (at most 32).');
  }
  return { ...input, cameraSubnet: subnet.net.cidr };
}

const C = `comment="${ROUTER_COMMENT}"`;

/** RouterOS lines that add one item at the top of a list, also when the list is empty. */
function addAtTop(menu: string, args: string): string[] {
  return [
    `:set ids [${menu} find where dynamic=no]`,
    ':if ([:len $ids] = 0) do={',
    `  ${menu} add ${args} ${C}`,
    '} else={',
    `  ${menu} add ${args} ${C} place-before=[:pick $ids 0]`,
    '}',
  ];
}

/** Lines that remove every item this setup created (the WireGuard interface is listed separately). */
function removeTagged(): string[] {
  return [
    `/queue simple remove [find where ${C}]`,
    `/ip firewall mangle remove [find where ${C}]`,
    `/ip firewall filter remove [find where ${C}]`,
    `/ip firewall nat remove [find where ${C}]`,
    `/ip address remove [find where ${C}]`,
    `/interface wireguard peers remove [find where ${C}]`,
  ];
}

/** RouterOS 7 setup script for one router location. */
export function routerOsScript(raw: RouterScriptInput): string {
  const v = validateRouterScriptInput(raw);
  const iface = `"${ROUTER_INTERFACE}"`;
  const mapped = mappedCameraSubnet(v.slot);
  const cap = `${v.uploadCapKbps}k/${v.uploadCapKbps}k`;
  const listenPort = 52000 + v.slot;
  const lines: string[] = [
    `# Comffee CCTV router setup (RouterOS 7), location ${v.locationId}, slot ${v.slot}.`,
    `# The hub reaches the camera network ${v.cameraSubnet} as ${mapped} through the tunnel ${ROUTER_INTERFACE}.`,
    '# The tunnel may reach only that network on TCP 554 and 2020; everything else from it is dropped.',
    '# Paste all of this into a RouterOS terminal. Running it again replaces the earlier Comffee CCTV',
    `# setup and keeps this router's tunnel key. The undo script removes every item tagged ${C}.`,
    '{',
    ':local ids',
    ':if ([:pick [/system resource get version] 0 1] != "7") do={ :error "This script needs RouterOS 7." }',
  ];
  if (v.routingTable !== null) {
    lines.push(
      `:if ([:len [/routing table find where name="${v.routingTable}"]] = 0) do={ :error "Routing table ${v.routingTable} was not found on this router." }`,
    );
  }
  lines.push(
    ...removeTagged(),
    `:if ([:len [/interface wireguard find where name=${iface}]] = 0) do={`,
    `  /interface wireguard add name=${iface} listen-port=${listenPort} ${C}`,
    '}',
    `/interface wireguard peers add interface=${iface} public-key="${v.hubPublicKey}" endpoint-address=${v.hubIp} endpoint-port=${v.hubPort} allowed-address=${HUB_TUNNEL_IP}/32 persistent-keepalive=25s ${C}`,
    `/ip address add address=${routerTunnelIp(v.slot)}/16 interface=${iface} ${C}`,
    ...addAtTop(
      '/ip firewall nat',
      `chain=dstnat in-interface=${iface} dst-address=${mapped} action=netmap to-addresses=${v.cameraSubnet}`,
    ),
    // Each rule goes to the top, so the order below ends as: camera replies accept, forward accept,
    // forward drop, input drop.
    ...addAtTop('/ip firewall filter', `chain=input in-interface=${iface} action=drop`),
    ...addAtTop('/ip firewall filter', `chain=forward in-interface=${iface} action=drop`),
    ...addAtTop(
      '/ip firewall filter',
      `chain=forward in-interface=${iface} dst-address=${v.cameraSubnet} protocol=tcp dst-port=554,2020 action=accept`,
    ),
    // Camera replies leave through the tunnel. Accepting them here, above the router's own rules, keeps
    // tunnel connections out of FastTrack, which would otherwise skip the upload cap queue below.
    ...addAtTop(
      '/ip firewall filter',
      `chain=forward out-interface=${iface} src-address=${v.cameraSubnet} protocol=tcp src-port=554,2020 action=accept`,
    ),
    ...addAtTop('/queue simple', `name="${ROUTER_COMMENT}" target=${iface} max-limit=${cap} priority=8/8`),
  );
  if (v.routingTable !== null) {
    lines.push(
      ...addAtTop(
        '/ip firewall mangle',
        `chain=output protocol=udp dst-address=${v.hubIp} dst-port=${v.hubPort} action=mark-routing new-routing-mark="${v.routingTable}" passthrough=no`,
      ),
    );
  }
  lines.push(
    `:put ("Router public key: " . [/interface wireguard get [find where name=${iface}] public-key])`,
    ':put "Paste this key into the location page in Comffee CCTV."',
    '}',
    '',
  );
  return lines.join('\n');
}

/** Removes every item tagged comment="comffee-cctv", including the wg-cctv interface. */
export function routerOsUndoScript(): string {
  return [
    `# Comffee CCTV router undo (RouterOS 7): removes every item tagged ${C}.`,
    '{',
    ...removeTagged(),
    `/interface wireguard remove [find where ${C}]`,
    ':put "Comffee CCTV setup removed from this router."',
    '}',
    '',
  ].join('\n');
}

/** Plain WireGuard config for routers other than MikroTik. */
export function genericWireguardConfig(raw: RouterScriptInput): string {
  const v = validateRouterScriptInput(raw);
  const mapped = mappedCameraSubnet(v.slot);
  return [
    `# Comffee CCTV tunnel for location ${v.locationId} (slot ${v.slot}), for routers other than MikroTik.`,
    `# Important: this router must map ${mapped} one-to-one onto the camera network ${v.cameraSubnet}`,
    '# (destination NAT, also called netmap), let the tunnel reach only that network on TCP 554 and 2020,',
    '# and drop everything else that arrives from the tunnel, including traffic to the router itself.',
    `# Keep the tunnel upload at about ${v.uploadCapKbps} kbps or less.`,
    '# If this router cannot do that, use the bridge connector instead.',
    "# Replace the PrivateKey line with a key made on this router, then paste this router's public key",
    '# into the location page in Comffee CCTV.',
    '[Interface]',
    'PrivateKey = <private key made on this router>',
    `Address = ${routerTunnelIp(v.slot)}/16`,
    '',
    '[Peer]',
    `PublicKey = ${v.hubPublicKey}`,
    `Endpoint = ${v.hubIp}:${v.hubPort}`,
    `AllowedIPs = ${HUB_TUNNEL_IP}/32`,
    'PersistentKeepalive = 25',
    '',
  ].join('\n');
}
