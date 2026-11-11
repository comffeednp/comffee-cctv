// One camera on the Cameras screen (owner only): status, recording switch, quality, test, edit and remove.

import { useState } from 'preact/hooks';
import type { CameraSummary, CameraTestResponse, OkResponse, Quality, UpdateCameraRequest } from '../../../../shared/api-types.ts';
import { Button, Card, Dialog, FormField, PasswordInput, Select, StatusDot, TextInput, Toggle, useToast } from '../../components/index.ts';
import { apiSend, describeError } from '../../lib/api.ts';
import {
  OTHER_ACCOUNT_HINT,
  QUALITY_HINTS,
  QUALITY_OPTIONS,
  TAPO_ACCOUNT_HINT,
  ipProblem,
  nameProblem,
  pathProblem,
  portProblem,
  streamSummary,
  vendorLabel,
} from './camera-text.ts';

export interface CameraCardProps {
  camera: CameraSummary;
  locationPaused: boolean;
  onChanged: (camera: CameraSummary) => void;
  onRemoved: (id: number) => void;
}

const CAMERA_ERRORS = { not_found: 'This camera was already removed.', conflict: 'Another camera here already uses that address.' };

function recordingNote(camera: CameraSummary, locationPaused: boolean): string {
  if (!camera.recording) return 'Live view only';
  if (camera.effectiveRecording) return 'Saved encrypted to the cloud';
  if (locationPaused) return 'Location recording is paused';
  return 'Starts once the recovery key is set up';
}

interface EditForm {
  name: string;
  lanIp: string;
  rtspPort: string;
  mainPath: string;
  subPath: string;
  username: string;
  password: string;
}

function formFrom(camera: CameraSummary): EditForm {
  return {
    name: camera.name,
    lanIp: camera.lanIp,
    rtspPort: String(camera.rtspPort),
    mainPath: camera.mainPath,
    subPath: camera.subPath ?? '',
    username: camera.username ?? '',
    password: '',
  };
}

export function CameraCard({ camera, locationPaused, onChanged, onRemoved }: CameraCardProps) {
  const toast = useToast();
  const [savingRecording, setSavingRecording] = useState(false);
  const [savingQuality, setSavingQuality] = useState(false);
  const [testing, setTesting] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState<EditForm>(() => formFrom(camera));
  const [formErrors, setFormErrors] = useState<Partial<Record<keyof EditForm, string>>>({});
  const [editError, setEditError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | undefined>();
  const custom = camera.vendor !== 'tapo';

  const patch = async (body: UpdateCameraRequest): Promise<CameraSummary> => {
    const next = await apiSend<CameraSummary>('PATCH', `/api/cameras/${camera.id}`, body);
    onChanged(next);
    return next;
  };

  const setRecording = async (recording: boolean) => {
    setSavingRecording(true);
    try {
      await patch({ recording });
      toast.show({ message: recording ? 'Recording turned on.' : 'Recording turned off.', tone: 'success' });
    } catch (err) {
      toast.show({ message: describeError(err, CAMERA_ERRORS), tone: 'error' });
    } finally {
      setSavingRecording(false);
    }
  };

  const setQuality = async (quality: Quality) => {
    if (quality === camera.quality) return;
    setSavingQuality(true);
    try {
      await patch({ quality });
      toast.show({ message: `Quality set to ${quality}.`, tone: 'success' });
    } catch (err) {
      toast.show({ message: describeError(err, CAMERA_ERRORS), tone: 'error' });
    } finally {
      setSavingQuality(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      const result = await apiSend<CameraTestResponse>('POST', `/api/cameras/${camera.id}/test`, {});
      if (result.main.ok) toast.show({ message: `${camera.name} works: ${streamSummary(result.main)}.`, tone: 'success' });
      else toast.show({ message: `${camera.name}: ${streamSummary(result.main)}`, tone: 'error' });
    } catch (err) {
      toast.show({ message: describeError(err, CAMERA_ERRORS), tone: 'error' });
    } finally {
      setTesting(false);
    }
  };

  const openEdit = () => {
    setForm(formFrom(camera));
    setFormErrors({});
    setEditError(undefined);
    setEditOpen(true);
  };

  const field = (key: keyof EditForm) => (value: string) => setForm((current) => ({ ...current, [key]: value }));

  const saveEdit = async () => {
    const errors: Partial<Record<keyof EditForm, string>> = {};
    errors.name = nameProblem(form.name) ?? undefined;
    errors.lanIp = ipProblem(form.lanIp) ?? undefined;
    if (custom) {
      errors.rtspPort = portProblem(form.rtspPort, false) ?? undefined;
      errors.mainPath = pathProblem(form.mainPath, false) ?? undefined;
      errors.subPath = pathProblem(form.subPath, true) ?? undefined;
    }
    if (!form.username.trim()) errors.username = 'Type the camera account user name.';
    setFormErrors(errors);
    if (Object.values(errors).some(Boolean)) return;

    const body: UpdateCameraRequest = {};
    if (form.name.trim() !== camera.name) body.name = form.name.trim();
    if (form.lanIp.trim() !== camera.lanIp) body.lanIp = form.lanIp.trim();
    if (custom) {
      if (Number(form.rtspPort) !== camera.rtspPort) body.rtspPort = Number(form.rtspPort);
      if (form.mainPath.trim() !== camera.mainPath) body.mainPath = form.mainPath.trim();
      const sub = form.subPath.trim() || null;
      if (sub !== camera.subPath) body.subPath = sub;
    }
    if (form.username.trim() !== (camera.username ?? '')) body.username = form.username.trim();
    if (form.password) body.password = form.password;
    if (Object.keys(body).length === 0) {
      setEditOpen(false);
      return;
    }
    setSaving(true);
    setEditError(undefined);
    try {
      await patch(body);
      setEditOpen(false);
      toast.show({ message: 'Camera saved.', tone: 'success' });
    } catch (err) {
      setEditError(describeError(err, CAMERA_ERRORS));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setRemoving(true);
    setRemoveError(undefined);
    try {
      await apiSend<OkResponse>('DELETE', `/api/cameras/${camera.id}`);
      setRemoveOpen(false);
      onRemoved(camera.id);
      toast.show({ message: 'Camera removed.', tone: 'success' });
    } catch (err) {
      setRemoveError(describeError(err, CAMERA_ERRORS));
    } finally {
      setRemoving(false);
    }
  };

  const model = [camera.manufacturer, camera.model].filter(Boolean).join(' ');
  const subtitle = [camera.lanIp, model || vendorLabel(camera.vendor)].join(', ');

  return (
    <Card title={camera.name} subtitle={subtitle} icon="cameras" actions={<StatusDot status={camera.online ? 'online' : 'offline'} />}>
      <div class="stack">
        <Toggle
          label="Record this camera"
          description={recordingNote(camera, locationPaused)}
          checked={camera.recording}
          busy={savingRecording}
          onChange={(next) => void setRecording(next)}
        />
        <FormField label="Quality" hint={QUALITY_HINTS[camera.quality]}>
          <Select<Quality> value={camera.quality} options={QUALITY_OPTIONS} disabled={savingQuality} onChange={(next) => void setQuality(next)} />
        </FormField>
        <div class="cam-actions">
          <Button icon="check" loading={testing} loadingLabel="Testing..." onClick={() => void test()}>
            Test
          </Button>
          <Button variant="ghost" icon="edit" onClick={openEdit}>
            Edit
          </Button>
          <Button variant="ghost" icon="trash" onClick={() => setRemoveOpen(true)}>
            Remove
          </Button>
        </div>
      </div>

      <Dialog
        open={editOpen}
        title={`Edit ${camera.name}`}
        confirmLabel="Save changes"
        busyLabel="Saving..."
        busy={saving}
        error={editError}
        onConfirm={() => void saveEdit()}
        onCancel={() => setEditOpen(false)}
      >
        <div class="stack">
          <FormField label="Camera name" error={formErrors.name}>
            <TextInput value={form.name} onInput={field('name')} maxLength={64} autoComplete="off" />
          </FormField>
          <FormField label="Camera address" hint="The camera's local IP address." error={formErrors.lanIp}>
            <TextInput value={form.lanIp} onInput={field('lanIp')} mono inputMode="decimal" autoComplete="off" />
          </FormField>
          {custom ? (
            <>
              <FormField label="Video port" error={formErrors.rtspPort}>
                <TextInput value={form.rtspPort} onInput={field('rtspPort')} mono inputMode="numeric" autoComplete="off" />
              </FormField>
              <FormField label="Main stream path" error={formErrors.mainPath}>
                <TextInput value={form.mainPath} onInput={field('mainPath')} mono autoComplete="off" spellcheck={false} />
              </FormField>
              <FormField label="Sub stream path" optional error={formErrors.subPath}>
                <TextInput value={form.subPath} onInput={field('subPath')} mono autoComplete="off" spellcheck={false} />
              </FormField>
            </>
          ) : null}
          <FormField label="Camera username" hint={camera.vendor === 'tapo' ? TAPO_ACCOUNT_HINT : OTHER_ACCOUNT_HINT} error={formErrors.username}>
            <TextInput value={form.username} onInput={field('username')} autoComplete="off" autoCapitalize="off" spellcheck={false} />
          </FormField>
          <FormField label="New camera password" optional hint="Leave empty to keep the saved one.">
            <PasswordInput value={form.password} onInput={field('password')} autoComplete="off" />
          </FormField>
        </div>
      </Dialog>

      <Dialog
        open={removeOpen}
        tone="danger"
        title="Remove this camera?"
        message="Live view and recording stop. Recordings already saved stay until they pass the days kept."
        confirmLabel="Remove camera"
        busyLabel="Removing..."
        busy={removing}
        error={removeError}
        onConfirm={() => void remove()}
        onCancel={() => setRemoveOpen(false)}
      />
    </Card>
  );
}
