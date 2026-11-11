/**
 * What the local screens and the main process exchange. Types only: no secrets ever cross this line
 * (no private keys, tokens or setup codes go to the screens).
 */

export type AccountKind = 'session' | 'api-key';

export interface AccountView {
  id: string;
  kind: AccountKind;
  /** Oracle tenancy (account) name. */
  label: string;
  /** Region the sign-in or API key uses. */
  region: string;
  /** Where free servers can be made. */
  homeRegion: string;
  /** Session sign-ins only: when the current token ends (unix ms). */
  sessionExpiresAt: number | null;
  /** Session sign-ins only: the latest time it can still be renewed (unix ms). */
  sessionRenewableUntil: number | null;
  /** False when the session ended and a new sign-in is needed. */
  usable: boolean;
  addedAt: number;
}

export type ServerStatus = 'installing' | 'ready';

export interface ServerView {
  id: string;
  name: string;
  /** https origin. */
  url: string;
  accountId: string | null;
  region: string | null;
  status: ServerStatus;
  addedAt: number;
}

export interface SettingsView {
  repoUrl: string;
  repoRef: string;
}

export interface AppStateView {
  accounts: AccountView[];
  servers: ServerView[];
  selectedServerId: string | null;
  settings: SettingsView;
  defaults: SettingsView;
  version: string;
}

export type PlanItemState = 'new' | 'reuse' | 'update';

export interface PlanItem {
  key: 'network' | 'gateway' | 'subnet' | 'rules' | 'server';
  title: string;
  detail: string;
  state: PlanItemState;
}

export interface PlanView {
  accountId: string;
  region: string;
  regionLabel: string;
  items: PlanItem[];
  /** Cores and memory it starts with; null when blocked. */
  ocpus: number | null;
  memoryInGBs: number | null;
  /** True when it may drop to 2 cores / 12 GB if Oracle stays full. */
  canFallBack: boolean;
  bootVolumeGBs: number;
  /** Why it cannot go ahead, in plain words; null when it can. */
  blocked: string | null;
}

export type JobStepKey = 'network' | 'rules' | 'server' | 'address';
export type JobStepState = 'pending' | 'active' | 'done' | 'failed';

export interface JobStep {
  key: JobStepKey;
  label: string;
  state: JobStepState;
}

export type JobStatus = 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';

export interface JobView {
  jobId: string;
  accountId: string;
  status: JobStatus;
  steps: JobStep[];
  /** "Oracle is busy, still trying (try 3)" while it waits; the error when failed. */
  message: string | null;
  /** When it failed because the Oracle sign-in ended. */
  needsSignIn: boolean;
  tries: number;
  /** Set once the server exists. */
  serverId: string | null;
  startedAt: number;
}

export interface HubWaitView {
  serverId: string;
  status: 'waiting' | 'ready';
  startedAt: number;
  checks: number;
  lastError: string | null;
}

export interface ViewStatus {
  serverId: string;
  state: 'loading' | 'ready' | 'failed';
  message: string | null;
}

export type LinkKey = 'oracle-signup' | 'oracle-console' | 'oracle-api-keys' | 'oracle-free-tier';

export type Result<T> = { ok: true; value: T } | { ok: false; error: string; needsSignIn?: boolean; cancelled?: boolean };

export interface KeyFileChoice {
  /** Opaque handle the main process keeps; the file itself never reaches the screens. */
  token: string;
  fileName: string;
}

export type EventChannel = 'state' | 'job' | 'hub' | 'view' | 'sign-in';

export interface SignInProgress {
  status: 'waiting' | 'checking';
}

export interface EventPayloads {
  state: AppStateView;
  job: JobView;
  hub: HubWaitView;
  view: ViewStatus;
  'sign-in': SignInProgress;
}

/** window.cctv, exposed by the local screens' preload. */
export interface CctvApi {
  getState(): Promise<Result<AppStateView>>;
  signIn(region: string, replaceAccountId: string | null): Promise<Result<AccountView>>;
  cancelSignIn(): Promise<Result<null>>;
  pickKeyFile(): Promise<Result<KeyFileChoice | null>>;
  addApiKey(configText: string, keyFileToken: string, replaceAccountId: string | null): Promise<Result<AccountView>>;
  removeAccount(accountId: string): Promise<Result<null>>;
  planServer(accountId: string): Promise<Result<PlanView>>;
  startServer(accountId: string): Promise<Result<JobView>>;
  cancelServer(): Promise<Result<null>>;
  jobStatus(): Promise<Result<JobView | null>>;
  hubStatus(serverId: string): Promise<Result<HubWaitView | null>>;
  addServerLink(link: string): Promise<Result<ServerView>>;
  renameServer(serverId: string, name: string): Promise<Result<ServerView>>;
  removeServer(serverId: string): Promise<Result<null>>;
  showServer(serverId: string): Promise<Result<null>>;
  hideServer(): Promise<Result<null>>;
  reloadServer(): Promise<Result<null>>;
  setOverlay(open: boolean): Promise<Result<null>>;
  updateSettings(repoUrl: string, repoRef: string): Promise<Result<SettingsView>>;
  openLink(key: LinkKey): Promise<Result<null>>;
  on<C extends EventChannel>(channel: C, listener: (payload: EventPayloads[C]) => void): () => void;
}
