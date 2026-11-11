// Shared bits of the camera workspace: a camera's status word, renaming, and clip file names.

import type { CameraSummary, LocationSummary, RecordingItem } from '../../../../shared/api-types.ts';
import type { Status } from '../../components/index.ts';
import { apiSend, describeError } from '../../lib/api.ts';
import { dayKey } from '../../lib/format.ts';
import { fileClock } from '../recordings/time.ts';

/** Longest camera name the hub accepts. */
export const CAMERA_NAME_MAX = 80;

/** Online, recording, paused (recording is on but cannot run) or offline, with its word. */
export function cameraStatus(camera: CameraSummary, location: LocationSummary | null): { status: Status; label: string } {
  if (!camera.online) return { status: 'offline', label: 'Offline' };
  if (camera.effectiveRecording) return { status: 'recording', label: 'Recording' };
  if (camera.recording) return { status: 'paused', label: location?.recordingPaused ? 'Paused' : 'Not recording' };
  return { status: 'online', label: 'Online' };
}

/** Saves a new camera name (owner only). Throws a plain sentence on failure. */
export async function renameCamera(camera: CameraSummary, name: string): Promise<CameraSummary> {
  const next = name.trim();
  if (!next) throw new Error('Type a name for the camera.');
  try {
    return await apiSend<CameraSummary>('PATCH', `/api/cameras/${camera.id}`, { name: next });
  } catch (err) {
    throw new Error(describeError(err, { not_found: 'This camera was removed.', owner_only: 'Only the owner can rename cameras.' }));
  }
}

/** "Front_door_2026-11-12_14-05.mp4" */
export function clipFileName(item: RecordingItem, timeZone: string): string {
  const start = Date.parse(item.start);
  const name = item.cameraName.replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '') || `camera-${item.cameraId}`;
  return `${name}_${dayKey(start, timeZone)}_${fileClock(start, timeZone)}.mp4`;
}
