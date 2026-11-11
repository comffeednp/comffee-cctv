// Settings: Oracle accounts (add, remove, change), servers (rename, remove from the app), install source.
import type { TargetedSubmitEvent } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Badge, Button, Dialog, FloatingSave, FormField, GroupedList, ListRow, Section, TextInput, useToast } from '../../../dashboard/src/components/index.ts';
import { regionLabel } from '../../src/lib/oci-regions.ts';
import { HubPage, Loading } from '../components/Parts.tsx';
import { call, cctv, errorText, useAppState } from '../lib/bridge.ts';
import { navigate } from '../lib/router.ts';
import { accountRegion, accountStatus, hostOf } from '../lib/format.ts';
import { ONE_ACCOUNT_NOTE } from './Start.tsx';

export function Settings() {
  const state = useAppState();
  if (!state) return <Loading label="Loading settings" />;
  const back = state.servers.length ? { href: '/', label: 'Dashboard' } : { href: '/welcome', label: 'Set up' };
  return (
    <HubPage title="Settings" subtitle="Oracle accounts, servers and where new servers come from." back={back}>
      <Section title="Oracle accounts" lead="Used only to make servers.">
        <GroupedList label="Oracle accounts">
          {state.accounts.map((a) => (
            <ListRow
              key={a.id}
              icon="user"
              title={a.label}
              secondary={accountStatus(a)}
              value={accountRegion(a)}
              href={`/settings/account/${a.id}`}
              trailing={a.usable ? undefined : <Badge tone="amber">Signed out</Badge>}
            />
          ))}
          <ListRow icon="plus" title="Add Oracle account" href="/connect" />
        </GroupedList>
        <p class="footnote">{ONE_ACCOUNT_NOTE}</p>
      </Section>
      <Section title="Servers" lead="Removing one here never deletes it in the cloud.">
        <GroupedList label="Servers">
          {state.servers.map((s) => (
            <ListRow
              key={s.id}
              icon="cloud"
              title={s.name}
              secondary={hostOf(s)}
              href={`/settings/server/${s.id}`}
              trailing={s.status === 'installing' ? <Badge tone="amber">Installing</Badge> : undefined}
            />
          ))}
          <ListRow icon="plus" title="Add server" secondary="Make one, or paste a link" href="/add" />
        </GroupedList>
      </Section>
      <Section title="New server" lead="Make another free server with a connected account.">
        <GroupedList label="New server">
          <ListRow icon="cloud" title="Create another server" secondary="In a connected Oracle account" href="/new-server" />
        </GroupedList>
      </Section>
      <Section title="Advanced" lead="Where new servers get the hub software.">
        <GroupedList label="Advanced">
          <ListRow icon="download" title="Install source" secondary={state.settings.repoRef} href="/settings/source" />
        </GroupedList>
      </Section>
      <p class="footnote">Comffee CCTV {state.version}. Open source, MIT licence.</p>
    </HubPage>
  );
}

export function AccountDetail({ accountId }: { accountId: string }) {
  const toast = useToast();
  const state = useAppState();
  const account = state?.accounts.find((a) => a.id === accountId) ?? null;
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (state && !account && !busy) navigate('/settings', true);
  }, [state, account?.id]);
  if (!account) return <Loading label="Loading" />;

  const remove = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await call(cctv.removeAccount(account.id));
      toast.show({ message: 'Oracle account removed from this app.', tone: 'success' });
      navigate('/settings', true);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <HubPage
      back={{ href: '/settings', label: 'Settings' }}
      title={account.label}
      subtitle={`Oracle account, home region ${regionLabel(account.homeRegion)}.`}
    >
      <Section title="Sign-in" lead={accountStatus(account)}>
        <GroupedList label="Sign-in">
          {account.kind === 'session' && (
            <ListRow icon="refresh" title="Sign in again" secondary="Opens Oracle in your browser" href={`/connect/sign-in?replace=${account.id}`} />
          )}
          <ListRow icon="user" title="Change Oracle account" secondary="Use a different account instead" href={`/connect?replace=${account.id}`} />
          <ListRow icon="plus" title="Create a server" secondary="In this account" href={`/plan/${account.id}`} />
        </GroupedList>
      </Section>
      <Section title="Remove" lead="Your servers and recordings stay as they are.">
        <GroupedList label="Remove">
          <ListRow icon="trash" title="Remove from this app" tone="danger" onClick={() => setConfirm(true)} />
        </GroupedList>
      </Section>
      <Dialog
        open={confirm}
        tone="danger"
        title="Remove this Oracle account?"
        message="The app forgets this account and its saved sign-in. Nothing changes in Oracle Cloud."
        confirmLabel="Remove account"
        busyLabel="Removing..."
        busy={busy}
        error={error}
        onConfirm={() => void remove()}
        onCancel={() => setConfirm(false)}
      />
    </HubPage>
  );
}

export function ServerDetail({ serverId }: { serverId: string }) {
  const toast = useToast();
  const state = useAppState();
  const server = state?.servers.find((s) => s.id === serverId) ?? null;
  const account = server?.accountId ? (state?.accounts.find((a) => a.id === server.accountId) ?? null) : null;
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (state && !server && !busy) navigate('/settings', true);
  }, [state, server?.id]);
  if (!server) return <Loading label="Loading" />;

  const remove = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await call(cctv.removeServer(server.id));
      toast.show({ message: 'Server removed from this app.', tone: 'success' });
      navigate('/settings', true);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <HubPage back={{ href: '/settings', label: 'Settings' }} title={server.name} subtitle={hostOf(server)}>
      <Section title="Server" lead="How it shows in this app.">
        <GroupedList label="Server">
          <ListRow icon="edit" title="Name" value={server.name} href={`/settings/server/${server.id}/name`} />
          <ListRow icon="link" title="Address" secondary={server.url} />
          {account && <ListRow icon="user" title="Oracle account" value={account.label} href={`/settings/account/${account.id}`} />}
          {server.region && <ListRow icon="cloud" title="Region" value={regionLabel(server.region)} />}
        </GroupedList>
      </Section>
      <Section title="Open" lead={server.status === 'installing' ? 'Still installing.' : 'The dashboard of this server.'}>
        <GroupedList label="Open">
          <ListRow icon="live" title="Open dashboard" href={`/server/${server.id}`} />
        </GroupedList>
      </Section>
      <Section title="Remove" lead="The server, its cameras and recordings stay in the cloud.">
        <GroupedList label="Remove">
          <ListRow icon="trash" title="Remove from this app" tone="danger" onClick={() => setConfirm(true)} />
        </GroupedList>
      </Section>
      <Dialog
        open={confirm}
        tone="danger"
        title="Remove this server from the app?"
        message="The app signs out of it here and forgets it. The server, its cameras and recordings stay as they are."
        confirmLabel="Remove server"
        busyLabel="Removing..."
        busy={busy}
        error={error}
        onConfirm={() => void remove()}
        onCancel={() => setConfirm(false)}
      />
    </HubPage>
  );
}

export function ServerName({ serverId }: { serverId: string }) {
  const toast = useToast();
  const state = useAppState();
  const server = state?.servers.find((s) => s.id === serverId) ?? null;
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (server && name === null) setName(server.name);
    if (state && !server) navigate('/settings', true);
  }, [server?.id, state]);
  if (!server || name === null) return <Loading label="Loading" />;

  const submit = async (event: TargetedSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const clean = name.trim();
    if (!clean) {
      setError('Type a name.');
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await call(cctv.renameServer(server.id, clean));
      toast.show({ message: 'Saved.', tone: 'success' });
      navigate(`/settings/server/${server.id}`, true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <HubPage back={{ href: `/settings/server/${server.id}`, label: server.name }} title="Server name" subtitle="How this server shows in the app.">
      <form id="server-name-form" class="stack-24" onSubmit={submit} noValidate>
        <Section title="Name" lead="Only used in this app, for example the shop's name.">
          <FormField label="Name" hint="Up to 60 characters." error={error} required>
            <TextInput value={name} onInput={setName} maxLength={60} autoFocus required />
          </FormField>
        </Section>
      </form>
      <FloatingSave form="server-name-form" dirty={name.trim() !== server.name && name.trim().length > 0} saving={saving} title="Save the server name" />
    </HubPage>
  );
}

export function Source() {
  const toast = useToast();
  const state = useAppState();
  const [repoUrl, setRepoUrl] = useState<string | null>(null);
  const [repoRef, setRepoRef] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (state && repoUrl === null) {
      setRepoUrl(state.settings.repoUrl);
      setRepoRef(state.settings.repoRef);
    }
  }, [state]);
  if (!state || repoUrl === null) return <Loading label="Loading" />;

  const dirty = repoUrl.trim() !== state.settings.repoUrl || repoRef.trim() !== state.settings.repoRef;
  const submit = async (event: TargetedSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      await call(cctv.updateSettings(repoUrl.trim(), repoRef.trim()));
      toast.show({ message: 'Saved.', tone: 'success' });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };
  const useDefaults = () => {
    setRepoUrl(state.defaults.repoUrl);
    setRepoRef(state.defaults.repoRef);
  };

  return (
    <HubPage back={{ href: '/settings', label: 'Settings' }} title="Install source" subtitle="Where new servers get the hub software.">
      <form id="source-form" class="stack-24" onSubmit={submit} noValidate>
        <Section title="Project" lead="Used only when a new server is made.">
          <div class="stack">
            <FormField label="Project address" hint="An https git address." error={error} required>
              <TextInput type="url" value={repoUrl} onInput={setRepoUrl} mono autoComplete="off" spellcheck={false} required />
            </FormField>
            <FormField label="Version" hint="A branch or tag, like main." required>
              <TextInput value={repoRef} onInput={setRepoRef} mono autoComplete="off" spellcheck={false} required />
            </FormField>
            <div class="actions">
              <Button variant="ghost" icon="refresh" onClick={useDefaults}>
                Use the defaults
              </Button>
            </div>
          </div>
        </Section>
      </form>
      <FloatingSave form="source-form" dirty={dirty} saving={saving} title="Save the install source" />
    </HubPage>
  );
}
