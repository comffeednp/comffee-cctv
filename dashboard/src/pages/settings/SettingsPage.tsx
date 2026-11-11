import { Badge, GroupedList, ListRow, PageHeader, Section } from '../../components/index.ts';
import { isOwner, signOut, useMe, useSetupStatus } from '../../lib/session.ts';

/** Settings hub: one row per settings screen. Viewers only see their own account and recovery key. */
export function SettingsPage() {
  const { me } = useMe();
  const { status } = useSetupStatus();
  const owner = isOwner(me);

  return (
    <>
      <PageHeader title="Settings" subtitle={me ? `Signed in as ${me.username}.` : 'Your account and this hub.'} />

      <Section title="You" lead="Your sign-in and the key that opens recordings.">
        <GroupedList label="You">
          <ListRow icon="user" title="My account" secondary="Password and 2-step sign-in" href="/settings/account" />
          <ListRow
            icon="key"
            title="Recovery key"
            secondary="Needed to open recordings"
            href="/settings/recovery-key"
            trailing={owner && status && !status.hasVaultKey ? <Badge tone="amber">Not made</Badge> : undefined}
          />
        </GroupedList>
      </Section>

      {owner && (
        <Section title="This hub" lead="People, storage and the record of what happened.">
          <GroupedList label="This hub">
            <ListRow icon="users" title="Users" secondary="Who can watch, and which locations" href="/settings/users" />
            <ListRow icon="storage" title="Storage" secondary="Space used and days that fit" href="/settings/storage" />
            <ListRow icon="audit" title="Audit log" secondary="Sign-ins and changes, newest first" href="/settings/audit" />
          </GroupedList>
        </Section>
      )}

      <Section title="Session" lead="Sign out on this device.">
        <GroupedList label="Session">
          <ListRow icon="log-out" title="Sign out" onClick={() => void signOut()} chevron={false} />
        </GroupedList>
      </Section>
    </>
  );
}
