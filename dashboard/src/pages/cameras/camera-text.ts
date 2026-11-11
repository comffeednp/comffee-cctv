// Plain words, option lists and light input checks for the camera screens. The hub does the full checks.

import type { DetectedDevice, Quality, StreamInfo, Vendor } from '../../../../shared/api-types.ts';
import type { SelectOption } from '../../components/index.ts';

export interface VendorInfo {
  value: Vendor;
  label: string;
  detail: string;
}

export const VENDORS: readonly VendorInfo[] = [
  { value: 'tapo', label: 'Tapo', detail: 'TP-Link Tapo cameras' },
  { value: 'onvif', label: 'Other ONVIF camera', detail: 'Most IP cameras from other brands' },
  { value: 'custom', label: 'Other', detail: 'Any camera with an RTSP video address' },
];

export function vendorLabel(vendor: Vendor): string {
  return VENDORS.find((item) => item.value === vendor)?.label ?? 'Camera';
}

export const TAPO_ACCOUNT_HINT = 'The camera account from the Tapo app: Camera settings, Advanced settings, Camera account.';
export const OTHER_ACCOUNT_HINT = "The user name and password used to sign in to the camera's own settings.";

/** Tapo cameras: video on 554, ONVIF on 2020, main "/stream1", sub "/stream2". */
export const TAPO_RTSP_PORT = 554;
export const TAPO_ONVIF_PORT = 2020;

export const QUALITY_HINTS: Record<Quality, string> = {
  '360p': 'Sub stream. About 0.4 Mbps upload and about 4 GB of storage a day.',
  '720p': 'Main stream, made smaller by the hub. About 2 Mbps upload and about 3 GB of storage a day.',
  '1080p': 'Main stream as it is. About 2 Mbps upload and about 20 GB of storage a day.',
};

export const QUALITY_OPTIONS: readonly SelectOption<Quality>[] = [
  { value: '360p', label: '360p', detail: 'Least upload' },
  { value: '720p', label: '720p', detail: 'Clear picture, little storage' },
  { value: '1080p', label: '1080p', detail: 'Sharpest, most storage' },
];

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Problem with a camera LAN address, or null. Cameras must be on a private network. */
export function ipProblem(value: string): string | null {
  const text = value.trim();
  if (!text) return "Type the camera's local address, like 192.168.1.20.";
  const match = IPV4.exec(text);
  if (!match) return 'Write it like 192.168.1.20.';
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return 'Each number must be 0 to 255.';
  const [a, b] = parts;
  const isPrivate = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  if (!isPrivate) return 'Use the local address the camera has on the business network (10.x, 172.16-31.x or 192.168.x).';
  return null;
}

/** Problem with a port, or null. Empty is allowed when `optional`. */
export function portProblem(value: string, optional: boolean): string | null {
  const text = value.trim();
  if (!text) return optional ? null : 'Type a port number, like 554.';
  if (!/^\d{1,5}$/.test(text) || Number(text) < 1 || Number(text) > 65535) return 'Use a number from 1 to 65535.';
  return null;
}

/** Problem with an RTSP path, or null. Empty is allowed when `optional`. */
export function pathProblem(value: string, optional: boolean): string | null {
  const text = value.trim();
  if (!text) return optional ? null : 'Type the path, like /stream1.';
  if (!text.startsWith('/')) return 'Start the path with a slash, like /stream1.';
  if (/\s/.test(text) || text.length > 200) return 'Use the path without spaces, as the camera maker gives it.';
  return null;
}

export function nameProblem(value: string): string | null {
  const text = value.trim();
  if (!text) return 'Give the camera a name, like Front door.';
  if (text.length > 64) return 'Keep the name under 64 characters.';
  return null;
}

/** "1920 x 1080, H264, 15 fps" or the plain reason it failed. */
export function streamSummary(info: StreamInfo): string {
  if (!info.ok) return info.error ? info.error.replace(/\.?$/, '.') : 'No video came back.';
  const parts: string[] = [];
  if (info.width && info.height) parts.push(`${info.width} x ${info.height}`);
  if (info.codec) parts.push(info.codec.toUpperCase());
  if (info.fps) parts.push(`${Math.round(info.fps)} fps`);
  return parts.length ? parts.join(', ') : 'Video works.';
}

/**
 * True when a found device can be added in one tap with the location's saved camera login. Only Tapo
 * cameras: their video paths are known. Other brands go through the add flow, where the paths are typed.
 */
export function canQuickAdd(device: DetectedDevice): boolean {
  return device.guessVendor === 'tapo';
}

/** The hub's reason a camera was not added, as one sentence. */
export function failureWords(error: string): string {
  const text = error.trim();
  if (!text) return 'No video came back.';
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** What detection found at one address, in plain words. */
export function deviceWords(device: DetectedDevice): string {
  if (device.guessVendor === 'tapo') return 'Looks like a Tapo camera';
  if (device.rtsp && device.onvif) return 'Camera with video and ONVIF';
  if (device.onvif) return 'ONVIF device, video port not found';
  if (device.rtsp) return 'Video stream (RTSP)';
  return 'Device found';
}
