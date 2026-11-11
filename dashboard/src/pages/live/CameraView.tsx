// One camera, big: its name (the owner can rename it in place), live video right away, and a switch to its past
// footage on the same screen.

import type { ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';
import type { CameraSummary, LocationSummary } from '../../../../shared/api-types.ts';
import { Badge, IconButton, PageHeader, SegmentedControl, StatusDot, Toggle } from '../../components/index.ts';
import { apiSend, describeError } from '../../lib/api.ts';
import { cameraStatus } from './camera-status.ts';
import { recordingNote } from './CameraTile.tsx';
import { LiveStateOverlay, useFullscreen, useLiveVideo, useOnScreen } from './LiveVideo.tsx';
import { Playback } from './Playback.tsx';
import { RenameField } from './RenameField.tsx';

export type CameraMode = 'live' | 'playback';

export interface CameraViewProps {
  camera: CameraSummary;
  location: LocationSummary;
  owner: boolean;
  noVaultKey: boolean;
  mode: CameraMode;
  onMode: (mode: CameraMode) => void;
  /** A moment to open in playback (from a link). */
  startAt: { time: number; nonce: number } | null;
  onChanged: (camera: CameraSummary) => void;
  onRename: (camera: CameraSummary, name: string) => Promise<void>;
  onError: (message: string) => void;
}

interface LiveBigProps {
  camera: CameraSummary;
  location: LocationSummary;
  owner: boolean;
  noVaultKey: boolean;
  onChanged: (camera: CameraSummary) => void;
  onError: (message: string) => void;
  toolbar: ComponentChildren;
}

function LiveBig({ camera, location, owner, noVaultKey, onChanged, onError, toolbar }: LiveBigProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const active = useOnScreen(frameRef);
  const live = useLiveVideo(camera, active, `Live video of ${camera.name}`);
  const [fullscreen, toggleFullscreen] = useFullscreen(frameRef, live.frontVideo);
  const [saving, setSaving] = useState(false);
  const status = cameraStatus(camera, location);

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

  return (
    <div class="stack">
      {toolbar}
      <div ref={frameRef} class="media-16x9 live-frame">
        {live.videos}
        <LiveStateOverlay live={live} camera={camera} size={32} />
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
          {live.state === 'live' ? <span class="shrink-0 text-phosphor fw-semibold">Live</span> : null}
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
    </div>
  );
}

export function CameraView(props: CameraViewProps) {
  const { camera, location, owner, mode, onMode, startAt, onRename } = props;
  const [renaming, setRenaming] = useState(false);
  const status = cameraStatus(camera, location);
  const subtitle =
    mode === 'live'
      ? location.online
        ? `Live from ${location.name}.`
        : `${location.name} is offline right now.`
      : 'Past footage. Pick a day, then a time.';

  const header = renaming ? (
    <header class="page-header">
      <h1 class="sr-only">{camera.name}</h1>
      <RenameField
        class="cam-title-rename"
        initial={camera.name}
        label={`New name for ${camera.name}`}
        onCancel={() => setRenaming(false)}
        onSave={async (name) => {
          await onRename(camera, name);
          setRenaming(false);
        }}
      />
      <p class="k-lead">{subtitle}</p>
    </header>
  ) : (
    <PageHeader
      title={camera.name}
      subtitle={subtitle}
      status={<StatusDot status={status.status} label={status.label} />}
      actions={owner ? <IconButton icon="edit" label="Rename camera" variant="secondary" onClick={() => setRenaming(true)} /> : undefined}
    />
  );

  const toolbar = (
    <div class="cam-toolbar">
      <SegmentedControl<CameraMode>
        label="Show"
        value={mode}
        onChange={onMode}
        options={[
          { value: 'live', label: 'Live', icon: 'live' },
          { value: 'playback', label: 'Playback', icon: 'recordings' },
        ]}
      />
      <Badge size="s" class="shrink-0">
        {camera.quality}
      </Badge>
    </div>
  );

  return (
    <>
      {header}
      {mode === 'live' ? (
        <LiveBig key={camera.id} {...props} toolbar={toolbar} />
      ) : (
        <Playback
          key={camera.id}
          camera={camera}
          location={location}
          owner={owner}
          startAt={startAt}
          toolbar={toolbar}
          onBackToLive={() => onMode('live')}
        />
      )}
    </>
  );
}
