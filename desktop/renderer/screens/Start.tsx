// First run and "Add server": make a free server, or open one that already exists.
import type { TargetedSubmitEvent } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Button, FormField, GroupedList, ListRow, Section, TextInput, useToast } from '../../../dashboard/src/components/index.ts';
import { FlowPage, HubPage, Loading } from '../components/Parts.tsx';
import { call, cctv, errorText, useAppState } from '../lib/bridge.ts';
import { navigate } from '../lib/router.ts';
import { accountRegion, accountStatus } from '../lib/format.ts';

export const ONE_ACCOUNT_NOTE = 'Oracle allows one free account per person.';

export function Welcome({ firstRun }: { firstRun: boolean }) {
  const state = useAppState();
  const hasAccount = (state?.accounts.length ?? 0) > 0;
  return (
    <HubPage
      caption={firstRun ? 'First-time setup' : undefined}
      title={firstRun ? 'Set up Comffee CCTV' : 'Add server'}
      subtitle={firstRun ? 'Your cameras record to your own free cloud server.' : 'Make a new server, or open one you already have.'}
      back={firstRun ? undefined : { href: '/', label: 'Dashboard' }}
    >
      <Section title="How to start" lead="Pick one. You can add more servers later.">
        <GroupedList label="How to start">
          <ListRow icon="cloud" title="Create a free server" secondary="Uses your Oracle Cloud account" href={hasAccount ? '/new-server' : '/connect'} />
          <ListRow icon="link" title="Already have a server?" secondary="Paste its link" href="/link" />
        </GroupedList>
      </Section>
      <p class="footnote">{ONE_ACCOUNT_NOTE} The app never deletes anything in the cloud.</p>
    </HubPage>
  );
}

export function LinkServer() {
  const toast = useToast();
  const [link, setLink] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: TargetedSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!link.trim()) {
      setError('Paste the link of your server.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const server = await call(cctv.addServerLink(link));
      toast.show({ message: 'Server added.', tone: 'success' });
      navigate(`/server/${server.id}`, true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FlowPage caption="Add server" title="Already have a server?" subtitle="Open a Comffee CCTV server you set up before." back={{ href: '/add', label: 'Add server' }}>
      <form class="stack-24" onSubmit={submit} noValidate>
        <Section title="Server link" lead="The address you open the dashboard with.">
          <FormField label="Server link" hint="Starts with https://" error={error} required>
            <TextInput
              type="url"
              value={link}
              onInput={setLink}
              mono
              placeholder="https://cctv.example.com"
              autoComplete="off"
              autoCapitalize="none"
              spellcheck={false}
              autoFocus
              required
            />
          </FormField>
        </Section>
        <div class="actions row-between">
          <Button variant="ghost" icon="chevron-left" href="/add" disabled={busy}>
            Back
          </Button>
          <Button variant="primary" size="l" type="submit" loading={busy} loadingLabel="Checking...">
            Add server
          </Button>
        </div>
      </form>
    </FlowPage>
  );
}

/** "Create a free server": picks the Oracle account (straight on when there is only one). */
export function ChooseAccount() {
  const state = useAppState();
  const accounts = state?.accounts ?? [];
  useEffect(() => {
    if (!state) return;
    if (accounts.length === 0) navigate('/connect', true);
    else if (accounts.length === 1) navigate(`/plan/${accounts[0]!.id}`, true);
  }, [state]);
  if (!state || accounts.length < 2) return <Loading label="Loading" />;
  return (
    <HubPage caption="Create a free server" title="Choose an account" subtitle="The Oracle account the server is made in." back={{ href: '/add', label: 'Add server' }}>
      <Section title="Oracle accounts" lead={`Step 1 of 4. ${ONE_ACCOUNT_NOTE}`}>
        <GroupedList label="Oracle accounts">
          {accounts.map((a) => (
            <ListRow key={a.id} icon="user" title={a.label} secondary={accountStatus(a)} value={accountRegion(a)} href={`/plan/${a.id}`} />
          ))}
          <ListRow icon="plus" title="Connect another account" href="/connect" />
        </GroupedList>
      </Section>
    </HubPage>
  );
}
