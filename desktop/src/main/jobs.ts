/**
 * Long-running work for the local screens: planning and creating a free server (one at a time), and
 * waiting for a new hub to finish installing.
 */

import { httpsTransport } from '../lib/https-transport.ts';
import { SIZES, capacityMessage } from '../lib/capacity.ts';
import { isSetupCode, newSetupCode, renderCloudInit, userDataBase64 } from '../lib/cloud-init.ts';
import { Cancelled, UserError, describeError } from '../lib/errors.ts';
import { hubUrlFromIp } from '../lib/hub-url.ts';
import { generateSshKeyPair } from '../lib/keys.ts';
import { regionLabel } from '../lib/oci-regions.ts';
import { BOOT_VOLUME_GBS, chooseSize, planItems, provisionServer, surveyAccount } from '../lib/provision.ts';
import type { HubWaitView, JobStep, JobStepKey, JobView, PlanView } from '../lib/ipc-types.ts';
import type { Accounts } from './accounts.ts';
import type { SecretStore } from './secrets.ts';
import type { ServerRecord, Store } from './store.ts';
import { newId } from './store.ts';

const HUB_POLL_MS = 15_000;
const SSH_KEY = 'ssh:key';
export const setupCodeName = (serverId: string) => `server:${serverId}:setup-code`;
const instanceCodeName = (instanceId: string) => `instance:${instanceId}:setup-code`;

const STEP_LABELS: Record<JobStepKey, string> = {
  network: 'Network',
  rules: 'Firewall rules',
  server: 'Server',
  address: 'Public address',
};

export interface SetupStatusAnswer {
  needsSetup: boolean;
}

/** GET <origin>/api/setup/status. Null when it does not answer like a Comffee CCTV hub. */
export async function fetchSetupStatus(origin: string, timeoutMs = 10_000): Promise<SetupStatusAnswer | null> {
  try {
    const res = await httpsTransport({ method: 'GET', url: `${origin}/api/setup/status`, headers: { accept: 'application/json' }, timeoutMs });
    if (res.status !== 200) return null;
    const body = JSON.parse(res.body) as { needsSetup?: unknown };
    return typeof body.needsSetup === 'boolean' ? { needsSetup: body.needsSetup } : null;
  } catch {
    return null;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Cancelled());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Cancelled());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export interface JobsDeps {
  store: Store;
  secrets: SecretStore;
  accounts: Accounts;
  cloudInitTemplate: string;
  emitJob(view: JobView): void;
  emitHub(view: HubWaitView): void;
  emitState(): void;
}

export class Jobs {
  private readonly deps: JobsDeps;
  private job: { view: JobView; abort: AbortController } | null = null;
  private readonly waiters = new Map<string, { view: HubWaitView; abort: AbortController }>();

  constructor(deps: JobsDeps) {
    this.deps = deps;
  }

  // ---- plan --------------------------------------------------------------------------------------

  async plan(accountId: string): Promise<PlanView> {
    const { client, account } = this.deps.accounts.client(accountId);
    const survey = await surveyAccount(client, account.tenancyId);
    const size = survey.instance ? { start: null, canFallBack: false, blocked: null } : chooseSize(survey.usage);
    return {
      accountId,
      region: account.homeRegion,
      regionLabel: regionLabel(account.homeRegion),
      items: planItems(survey, size),
      ocpus: size.start ? SIZES[size.start].ocpus : null,
      memoryInGBs: size.start ? SIZES[size.start].memoryInGBs : null,
      canFallBack: size.canFallBack,
      bootVolumeGBs: BOOT_VOLUME_GBS,
      blocked: size.blocked,
    };
  }

  // ---- create ------------------------------------------------------------------------------------

  status(): JobView | null {
    return this.job?.view ?? null;
  }

  cancel(): void {
    this.job?.abort.abort();
  }

  private sshPublicKey(): string {
    const { store, secrets } = this.deps;
    if (store.data.sshPublicKey && secrets.get(SSH_KEY)) return store.data.sshPublicKey;
    const pair = generateSshKeyPair();
    secrets.set(SSH_KEY, pair.privateKeyPem);
    store.data.sshPublicKey = pair.publicKey;
    store.save();
    return pair.publicKey;
  }

  private update(patch: Partial<JobView>): void {
    if (!this.job) return;
    this.job.view = { ...this.job.view, ...patch };
    this.deps.emitJob(this.job.view);
  }

  private setStep(key: JobStepKey, state: JobStep['state']): void {
    if (!this.job) return;
    this.update({ steps: this.job.view.steps.map((s) => (s.key === key ? { ...s, state } : s)) });
  }

  start(accountId: string): JobView {
    if (this.job && (this.job.view.status === 'running' || this.job.view.status === 'waiting')) {
      throw new UserError('A server is already being made. Wait for it, or cancel it first.');
    }
    const { store, secrets, accounts } = this.deps;
    const { client, account } = accounts.client(accountId);
    const settings = store.data.settings;
    const setupCode = newSetupCode();
    const userData = userDataBase64(renderCloudInit(this.deps.cloudInitTemplate, { repoUrl: settings.repoUrl, repoRef: settings.repoRef, setupCode }));
    const sshPublicKey = this.sshPublicKey();

    const abort = new AbortController();
    const view: JobView = {
      jobId: newId(),
      accountId,
      status: 'running',
      steps: (Object.keys(STEP_LABELS) as JobStepKey[]).map((key) => ({ key, label: STEP_LABELS[key], state: 'pending' })),
      message: null,
      needsSignIn: false,
      tries: 0,
      serverId: null,
      startedAt: Date.now(),
    };
    this.job = { view, abort };
    const job = this.job;
    let instanceCode: string | null = setupCode;
    let instanceId: string | null = null;

    void provisionServer({
      client,
      tenancyId: account.tenancyId,
      sshPublicKey,
      userData,
      hooks: {
        signal: abort.signal,
        sleep,
        onStep: (step, state) => this.setStep(step, state),
        onCapacity: (state) => {
          this.update({ status: state.status === 'waiting' ? 'waiting' : 'running', message: capacityMessage(state), tries: state.tries });
        },
        onInstance: (id, reused) => {
          instanceId = id;
          if (reused) {
            // Launched earlier: its own setup code is the one that was saved then, if any.
            const earlier = secrets.get(instanceCodeName(id)) ?? this.codeOfServerWithInstance(id);
            instanceCode = earlier && isSetupCode(earlier) ? earlier : null;
          } else {
            secrets.set(instanceCodeName(id), setupCode);
          }
          this.update({ status: 'running', message: null });
        },
      },
    })
      .then((result) => {
        if (this.job !== job) return;
        const server = this.saveServer(accountId, account.homeRegion, result.instanceId, hubUrlFromIp(result.publicIp), instanceCode);
        if (instanceId) secrets.delete(instanceCodeName(instanceId));
        this.update({ status: 'done', message: null, serverId: server.id });
        this.watchHub(server.id);
      })
      .catch((err: unknown) => {
        if (this.job !== job) return;
        if (err instanceof Cancelled) {
          this.update({ status: 'cancelled', message: null });
          return;
        }
        const { message, needsSignIn } = describeError(err);
        const steps = job.view.steps.map((s) => (s.state === 'active' ? { ...s, state: 'failed' as const } : s));
        this.update({ status: 'failed', message, needsSignIn, steps });
      });
    return view;
  }

  private codeOfServerWithInstance(instanceId: string): string | null {
    const server = this.deps.store.data.servers.find((s) => s.instanceId === instanceId);
    return server ? this.deps.secrets.get(setupCodeName(server.id)) : null;
  }

  private saveServer(accountId: string, region: string, instanceId: string, url: string, setupCode: string | null): ServerRecord {
    const { store, secrets } = this.deps;
    let server = store.data.servers.find((s) => s.instanceId === instanceId) ?? store.data.servers.find((s) => s.url === url);
    if (!server) {
      const count = store.data.servers.length;
      server = {
        id: newId(),
        name: count === 0 ? 'My server' : `Server ${count + 1}`,
        url,
        accountId,
        region,
        instanceId,
        status: 'installing',
        addedAt: Date.now(),
      };
      store.data.servers.push(server);
    } else {
      Object.assign(server, { url, accountId, region, instanceId });
    }
    if (setupCode) secrets.set(setupCodeName(server.id), setupCode);
    store.data.selectedServerId = server.id;
    store.save();
    this.deps.emitState();
    return server;
  }

  // ---- wait for the hub --------------------------------------------------------------------------

  hubStatus(serverId: string): HubWaitView | null {
    return this.waiters.get(serverId)?.view ?? null;
  }

  watchHub(serverId: string): void {
    const server = this.deps.store.server(serverId);
    if (!server || server.status !== 'installing') return;
    const running = this.waiters.get(serverId);
    if (running && running.view.status === 'waiting') return;
    const abort = new AbortController();
    const entry = { view: { serverId, status: 'waiting', startedAt: Date.now(), checks: 0, lastError: null } as HubWaitView, abort };
    this.waiters.set(serverId, entry);
    const loop = async () => {
      for (;;) {
        const current = this.deps.store.server(serverId);
        if (!current || abort.signal.aborted) return;
        const answer = await fetchSetupStatus(current.url);
        entry.view = { ...entry.view, checks: entry.view.checks + 1, lastError: answer ? null : 'The server is not answering yet.' };
        if (answer) {
          current.status = 'ready';
          if (!answer.needsSetup) this.deps.secrets.delete(setupCodeName(serverId));
          this.deps.store.save();
          entry.view = { ...entry.view, status: 'ready' };
          this.deps.emitHub(entry.view);
          this.deps.emitState();
          return;
        }
        this.deps.emitHub(entry.view);
        await sleep(HUB_POLL_MS, abort.signal);
      }
    };
    loop().catch(() => undefined);
  }

  stopWatching(serverId: string): void {
    this.waiters.get(serverId)?.abort.abort();
    this.waiters.delete(serverId);
  }
}
