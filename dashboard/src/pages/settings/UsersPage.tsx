import type { TargetedSubmitEvent } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { PASSWORD_MIN_LENGTH } from '../../../../shared/api-types.ts';
import type {
  CreateViewerRequest,
  LocationSummary,
  LocationsResponse,
  UpdateUserRequest,
  UserSummary,
  UsersResponse,
} from '../../../../shared/api-types.ts';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  FloatingSave,
  FormField,
  GroupedList,
  ListRow,
  PageHeader,
  PasswordInput,
  Section,
  TextInput,
  Toggle,
  useToast,
} from '../../components/index.ts';
import { ApiFailure, apiGet, apiSend, describeError } from '../../lib/api.ts';
import { formatDateTime, plural } from '../../lib/format.ts';
import { navigate, useRoute } from '../../lib/router.ts';
import { PageLoading } from '../../app/Redirect.tsx';

function locationsText(user: UserSummary): string {
  if (user.locationIds === 'all') return 'All locations';
  return user.locationIds.length === 0 ? 'No locations' : plural(user.locationIds.length, 'location');
}

function isLocked(user: UserSummary): boolean {
  return Boolean(user.lockedUntil && Date.parse(user.lockedUntil) > Date.now());
}

/** Users (owner only): the list, adding a viewer, and managing one viewer, each as its own view. */
export function UsersPage() {
  const { query } = useRoute();
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [locations, setLocations] = useState<LocationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    Promise.all([
      apiGet<UsersResponse>('/api/users', undefined, { signal: controller.signal }),
      apiGet<LocationsResponse>('/api/locations', undefined, { signal: controller.signal }),
    ])
      .then(([u, l]) => {
        setUsers(u.users);
        setLocations(l.locations);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(describeError(err));
      });
    return () => controller.abort();
  }, [reload]);

  const refresh = () => setReload((n) => n + 1);
  const userParam = query.get('user');
  const creating = query.get('new') === '1';

  if (error) {
    return (
      <>
        <PageHeader back={{ href: '/settings', label: 'Settings' }} title="Users" subtitle="Who can sign in, and which locations they see." />
        <EmptyState icon="warning" title="Could not load users" message={error} action={<Button icon="refresh" onClick={refresh}>Try again</Button>} />
      </>
    );
  }
  if (!users || !locations) return <PageLoading label="Loading users" />;

  if (creating) return <NewViewer locations={locations} onCreated={refresh} />;
  if (userParam) {
    const user = users.find((u) => String(u.id) === userParam && u.role === 'viewer');
    if (!user) {
      return (
        <>
          <PageHeader back={{ href: '/settings/users', label: 'Users' }} title="User not found" subtitle="It may have been deleted." />
          <EmptyState icon="users" title="No such user" action={<Button href="/settings/users">Open users</Button>} />
        </>
      );
    }
    return <ManageViewer key={user.id} user={user} locations={locations} onChanged={refresh} />;
  }

  const viewers = users.filter((u) => u.role === 'viewer');
  const owners = users.filter((u) => u.role === 'owner');

  return (
    <>
      <PageHeader
        back={{ href: '/settings', label: 'Settings' }}
        title="Users"
        subtitle="Who can sign in, and which locations they see."
        actions={
          <Button variant="primary" icon="plus" href="/settings/users?new=1">
            Add viewer
          </Button>
        }
      />
      <Section title="Owner" lead="Can do everything, including adding viewers.">
        <GroupedList label="Owner">
          {owners.map((owner) => (
            <ListRow key={owner.id} icon="user" title={owner.username} secondary="All locations" trailing={<Badge>Owner</Badge>} />
          ))}
        </GroupedList>
      </Section>
      <Section title="Viewers" lead="Can watch live and recordings of their locations only.">
        {viewers.length === 0 ? (
          <EmptyState
            icon="users"
            title="No viewers yet"
            message="Add staff or family who should watch some locations."
            action={
              <Button icon="plus" href="/settings/users?new=1">
                Add viewer
              </Button>
            }
          />
        ) : (
          <GroupedList label="Viewers">
            {viewers.map((viewer) => (
              <ListRow
                key={viewer.id}
                icon="user"
                title={viewer.username}
                secondary={`${locationsText(viewer)} · ${viewer.totpEnabled ? '2-step on' : '2-step not set up yet'}`}
                trailing={
                  viewer.disabled ? <Badge>Disabled</Badge> : isLocked(viewer) ? <Badge tone="amber">Locked</Badge> : undefined
                }
                href={`/settings/users?user=${viewer.id}`}
              />
            ))}
          </GroupedList>
        )}
      </Section>
    </>
  );
}

function LocationChoices({
  locations,
  chosen,
  onChange,
}: {
  locations: LocationSummary[];
  chosen: number[];
  onChange: (ids: number[]) => void;
}) {
  if (locations.length === 0) {
    return <p class="k-body-s">No locations yet. Add a location first, then choose it here.</p>;
  }
  return (
    <GroupedList label="Locations">
      {locations.map((location) => (
        <Toggle
          key={location.id}
          inList
          label={location.name}
          checked={chosen.includes(location.id)}
          onChange={(on) => onChange(on ? [...chosen, location.id] : chosen.filter((id) => id !== location.id))}
        />
      ))}
    </GroupedList>
  );
}

function NewViewer({ locations, onCreated }: { locations: LocationSummary[]; onCreated: () => void }) {
  const toast = useToast();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [chosen, setChosen] = useState<number[]>([]);
  const [errors, setErrors] = useState<{ username?: string; password?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);

  const create = async (event: TargetedSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const found: typeof errors = {};
    if (!username.trim()) found.username = 'Choose a username.';
    if (password.length < PASSWORD_MIN_LENGTH) found.password = `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      const body: CreateViewerRequest = { username: username.trim(), password, locationIds: chosen };
      const user = await apiSend<UserSummary>('POST', '/api/users', body);
      toast.show({ message: `${user.username} added. Share the password with them in person.`, tone: 'success' });
      onCreated();
      navigate('/settings/users', { replace: true });
    } catch (err) {
      if (err instanceof ApiFailure && err.code === 'conflict') setErrors({ username: 'That username is taken. Choose another.' });
      else if (err instanceof ApiFailure && err.code === 'invalid_input' && /username/i.test(err.message)) setErrors({ username: describeError(err) });
      else if (err instanceof ApiFailure && err.code === 'invalid_input' && /password/i.test(err.message)) setErrors({ password: describeError(err) });
      else setErrors({ form: describeError(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader back={{ href: '/settings/users', label: 'Users' }} title="Add viewer" subtitle="Someone who may watch some of your locations." />
      <form class="stack-24" onSubmit={create} noValidate>
        <Section title="Sign-in" lead="They link their own authenticator app the first time they sign in.">
          <div class="stack">
            <FormField label="Username" hint="Letters, digits, dot, dash or underscore." error={errors.username} required>
              <TextInput value={username} onInput={setUsername} autoComplete="off" autoCapitalize="none" spellcheck={false} autoFocus required />
            </FormField>
            <FormField label="First password" hint={`At least ${PASSWORD_MIN_LENGTH} characters. They can change it later.`} error={errors.password} required>
              <PasswordInput value={password} onInput={setPassword} autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} required />
            </FormField>
          </div>
        </Section>
        <Section title="Locations" lead="They see live view and recordings of these only.">
          <LocationChoices locations={locations} chosen={chosen} onChange={setChosen} />
        </Section>
        {errors.form && (
          <p class="k-body-s text-error" role="alert">
            {errors.form}
          </p>
        )}
        <div class="actions row-between">
          <Button variant="ghost" icon="chevron-left" href="/settings/users">
            Cancel
          </Button>
          <Button variant="primary" size="l" type="submit" icon="plus" loading={busy} loadingLabel="Adding...">
            Create viewer
          </Button>
        </div>
      </form>
    </>
  );
}

type DialogKind = 'password' | 'totp' | 'delete' | null;

function ManageViewer({ user, locations, onChanged }: { user: UserSummary; locations: LocationSummary[]; onChanged: () => void }) {
  const toast = useToast();
  const original = user.locationIds === 'all' ? locations.map((l) => l.id) : user.locationIds;
  const [chosen, setChosen] = useState<number[]>(original);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | undefined>();

  const dirty = chosen.length !== original.length || chosen.some((id) => !original.includes(id));

  const patch = async (body: UpdateUserRequest) => {
    await apiSend<UserSummary>('PATCH', `/api/users/${user.id}`, body);
    onChanged();
  };

  const saveLocations = async (event: TargetedSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    try {
      await patch({ locationIds: chosen });
      toast.show({ message: 'Locations saved.', tone: 'success' });
    } catch (err) {
      toast.show({ message: describeError(err), tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const setDisabled = async (disabled: boolean) => {
    setToggling(true);
    try {
      await patch({ disabled });
      toast.show({ message: disabled ? `${user.username} can no longer sign in.` : `${user.username} can sign in again.`, tone: 'success' });
    } catch (err) {
      toast.show({ message: describeError(err), tone: 'error' });
    } finally {
      setToggling(false);
    }
  };

  const closeDialog = () => {
    setDialog(null);
    setDialogError(undefined);
    setNewPassword('');
  };

  const confirmDialog = async (ownerPassword: string) => {
    setBusy(true);
    setDialogError(undefined);
    try {
      if (dialog === 'password') {
        await patch({ newPassword, password: ownerPassword });
        toast.show({ message: 'New password set. Their devices were signed out.', tone: 'success' });
      } else if (dialog === 'totp') {
        await patch({ resetTotp: true, password: ownerPassword });
        toast.show({ message: 'They link their authenticator app again at next sign-in.', tone: 'success' });
      } else if (dialog === 'delete') {
        await apiSend('DELETE', `/api/users/${user.id}`);
        toast.show({ message: `${user.username} deleted.`, tone: 'success' });
        onChanged();
        navigate('/settings/users', { replace: true });
      }
      closeDialog();
    } catch (err) {
      setDialogError(describeError(err, { wrong_password: 'That is not your password.' }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        back={{ href: '/settings/users', label: 'Users' }}
        title={user.username}
        subtitle={`Viewer since ${formatDateTime(user.createdAt)}.`}
        status={user.disabled ? <Badge>Disabled</Badge> : isLocked(user) ? <Badge tone="amber">Locked</Badge> : undefined}
      />

      <Section title="Locations" lead="Live view and recordings they may watch.">
        <form id="viewer-form" onSubmit={saveLocations}>
          <LocationChoices locations={locations} chosen={chosen} onChange={setChosen} />
        </form>
      </Section>

      <Section title="Access" lead="Turn off to stop them signing in, without deleting them.">
        <GroupedList label="Access">
          <Toggle
            inList
            label="Allow sign-in"
            description={isLocked(user) ? 'Locked for a few minutes after wrong tries.' : undefined}
            checked={!user.disabled}
            busy={toggling}
            onChange={(on) => void setDisabled(!on)}
          />
        </GroupedList>
      </Section>

      <Section title="Sign-in help" lead="For a forgotten password or a lost phone.">
        <GroupedList label="Sign-in help">
          <ListRow icon="key" title="Set a new password" secondary="Signs them out everywhere" onClick={() => setDialog('password')} />
          <ListRow
            icon="shield"
            title="Reset 2-step sign-in"
            secondary={user.totpEnabled ? 'They link the app again at next sign-in' : 'Not set up yet'}
            onClick={() => setDialog('totp')}
          />
        </GroupedList>
      </Section>

      <Section title="Remove" lead="Deleting cannot be undone.">
        <GroupedList label="Remove">
          <ListRow icon="trash" title="Delete viewer" tone="danger" onClick={() => setDialog('delete')} />
        </GroupedList>
      </Section>

      <FloatingSave form="viewer-form" dirty={dirty} saving={saving} title="Save locations" />

      <Dialog
        open={dialog === 'password'}
        title={`New password for ${user.username}`}
        message="Tell them the new password in person. They are signed out on every device."
        confirmLabel="Set password"
        busyLabel="Setting..."
        password={{ label: 'Your password', hint: 'To confirm it is you.' }}
        confirmDisabled={newPassword.length < PASSWORD_MIN_LENGTH}
        busy={busy}
        error={dialogError}
        onConfirm={(password) => void confirmDialog(password)}
        onCancel={closeDialog}
      >
        <FormField label="New password" hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}>
          <PasswordInput value={newPassword} onInput={setNewPassword} autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} />
        </FormField>
      </Dialog>
      <Dialog
        open={dialog === 'totp'}
        title={`Reset 2-step for ${user.username}?`}
        message="Their authenticator code stops working. They link the app again the next time they sign in."
        confirmLabel="Reset 2-step"
        busyLabel="Resetting..."
        password={{ label: 'Your password', hint: 'To confirm it is you.' }}
        busy={busy}
        error={dialogError}
        onConfirm={(password) => void confirmDialog(password)}
        onCancel={closeDialog}
      />
      <Dialog
        open={dialog === 'delete'}
        tone="danger"
        title={`Delete ${user.username}?`}
        message="They can no longer sign in. This cannot be undone."
        confirmLabel="Delete viewer"
        busyLabel="Deleting..."
        busy={busy}
        error={dialogError}
        onConfirm={(password) => void confirmDialog(password)}
        onCancel={closeDialog}
      />
    </>
  );
}
