import type { TargetedSubmitEvent } from 'preact';
import { useState } from 'preact/hooks';
import { PASSWORD_MIN_LENGTH } from '../../../../shared/api-types.ts';
import type { ChangePasswordRequest, Me, OkResponse, ResetTotpRequest, TotpEnrollment as Enrollment, TotpRequest } from '../../../../shared/api-types.ts';
import { Badge, Button, Dialog, FloatingSave, FormField, GroupedList, ListRow, PageHeader, PasswordInput, Section, useToast } from '../../components/index.ts';
import { ApiFailure, apiSend, describeError } from '../../lib/api.ts';
import { setMe, useMe } from '../../lib/session.ts';
import { CodeField, TotpEnrollment, isFullCode } from '../../app/TotpParts.tsx';

/** My account: change password, and link the authenticator app again (2-step reset). */
export function AccountPage() {
  const { me } = useMe();
  const toast = useToast();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ current?: string; next?: string; confirm?: string; form?: string }>({});
  const [saving, setSaving] = useState(false);

  const [resetOpen, setResetOpen] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<string | undefined>();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | undefined>();
  const [finishing, setFinishing] = useState(false);

  const changePassword = async (event: TargetedSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const found: typeof errors = {};
    if (!current) found.current = 'Type your current password.';
    if (next.length < PASSWORD_MIN_LENGTH) found.next = `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
    else if (next !== confirm) found.confirm = 'The two passwords are not the same.';
    setErrors(found);
    if (Object.keys(found).length) return;
    setSaving(true);
    try {
      const body: ChangePasswordRequest = { currentPassword: current, newPassword: next };
      await apiSend<OkResponse>('POST', '/api/me/password', body);
      setCurrent('');
      setNext('');
      setConfirm('');
      toast.show({ message: 'Password changed. Your other devices were signed out.', tone: 'success' });
    } catch (err) {
      if (err instanceof ApiFailure && (err.code === 'wrong_password' || err.code === 'wrong_credentials')) {
        setErrors({ current: 'That is not your current password.' });
      } else if (err instanceof ApiFailure && err.code === 'invalid_input') {
        setErrors({ next: describeError(err) });
      } else {
        setErrors({ form: describeError(err) });
      }
    } finally {
      setSaving(false);
    }
  };

  const startReset = async (password: string) => {
    setResetBusy(true);
    setResetError(undefined);
    try {
      const body: ResetTotpRequest = { password };
      setEnrollment(await apiSend<Enrollment>('POST', '/api/me/totp/reset', body));
      setCode('');
      setCodeError(undefined);
      setResetOpen(false);
    } catch (err) {
      setResetError(describeError(err, { wrong_password: 'That password is not right.' }));
    } finally {
      setResetBusy(false);
    }
  };

  const finishReset = async (event: TargetedSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!enrollment) return;
    if (!isFullCode(code)) {
      setCodeError('Type the 6 digits the app shows.');
      return;
    }
    setFinishing(true);
    try {
      const body: TotpRequest = { challenge: enrollment.challenge, code };
      const updated = await apiSend<Me>('POST', '/api/auth/totp', body);
      setMe(updated);
      setEnrollment(null);
      toast.show({ message: '2-step sign-in linked to the new app.', tone: 'success' });
    } catch (err) {
      if (err instanceof ApiFailure && err.code === 'challenge_expired') {
        setEnrollment(null);
        toast.show({ message: 'That took longer than 5 minutes. Start the reset again.', tone: 'error' });
      } else {
        setCodeError(describeError(err, { wrong_credentials: 'That code is not right. Type the newest code from the app.' }));
      }
    } finally {
      setFinishing(false);
    }
  };

  const dirty = Boolean(current || next || confirm);

  return (
    <>
      <PageHeader back={{ href: '/settings', label: 'Settings' }} title="My account" subtitle={me ? `Signed in as ${me.username}.` : 'Your sign-in.'} />

      <Section title="Password" lead="Changing it signs out your other devices.">
        <form id="password-form" class="stack" onSubmit={changePassword} noValidate>
          <input type="text" name="username" autoComplete="username" value={me?.username ?? ''} class="sr-only" tabIndex={-1} aria-hidden="true" readOnly />
          <FormField label="Current password" error={errors.current} required>
            <PasswordInput value={current} onInput={setCurrent} autoComplete="current-password" required />
          </FormField>
          <FormField label="New password" hint={`At least ${PASSWORD_MIN_LENGTH} characters.`} error={errors.next} required>
            <PasswordInput value={next} onInput={setNext} autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} required />
          </FormField>
          <FormField label="New password again" error={errors.confirm} required>
            <PasswordInput value={confirm} onInput={setConfirm} autoComplete="new-password" required />
          </FormField>
          {errors.form && (
            <p class="k-body-s text-error" role="alert">
              {errors.form}
            </p>
          )}
        </form>
      </Section>

      <Section title="2-step sign-in" lead="The code from your authenticator app, asked at every sign-in.">
        {enrollment ? (
          <form class="stack" onSubmit={finishReset} noValidate>
            <TotpEnrollment otpauthUrl={enrollment.otpauthUrl} secretBase32={enrollment.secretBase32} />
            <CodeField value={code} onInput={setCode} error={codeError} />
            <div class="actions">
              <Button variant="primary" type="submit" loading={finishing} loadingLabel="Checking...">
                Link app
              </Button>
              <Button variant="ghost" onClick={() => setEnrollment(null)} disabled={finishing}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <GroupedList label="2-step sign-in">
            <ListRow
              icon="shield"
              title="Authenticator app"
              secondary="New phone or lost the app? Link it again."
              trailing={me?.totpEnabled ? <Badge tone="ok">On</Badge> : <Badge tone="amber">Off</Badge>}
              onClick={() => setResetOpen(true)}
            />
          </GroupedList>
        )}
      </Section>

      <FloatingSave form="password-form" dirty={dirty} saving={saving} label="Change password" savingLabel="Changing..." title="Change password" />

      <Dialog
        open={resetOpen}
        title="Link a new authenticator app?"
        message="You will scan a new code with your authenticator app. The code in your old app stops working."
        confirmLabel="Continue"
        busyLabel="Checking..."
        password={{ label: 'Your password' }}
        busy={resetBusy}
        error={resetError}
        onConfirm={(password) => void startReset(password)}
        onCancel={() => {
          setResetOpen(false);
          setResetError(undefined);
        }}
      />
    </>
  );
}
