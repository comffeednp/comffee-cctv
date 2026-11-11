// Plain words and option lists for location screens.

import type { ConnectorKind, LocationSummary } from '../../../../shared/api-types.ts';
import type { IconName, SelectOption } from '../../components/index.ts';
import { browserTimezone } from '../../lib/format.ts';

export interface ConnectorInfo {
  kind: ConnectorKind;
  label: string;
  short: string;
  detail: string;
  icon: IconName;
}

export const CONNECTORS: readonly ConnectorInfo[] = [
  {
    kind: 'router',
    label: 'Router tunnel (MikroTik or WireGuard router)',
    short: 'Router tunnel',
    detail: 'Your router sends the camera video to the hub. Nothing is stored at the business and no computer has to stay on.',
    icon: 'router',
  },
  {
    kind: 'bridge',
    label: 'Bridge program on an always-on device',
    short: 'Bridge program',
    detail: 'A small program on a computer or mini PC at the business that stays on. Use this if your router cannot make the tunnel.',
    icon: 'link',
  },
  {
    kind: 'direct',
    label: 'Direct (hub is on the same network)',
    short: 'Direct',
    detail: 'Only when the hub itself sits on the same network as the cameras.',
    icon: 'cloud',
  },
];

export function connectorInfo(kind: ConnectorKind): ConnectorInfo {
  return CONNECTORS.find((item) => item.kind === kind) ?? CONNECTORS[0];
}

/** "Recording", "Paused" or "Not recording", for list rows. */
export function recordingWord(location: LocationSummary): string {
  if (location.recordingPaused) return 'Recording paused';
  if (location.recordingCameraCount > 0) return 'Recording on';
  return 'Not recording';
}

let zoneOptions: SelectOption<string>[] | null = null;

/** Every IANA timezone the browser knows, labelled "Asia / Manila", with the browser's own zone included. */
export function timezoneOptions(): SelectOption<string>[] {
  if (zoneOptions) return zoneOptions;
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = [];
  }
  const own = browserTimezone();
  const all = new Set(zones);
  all.add(own);
  all.add('UTC');
  zoneOptions = [...all].sort().map((zone) => ({ value: zone, label: zone.replace(/_/g, ' ').replace(/\//g, ' / ') }));
  return zoneOptions;
}

/** Light shape check of an IPv4 network like 192.168.1.0/24; the hub does the full check. */
export function subnetProblem(value: string, connector: ConnectorKind): string | null {
  const text = value.trim();
  if (!text) return connector === 'bridge' ? null : 'Type the camera network, like 192.168.1.0/24.';
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(text);
  if (!match) return 'Write it like 192.168.1.0/24.';
  if (match.slice(1, 5).some((part) => Number(part) > 255)) return 'Each number must be 0 to 255.';
  const prefix = Number(match[5]);
  if (connector === 'router' && prefix !== 24) return 'The router tunnel needs a network ending in /24.';
  if (prefix < 24 || prefix > 32) return 'Use a network of /24 or smaller.';
  return null;
}
