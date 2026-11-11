// One camera in the "All cameras" grid: live video, name, status, quality, full screen and (owner) the recording
// switch. Tapping the picture opens the camera big. The stream only runs while the tile is on screen and the tab
// is visible, which saves data on phones.

import { useRef, useState } from 'preact/hooks';
import type { CameraSummary, LocationSummary } from '../../../../shared/api-types.ts';
import { Badge, IconButton, StatusDot, Toggle } from '../../components/index.ts';
import { apiSend, describeError } from '../../lib/api.ts';
import { cameraStatus } from './camera-status.ts';
import { LiveStateOverlay, useFullscreen, useLiveVideo, useOnScreen } from './LiveVideo.tsx';

export interface CameraTileProps {
  camera: CameraSummary;
  location: LocationSummary;
  owner: boolean;
  /** Missing recovery key: recording cannot start yet. */
  noVaultKey: boolean;
  onChanged: (camera: CameraSummary) => void;
  onError: (message: string) => void;
  /** Opens this camera in the big view. */
  onOpen?: () => void;
}

/** The note under a camera's recording switch. */
export function recordingNote(camera: CameraSummary, location: LocationSummary, noVaultKey: boolean): string | undefined {
  if (camera.recording && noVaultKey) return 'Starts once the recovery key is set up';
  if (camera.recording && location.recordingPaused) return 'Location recording is paused';
  if (camera.effectiveRecording) return 'Saved encrypted to the cloud';
  return undefined;
}

export function CameraTile({ camera, location, owner, noVaultKey, onChanged, onError, onOpen }: CameraTileProps) {
  const tileRef = useRef<HTMLElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const active = useOnScreen(tileRef);
  const live = useLiveVideo(camera, active, `Live video of ${camera.name}`);
  const [fullscreen, toggleFullscreen] = useFullscreen(frameRef, live.frontVideo);
  const [saving, setSaving] = useState(false);

  const setRecording = async (recording: boolean) => {
    setSaving(true);
    try {
      onChanged(await apiSend<CameraSummary>('PATCH', `/api/cameras/${camera.id}`, { recording }));
    } catch (err) {
      onError(describeError(err, { not_found: 'This camera was removed.' }));
    } finally {
      setSaving(false);
    }
  };

  const status = cameraStatus(camera, location);

  return (
    <article ref={tileRef} class="live-tile" aria-label={camera.name}>
      <div ref={frameRef} class="media-16x9 live-frame">
        {live.videos}
        {onOpen && !fullscreen ? (
          <button type="button" class="live-open" onClick={onOpen}>
            <span class="sr-only">Watch {camera.name}</span>
          </button>
        ) : null}
        <LiveStateOverlay live={live} camera={camera} />
        <div class="live-tools">
          <IconButton
            icon={fullscreen ? 'exit-fullscreen' : 'fullscreen'}
            label={fullscreen ? 'Leave full screen' : 'Full screen'}
            variant="overlay"
            onClick={toggleFullscreen}
          />
        </div>
        <div class="media-overlay">
          <span class="truncate grow fw-semibold">{camera.name}</span>
          <Badge class="shrink-0">{camera.quality}</Badge>
          <StatusDot class="shrink-0" status={status.status} label={status.label} />
        </div>
      </div>
      {owner ? (
        <Toggle
          label="Record this camera"
          description={recordingNote(camera, location, noVaultKey)}
          checked={camera.recording}
          busy={saving}
          onChange={(next) => void setRecording(next)}
        />
      ) : null}
    </article>
  );
}
