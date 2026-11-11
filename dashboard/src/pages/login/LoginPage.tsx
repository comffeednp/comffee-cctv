import type { TargetedSubmitEvent } from 'preact';
import { useState } from 'preact/hooks';
import type { LoginRequest, LoginResponse, Me, TotpEnrollment as Enrollment, TotpRequest } from '../../../../shared/api-types.ts';
import { Button, Card, FormField, PageHeader, PasswordInput, Section, TextInput } from '../../components/index.ts';
import { ApiFailure, apiSend, describeError } from '../../lib/api.ts';
import { setMe } from '../../lib/session.ts';
import { CodeField, TotpEnrollment, isFullCode } from '../../app/TotpParts.tsx';

type Step = { kind: 'password' } | { kind: 'code'; challenge: string } | { kind: 'enroll'; enrollment: Enrollment };

/** Sign in: username and password, then the 2-step code (or, the first time, linking an authenticator app). */
export function LoginPage() {
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const restart = (message?: string) => {
    setStep({ kind: 'password' });
    setCode('');
    setPassword('');
    setError(message);
  };

  const submitPassword = async (event: TargetedSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!username.trim() || !password) {
      setError('Type your username and password.');
      return;
    }
    setBusy(true);
    try {
      const body: LoginRequest = { username: username.trim(), password };
      const result = await apiSend<LoginResponse>('POST', '/api/auth/login', body);
      setPassword('');
      setCode('');
      setError(undefined);
      if (result.next === 'totp') setStep({ kind: 'code', challenge: result.challenge });
      else setStep({ kind: 'enroll', enrollment: { challenge: result.challenge, secretBase32: result.secretBase32, otpauthUrl: result.otpauthUrl } });
    } catch (err) {
      setError(describeError(err, { wrong_credentials: 'Wrong username or password.' }));
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (event: TargetedSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const challenge = step.kind === 'code' ? step.challenge : step.kind === 'enroll' ? step.enrollment.challenge : '';
    if (!challenge) return;
    if (!isFullCode(code)) {
      setError('Type the 6 digits the app shows.');
      return;
    }
    setBusy(true);
    try {
      const body: TotpRequest = { challenge, code };
      const me = await apiSend<Me>('POST', '/api/auth/totp', body);
      // The app frame sees the signed-in person and moves on to where they were heading.
      setMe(me);
    } catch (err) {
      if (err instanceof ApiFailure && err.code === 'challenge_expired') {
        restart('That took longer than 5 minutes. Sign in again.');
      } else {
        setError(
          describeError(err, { wrong_credentials: 'That code is not right. Check that your phone shows the right time, then type the newest code.' }),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  let body;
  if (step.kind === 'password') {
    body = (
      <form class="stack-24" onSubmit={submitPassword} noValidate>
        <Section title="Your account" lead="Type the username and password you were given.">
          <div class="stack">
            <FormField label="Username" required>
              <TextInput value={username} onInput={setUsername} autoComplete="username" autoCapitalize="none" spellcheck={false} autoFocus required />
            </FormField>
            <FormField label="Password" error={error} required>
              <PasswordInput value={password} onInput={setPassword} autoComplete="current-password" required />
            </FormField>
          </div>
        </Section>
        <Button variant="primary" size="l" type="submit" block loading={busy} loadingLabel="Signing in...">
          Sign in
        </Button>
      </form>
    );
  } else {
    const enrolling = step.kind === 'enroll';
    body = (
      <form class="stack-24" onSubmit={submitCode} noValidate>
        <Section
          title={enrolling ? 'Set up 2-step sign-in' : '2-step code'}
          lead={enrolling ? 'Your account needs an authenticator app before first use.' : 'Open your authenticator app and type the code for Comffee CCTV.'}
        >
          <div class="stack">
            {step.kind === 'enroll' && <TotpEnrollment otpauthUrl={step.enrollment.otpauthUrl} secretBase32={step.enrollment.secretBase32} />}
            <CodeField value={code} onInput={setCode} error={error} autoFocus={!enrolling} />
          </div>
        </Section>
        <div class="actions row-between">
          <Button variant="ghost" icon="chevron-left" onClick={() => restart()} disabled={busy}>
            Start again
          </Button>
          <Button variant="primary" size="l" type="submit" loading={busy} loadingLabel="Checking...">
            Sign in
          </Button>
        </div>
      </form>
    );
  }

  return (
    <main id="main" class="app-main auth-main">
      <PageHeader title="Sign in" subtitle="Watch your cameras and recordings from anywhere." />
      <Card>{body}</Card>
    </main>
  );
}
