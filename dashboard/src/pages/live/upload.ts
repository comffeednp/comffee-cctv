// Rough upload use of a location's cameras, for the hints next to recording and quality switches.
// 360p pulls the camera's sub stream; 720p and 1080p pull the main stream (720p is converted on the hub).

import type { CameraSummary, Quality } from '../../../../shared/api-types.ts';

export const UPLOAD_MBPS: Record<Quality, number> = { '360p': 0.4, '720p': 2, '1080p': 2 };

export const UPLOAD_RATE_NOTE = 'About 0.4 Mbps per camera at 360p, about 2 Mbps per camera at 720p or 1080p.';

/** Upload while recording, in Mbps, for the cameras whose own recording switch is on. */
export function recordingUploadMbps(cameras: readonly CameraSummary[]): number {
  return cameras.reduce((sum, camera) => sum + (camera.recording ? UPLOAD_MBPS[camera.quality] : 0), 0);
}

/** "0.8 Mbps", "6 Mbps". */
export function formatMbps(mbps: number): string {
  const rounded = Math.round(mbps * 10) / 10;
  return `${rounded.toFixed(rounded % 1 === 0 ? 0 : 1)} Mbps`;
}
