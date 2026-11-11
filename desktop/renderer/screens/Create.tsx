// Steps 2-4: show what will be made, make it (retrying while Oracle is full), wait for the hub.
import { useEffect, useState } from 'preact/hooks';
import { Badge, Button, Icon, Section, Spinner, useToast } from '../../../dashboard/src/components/index.ts';
import type { HubWaitView, JobStep, JobView, PlanItemState, PlanView } from '../../src/lib/ipc-types.ts';
import { FlowPage, Loading, stepLead } from '../components/Parts.tsx';
import { CallError, call, cctv, errorText, useAppState, useEvent } from '../lib/bridge.ts';
import { navigate } from '../lib/router.ts';
import { hostOf, minutes } from '../lib/format.ts';

const STATE_LABEL: Record<PlanItemState, string> = { new: 'New', reuse: 'Already there', update: 'Checked' };

export function Plan({ accountId }: { accountId: string }) {
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [error, setError] = useState<{ message: string; needsSignIn: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setPlan(await call(cctv.planServer(accountId)));
    } catch (err) {
      setError({ message: errorText(err), needsSignIn: err instanceof CallError && err.needsSignIn });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [accountId]);

  const start = async () => {
    setStarting(true);
    try {
      await call(cctv.startServer(accountId));
      navigate('/create', true);
    } catch (err) {
      setError({ message: errorText(err), needsSignIn: err instanceof CallError && err.needsSignIn });
      setStarting(false);
    }
  };

  const reusesServer = plan?.items.some((i) => i.key === 'server' && i.state === 'reuse') ?? false;
  return (
    <FlowPage caption="Create a free server" title="Create your free server" subtitle="Made in your Oracle account, on the Always Free plan." back={{ href: '/add', label: 'Add server' }}>
      <div class="stack-24">
        <Section title="What will be made" lead={stepLead(2, 'Check this list, then create the server.')}>
          {loading ? (
            <Loading label="Checking your Oracle account" />
          ) : plan ? (
            <div class="stack">
              <ul class="desk-plan">
                {plan.items.map((item) => (
                  <li key={item.key}>
                    <div class="stack-8 grow">
                      <span class="k-h6">{item.title}</span>
                      <span class="k-body-s">{item.detail}</span>
                    </div>
                    <Badge tone={item.state === 'new' ? 'amber' : 'neutral'}>{STATE_LABEL[item.state]}</Badge>
                  </li>
                ))}
              </ul>
              <div class="pairs k-body-s">
                <div>
                  <span>Region</span>
                  <span class="text-cream">{plan.regionLabel}</span>
                </div>
              </div>
              {plan.blocked ? (
                <p class="notice k-body-s text-error" role="alert">
                  <Icon name="warning" size={16} />
                  <span>{plan.blocked}</span>
                </p>
              ) : (
                <p class="notice k-body-s text-phosphor">
                  <Icon name="check" size={16} />
                  <span>Everything here fits Oracle's Always Free plan. Nothing is charged.</span>
                </p>
              )}
              {plan.canFallBack && !reusesServer && (
                <p class="footnote">If Oracle has no room, the server starts with 2 cores and 12 GB. You can raise it later in Oracle Cloud.</p>
              )}
            </div>
          ) : null}
          {error && (
            <p class="notice k-body-s text-error" role="alert">
              <Icon name="warning" size={16} />
              <span>{error.message}</span>
            </p>
          )}
        </Section>
        <div class="actions row-between">
          <Button variant="ghost" icon="chevron-left" href="/add" disabled={starting}>
            Back
          </Button>
          {error?.needsSignIn ? (
            <Button variant="primary" size="l" href={`/connect/sign-in?replace=${accountId}`}>
              Sign in again
            </Button>
          ) : error && !plan ? (
            <Button variant="primary" size="l" icon="refresh" onClick={() => void load()}>
              Try again
            </Button>
          ) : (
            <Button variant="primary" size="l" onClick={() => void start()} disabled={loading || !plan || !!plan.blocked} loading={starting} loadingLabel="Starting...">
              {reusesServer ? 'Use this server' : 'Create server'}
            </Button>
          )}
        </div>
      </div>
    </FlowPage>
  );
}

function StepMark({ step, waiting }: { step: JobStep; waiting: boolean }) {
  if (step.state === 'done') return <Icon name="check" size={20} class="text-phosphor" />;
  if (step.state === 'failed') return <Icon name="warning" size={20} class="text-error" />;
  if (step.state === 'active') return waiting ? <Icon name="refresh" size={20} class="text-amber" /> : <Spinner size={20} decorative />;
  return <span class="desk-step-dot" aria-hidden="true" />;
}

const STEP_WORD: Record<JobStep['state'], string> = { pending: 'Next', active: 'Working', done: 'Done', failed: 'Failed' };

export function Creating() {
  const toast = useToast();
  const [job, setJob] = useState<JobView | null | undefined>(undefined);
  const [cancelling, setCancelling] = useState(false);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    void call(cctv.jobStatus())
      .then(setJob)
      .catch(() => setJob(null));
  }, []);
  useEvent('job', (view) => setJob(view), []);

  useEffect(() => {
    if (job === null) navigate('/', true);
    if (job?.status === 'done' && job.serverId) {
      toast.show({ message: 'Server made. Installing now.', tone: 'success' });
      navigate(`/wait/${job.serverId}`, true);
    }
  }, [job?.status, job?.serverId, job === null]);

  if (job === undefined || job === null) return <Loading label="Loading" />;

  const waiting = job.status === 'waiting';
  const running = job.status === 'running' || waiting;
  const retry = async () => {
    setRetrying(true);
    try {
      setJob(await call(cctv.startServer(job.accountId)));
    } catch (err) {
      toast.show({ message: errorText(err), tone: 'error' });
    } finally {
      setRetrying(false);
    }
  };
  const cancel = async () => {
    setCancelling(true);
    await call(cctv.cancelServer()).catch(() => undefined);
    setCancelling(false);
  };

  return (
    <FlowPage caption="Create a free server" title="Creating your server" subtitle="Keep this app open. It takes a few minutes.">
      <div class="stack-24">
        <Section title="Progress" lead={stepLead(3, 'Making everything in your Oracle account.')}>
          <div class="stack">
            <ul class="desk-plan" aria-live="polite">
              {job.steps.map((step) => (
                <li key={step.key}>
                  <div class="row grow">
                    <span class="desk-step-mark">
                      <StepMark step={step} waiting={waiting} />
                    </span>
                    <span class="k-h6">{step.label}</span>
                  </div>
                  <span class="k-body-s">{step.state === 'active' && waiting ? 'Waiting' : STEP_WORD[step.state]}</span>
                </li>
              ))}
            </ul>
            {running && job.message && (
              <div class="stack-8" role="status">
                <p class="notice k-body-s text-amber">
                  <Icon name="warning" size={16} />
                  <span>{job.message}.</span>
                </p>
                <p class="k-body-s">Free servers are popular. The app tries again every minute until Oracle has room.</p>
              </div>
            )}
            {job.status === 'failed' && job.message && (
              <p class="notice k-body-s text-error" role="alert">
                <Icon name="warning" size={16} />
                <span>{job.message}</span>
              </p>
            )}
            {job.status === 'cancelled' && (
              <p class="k-body-s" role="status">
                Stopped. Anything already made stays and is used next time.
              </p>
            )}
          </div>
        </Section>
        <div class="actions row-between">
          {running ? (
            <Button variant="secondary" icon="close" onClick={() => void cancel()} loading={cancelling} loadingLabel="Cancelling...">
              Cancel
            </Button>
          ) : (
            <Button variant="ghost" icon="chevron-left" href="/add">
              Back
            </Button>
          )}
          {!running && job.needsSignIn && (
            <Button variant="primary" size="l" href={`/connect/sign-in?replace=${job.accountId}`}>
              Sign in again
            </Button>
          )}
          {!running && !job.needsSignIn && job.status !== 'done' && (
            <Button variant="primary" size="l" icon="refresh" onClick={() => void retry()} loading={retrying} loadingLabel="Starting...">
              Try again
            </Button>
          )}
        </div>
      </div>
    </FlowPage>
  );
}

const SLOW_AFTER_MS = 30 * 60_000;

export function WaitForHub({ serverId }: { serverId: string }) {
  const state = useAppState();
  const server = state?.servers.find((s) => s.id === serverId) ?? null;
  const [hub, setHub] = useState<HubWaitView | null>(null);
  const [now, setNow] = useState(Date.now());
  const [startedAt] = useState(Date.now());

  useEffect(() => {
    void call(cctv.hubStatus(serverId))
      .then((view) => view && setHub(view))
      .catch(() => undefined);
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [serverId]);
  useEvent('hub', (view) => {
    if (view.serverId === serverId) setHub(view);
  }, [serverId]);

  const ready = hub?.status === 'ready' || server?.status === 'ready';
  useEffect(() => {
    if (state && !server) navigate('/', true);
    if (ready) navigate(`/server/${serverId}`, true);
  }, [ready, state, server?.id]);

  if (!server) return <Loading label="Loading" />;
  const elapsed = now - (hub?.startedAt ?? startedAt);
  return (
    <FlowPage caption="Create a free server" title="Installing" subtitle="Installing, about 10 minutes.">
      <div class="stack-24">
        <Section title="Installing the hub" lead={stepLead(4, 'The server sets itself up. The dashboard opens when it is ready.')}>
          <div class="stack">
            <div class="row" role="status">
              <Spinner size={24} decorative />
              <span class="k-body">Installing. {minutes(elapsed)} so far.</span>
            </div>
            <div class="pairs k-body-s">
              <div>
                <span>Address</span>
                <span class="mono text-cream">{hostOf(server)}</span>
              </div>
            </div>
            {elapsed > SLOW_AFTER_MS && (
              <p class="notice k-body-s text-amber">
                <Icon name="warning" size={16} />
                <span>This is taking longer than usual. Check in Oracle Cloud that the server shows Running.</span>
              </p>
            )}
            <p class="footnote">You can close the app. It keeps checking the next time it opens.</p>
          </div>
        </Section>
        <div class="actions row-between">
          <Button variant="ghost" icon="settings" href="/settings">
            Settings
          </Button>
          {elapsed > SLOW_AFTER_MS && (
            <Button variant="primary" onClick={() => void cctv.openLink('oracle-console')}>
              Open Oracle Cloud
            </Button>
          )}
        </div>
      </div>
    </FlowPage>
  );
}
