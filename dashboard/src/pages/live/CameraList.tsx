// The camera picker of the workspace: a column on the left from 1024 px, a sheet that folds open at the top on
// phones. "All cameras" shows the grid; each camera row shows its status, and the owner can rename it in place.

import { useState } from 'preact/hooks';
import type { CameraSummary, LocationSummary } from '../../../../shared/api-types.ts';
import { Button, Icon, IconButton, Select, Spinner, StatusDot, cx } from '../../components/index.ts';
import type { SelectOption } from '../../components/index.ts';
import { plural } from '../../lib/format.ts';
import { cameraStatus } from './camera-status.ts';
import { RenameField } from './RenameField.tsx';

export interface CameraListProps {
  locations: LocationSummary[];
  location: LocationSummary;
  onLocation: (id: number) => void;
  /** Cameras of the chosen location; null while loading. */
  cameras: CameraSummary[] | null;
  /** Shown when the cameras did not load. */
  error: string | null;
  onRetry: () => void;
  /** null = All cameras. */
  selectedId: number | null;
  onSelect: (cameraId: number | null) => void;
  owner: boolean;
  /** Saves a new name; rejects with an Error whose message is shown under the field. */
  onRename: (camera: CameraSummary, name: string) => Promise<void>;
}

export function CameraList(props: CameraListProps) {
  const { locations, location, onLocation, cameras, error, onRetry, selectedId, onSelect, owner, onRename } = props;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const selected = selectedId === null ? null : (cameras?.find((camera) => camera.id === selectedId) ?? null);

  const pick = (cameraId: number | null) => {
    setOpen(false);
    onSelect(cameraId);
  };

  const locationOptions: SelectOption<number>[] = locations.map((item) => ({
    value: item.id,
    label: item.name,
    detail: item.online ? undefined : 'Offline',
  }));

  return (
    <nav class={cx('cam-sheet', open && 'cam-sheet-open')} aria-label="Cameras">
      <button type="button" class="cam-sheet-toggle" aria-expanded={open ? 'true' : 'false'} aria-controls="cam-sheet-body" onClick={() => setOpen(!open)}>
        <Icon name={selected ? 'cameras' : 'grid'} size={20} class="list-row-icon" />
        <span class="list-row-text">
          <span class="list-row-title">{selected ? selected.name : 'All cameras'}</span>
          <span class="list-row-secondary">{open ? 'Choose a camera' : 'Switch camera'}</span>
        </span>
        <Icon name="chevron-down" size={20} class="cam-sheet-chevron" />
      </button>
      <div id="cam-sheet-body" class="cam-sheet-body stack-8">
        {locations.length > 1 ? (
          <Select<number> aria-label="Location" value={location.id} options={locationOptions} onChange={onLocation} />
        ) : (
          <p class="k-body-s text-cream fw-bold truncate">{location.name}</p>
        )}
        {error && !cameras ? (
          <div class="stack-8">
            <p class="k-body-s">{error}</p>
            <div class="row">
              <Button icon="refresh" onClick={onRetry}>
                Try again
              </Button>
            </div>
          </div>
        ) : !cameras ? (
          <Spinner size={24} label="Loading cameras" />
        ) : (
          <ul class="grouped-list" role="list" aria-label={`Cameras at ${location.name}`}>
            <li class={cx('list-row cam-row', selectedId === null && 'list-row-selected')}>
              <button type="button" class="list-row-inner" aria-current={selectedId === null ? 'true' : undefined} onClick={() => pick(null)}>
                <Icon name="grid" size={20} class="list-row-icon" />
                <span class="list-row-text">
                  <span class="list-row-title">All cameras</span>
                  <span class="list-row-secondary">{plural(cameras.length, 'camera')}</span>
                </span>
              </button>
            </li>
            {cameras.map((camera) => {
              const status = cameraStatus(camera, location);
              const isSelected = camera.id === selectedId;
              if (editing === camera.id) {
                return (
                  <li key={camera.id} class="list-row cam-row-edit">
                    <RenameField
                      initial={camera.name}
                      label={`New name for ${camera.name}`}
                      onCancel={() => setEditing(null)}
                      onSave={async (name) => {
                        await onRename(camera, name);
                        setEditing(null);
                      }}
                    />
                  </li>
                );
              }
              return (
                <li key={camera.id} class={cx('list-row cam-row', isSelected && 'list-row-selected')}>
                  <button
                    type="button"
                    class="list-row-inner"
                    aria-current={isSelected ? 'true' : undefined}
                    title={`Watch ${camera.name}`}
                    onClick={() => pick(camera.id)}
                  >
                    <span class="list-row-text">
                      <span class="list-row-title">{camera.name}</span>
                      <StatusDot status={status.status} label={status.label} class="cam-row-status" />
                    </span>
                  </button>
                  {owner ? (
                    <IconButton icon="edit" label={`Rename ${camera.name}`} size="s" class="cam-row-rename" onClick={() => setEditing(camera.id)} />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {cameras && cameras.length === 0 ? (
          <p class="k-body-s">{owner ? 'No cameras here yet.' : 'The owner has not added cameras here yet.'}</p>
        ) : null}
        {owner && cameras ? (
          <div class="row">
            <Button variant="ghost" icon="plus" href={`/cameras/add?locationId=${location.id}`}>
              Add camera
            </Button>
          </div>
        ) : null}
      </div>
    </nav>
  );
}
