/**
 * Makes (or finds again) everything a free hub needs in the account's root compartment:
 *
 *   comffee-cctv-vcn     VCN 10.0.0.0/16
 *   comffee-cctv-igw     internet gateway, default route 0.0.0.0/0 to it
 *   comffee-cctv-subnet  public regional subnet 10.0.0.0/24
 *   default security list: TCP 22, 80, 443 and UDP 51820, 8189 from anywhere, ICMP 3/4
 *   comffee-cctv-hub     VM.Standard.A1.Flex, 4 OCPU / 24 GB (2 / 12 when Oracle stays full),
 *                        newest Canonical Ubuntu 24.04 aarch64 (not Minimal), 190 GB boot volume,
 *                        public IPv4, the app's SSH key and the cloud-init user_data
 *
 * Only Always Free shapes and sizes are ever requested, and nothing is launched when the account's
 * existing Ampere servers and disks would push it over the free allowance.
 */

import { randomBytes } from 'node:crypto';
import type { OciClient } from './oci-client.ts';
import { OciError, isCapacityError, isTransientError } from './oci-client.ts';
import type { EgressRule, IngressRule } from './security-rules.ts';
import { describeOpenPorts, mergeEgressRules, mergeIngressRules, requiredIngressRules } from './security-rules.ts';
import type { CapacityState, ServerSize } from './capacity.ts';
import { RETRY_DELAY_MS, SIZES, initialCapacityState, isFinished, nextCapacityState } from './capacity.ts';
import { Cancelled, UserError } from './errors.ts';
import type { PlanItem } from './ipc-types.ts';

export const NAMES = {
  vcn: 'comffee-cctv-vcn',
  igw: 'comffee-cctv-igw',
  subnet: 'comffee-cctv-subnet',
  instance: 'comffee-cctv-hub',
  vnic: 'comffee-cctv-hub-vnic',
} as const;

export const VCN_CIDR = '10.0.0.0/16';
export const SUBNET_CIDR = '10.0.0.0/24';
export const SHAPE = 'VM.Standard.A1.Flex';
export const BOOT_VOLUME_GBS = 190;
/** Oracle's Always Free allowance: Ampere cores and memory, and block storage (boot + block volumes). */
export const FREE_ALLOWANCE = { ocpus: 4, memoryInGBs: 24, storageGBs: 200 } as const;

const API = '/20160918';
const GONE = new Set(['TERMINATED', 'TERMINATING']);

interface Vcn {
  id: string;
  displayName?: string;
  lifecycleState: string;
  defaultRouteTableId: string;
  defaultSecurityListId: string;
}
interface InternetGateway {
  id: string;
  displayName?: string;
  lifecycleState: string;
  isEnabled?: boolean;
}
interface Subnet {
  id: string;
  displayName?: string;
  lifecycleState: string;
  routeTableId: string;
  securityListIds?: string[];
  prohibitPublicIpOnVnic?: boolean;
}
interface RouteRule {
  destination?: string;
  destinationType?: string;
  cidrBlock?: string;
  networkEntityId: string;
  description?: string;
  routeType?: string;
}
interface RouteTable {
  id: string;
  routeRules?: RouteRule[];
}
interface SecurityList {
  id: string;
  ingressSecurityRules?: IngressRule[];
  egressSecurityRules?: EgressRule[];
}
export interface Instance {
  id: string;
  displayName?: string;
  lifecycleState: string;
  shape?: string;
  shapeConfig?: { ocpus?: number; memoryInGBs?: number };
}
interface Image {
  id: string;
  displayName?: string;
}
interface AvailabilityDomain {
  name: string;
}
interface Compartment {
  id: string;
  lifecycleState?: string;
}
interface Volume {
  sizeInGBs?: number;
  sizeInMBs?: number;
  lifecycleState?: string;
}
interface VnicAttachment {
  vnicId?: string;
  lifecycleState?: string;
}
interface Vnic {
  publicIp?: string;
}

export interface Usage {
  ocpus: number;
  memoryInGBs: number;
  storageGBs: number;
}

export interface Survey {
  vcn: Vcn | null;
  gateway: InternetGateway | null;
  subnet: Subnet | null;
  instance: Instance | null;
  availabilityDomains: string[];
  usage: Usage;
}

export interface SizeChoice {
  start: ServerSize | null;
  canFallBack: boolean;
  blocked: string | null;
}

function retryHeader(): Record<string, string> {
  return { 'opc-retry-token': randomBytes(16).toString('hex') };
}

function alive<T extends { lifecycleState?: string }>(item: T): boolean {
  return !GONE.has(item.lifecycleState ?? '');
}

export async function findVcn(client: OciClient, tenancyId: string, signal?: AbortSignal): Promise<Vcn | null> {
  const vcns = await client.list<Vcn>('iaas', `${API}/vcns`, { compartmentId: tenancyId, displayName: NAMES.vcn }, signal);
  return vcns.find((v) => v.displayName === NAMES.vcn && alive(v)) ?? null;
}

async function findGateway(client: OciClient, tenancyId: string, vcnId: string, signal?: AbortSignal): Promise<InternetGateway | null> {
  const gateways = await client.list<InternetGateway>('iaas', `${API}/internetGateways`, { compartmentId: tenancyId, vcnId }, signal);
  const live = gateways.filter(alive);
  return live.find((g) => g.displayName === NAMES.igw) ?? live[0] ?? null;
}

async function findSubnet(client: OciClient, tenancyId: string, vcnId: string, signal?: AbortSignal): Promise<Subnet | null> {
  const subnets = await client.list<Subnet>('iaas', `${API}/subnets`, { compartmentId: tenancyId, vcnId }, signal);
  return subnets.find((s) => s.displayName === NAMES.subnet && alive(s)) ?? null;
}

export async function findInstance(client: OciClient, tenancyId: string, signal?: AbortSignal): Promise<Instance | null> {
  const instances = await client.list<Instance>('iaas', `${API}/instances`, { compartmentId: tenancyId, displayName: NAMES.instance }, signal);
  return instances.find((i) => i.displayName === NAMES.instance && alive(i)) ?? null;
}

export async function listAvailabilityDomains(client: OciClient, tenancyId: string, signal?: AbortSignal): Promise<string[]> {
  const ads = await client.get<AvailabilityDomain[]>('identity', `${API}/availabilityDomains`, { compartmentId: tenancyId }, signal);
  return (ads ?? []).map((ad) => ad.name).filter((name) => typeof name === 'string' && name.length > 0);
}

function volumeGBs(volume: Volume): number {
  if (typeof volume.sizeInGBs === 'number') return volume.sizeInGBs;
  if (typeof volume.sizeInMBs === 'number') return Math.ceil(volume.sizeInMBs / 1024);
  return 0;
}

function isNoAccess(err: unknown): boolean {
  return err instanceof OciError && (err.status === 404 || err.status === 403);
}

/** Ampere cores and memory, and boot plus block volume space, already used anywhere in the tenancy. */
export async function measureUsage(client: OciClient, tenancyId: string, availabilityDomains: string[], signal?: AbortSignal): Promise<Usage> {
  const compartments = await client.list<Compartment>(
    'identity',
    `${API}/compartments`,
    { compartmentId: tenancyId, compartmentIdInSubtree: true, accessLevel: 'ANY', lifecycleState: 'ACTIVE' },
    signal,
  );
  const ids = [tenancyId, ...compartments.filter((c) => c.lifecycleState === undefined || c.lifecycleState === 'ACTIVE').map((c) => c.id)];
  const usage: Usage = { ocpus: 0, memoryInGBs: 0, storageGBs: 0 };
  for (const compartmentId of ids) {
    try {
      const instances = await client.list<Instance>('iaas', `${API}/instances`, { compartmentId }, signal);
      for (const instance of instances) {
        if (!alive(instance) || instance.shape !== SHAPE) continue;
        usage.ocpus += instance.shapeConfig?.ocpus ?? 0;
        usage.memoryInGBs += instance.shapeConfig?.memoryInGBs ?? 0;
      }
      const volumes = await client.list<Volume>('iaas', `${API}/volumes`, { compartmentId }, signal);
      for (const volume of volumes) if (alive(volume)) usage.storageGBs += volumeGBs(volume);
      for (const availabilityDomain of availabilityDomains) {
        const boots = await client.list<Volume>('iaas', `${API}/bootVolumes`, { availabilityDomain, compartmentId }, signal);
        for (const boot of boots) if (alive(boot)) usage.storageGBs += volumeGBs(boot);
      }
    } catch (err) {
      // A compartment this user cannot read (Oracle-managed ones): nothing of ours can be in it.
      if (compartmentId !== tenancyId && isNoAccess(err)) continue;
      throw err;
    }
  }
  return usage;
}

/** Which size fits next to what the account already uses. */
export function chooseSize(usage: Usage): SizeChoice {
  const fits = (size: ServerSize) =>
    usage.ocpus + SIZES[size].ocpus <= FREE_ALLOWANCE.ocpus &&
    usage.memoryInGBs + SIZES[size].memoryInGBs <= FREE_ALLOWANCE.memoryInGBs;
  if (usage.storageGBs + BOOT_VOLUME_GBS > FREE_ALLOWANCE.storageGBs) {
    return {
      start: null,
      canFallBack: false,
      blocked: `The free ${FREE_ALLOWANCE.storageGBs} GB of disk is already used by other servers or disks in this Oracle account. Delete them in Oracle Cloud first.`,
    };
  }
  if (fits('full')) return { start: 'full', canFallBack: true, blocked: null };
  if (fits('half')) return { start: 'half', canFallBack: false, blocked: null };
  return {
    start: null,
    canFallBack: false,
    blocked: 'The free Ampere cores and memory are already used by another server in this Oracle account. Delete it in Oracle Cloud first.',
  };
}

export async function surveyAccount(client: OciClient, tenancyId: string, signal?: AbortSignal): Promise<Survey> {
  const availabilityDomains = await listAvailabilityDomains(client, tenancyId, signal);
  if (!availabilityDomains.length) throw new UserError('Oracle did not list any place to make a server in this region.');
  const vcn = await findVcn(client, tenancyId, signal);
  const gateway = vcn ? await findGateway(client, tenancyId, vcn.id, signal) : null;
  const subnet = vcn ? await findSubnet(client, tenancyId, vcn.id, signal) : null;
  const instance = await findInstance(client, tenancyId, signal);
  const usage = instance ? { ocpus: 0, memoryInGBs: 0, storageGBs: 0 } : await measureUsage(client, tenancyId, availabilityDomains, signal);
  return { vcn, gateway, subnet, instance, availabilityDomains, usage };
}

export function planItems(survey: Survey, size: SizeChoice): PlanItem[] {
  const state = (found: unknown) => (found ? 'reuse' : 'new') as 'reuse' | 'new';
  const serverDetail = survey.instance
    ? `${NAMES.instance} is already there and will be used`
    : size.start
      ? `Ampere A1, ${SIZES[size.start].ocpus} cores, ${SIZES[size.start].memoryInGBs} GB memory, Ubuntu 24.04, ${BOOT_VOLUME_GBS} GB disk, public address`
      : 'Not enough free room left';
  return [
    { key: 'network', title: 'Network', detail: `${NAMES.vcn}, ${VCN_CIDR}`, state: state(survey.vcn) },
    { key: 'gateway', title: 'Internet gateway', detail: `${NAMES.igw}, route to the internet`, state: state(survey.gateway) },
    { key: 'subnet', title: 'Public subnet', detail: `${NAMES.subnet}, ${SUBNET_CIDR}`, state: state(survey.subnet) },
    { key: 'rules', title: 'Firewall rules', detail: `Opens ${describeOpenPorts()}`, state: survey.vcn ? 'update' : 'new' },
    { key: 'server', title: 'Server', detail: serverDetail, state: state(survey.instance) },
  ];
}

// ---------------------------------------------------------------------------------------------------
// Running it

export interface RunHooks {
  signal: AbortSignal;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  onStep(step: 'network' | 'rules' | 'server' | 'address', state: 'active' | 'done'): void;
  onCapacity(state: CapacityState): void;
  /** Called as soon as the server exists, before it is running. */
  onInstance(instanceId: string, reused: boolean): void;
}

export interface RunInput {
  client: OciClient;
  tenancyId: string;
  sshPublicKey: string;
  /** base64 cloud-init. */
  userData: string;
  hooks: RunHooks;
}

export interface RunResult {
  instanceId: string;
  publicIp: string;
  reused: boolean;
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new Cancelled();
}

async function waitFor<T>(
  load: () => Promise<T>,
  ready: (value: T) => boolean,
  broken: (value: T) => string | null,
  options: { timeoutMs: number; intervalMs: number; hooks: RunHooks; what: string },
): Promise<T> {
  const until = Date.now() + options.timeoutMs;
  for (;;) {
    checkAbort(options.hooks.signal);
    let value: T | undefined;
    try {
      value = await load();
    } catch (err) {
      if (!isTransientError(err)) throw err;
    }
    if (value !== undefined) {
      if (ready(value)) return value;
      const problem = broken(value);
      if (problem) throw new UserError(problem);
    }
    if (Date.now() > until) throw new UserError(`Oracle took too long to finish the ${options.what}. Try again.`);
    await options.hooks.sleep(options.intervalMs, options.hooks.signal);
  }
}

const isGoneState = (what: string) => (v: { lifecycleState: string }) =>
  GONE.has(v.lifecycleState) ? `The ${what} was deleted in Oracle Cloud while it was being made. Try again.` : null;

async function ensureNetwork(client: OciClient, tenancyId: string, hooks: RunHooks): Promise<{ vcn: Vcn; gateway: InternetGateway; subnet: Subnet }> {
  const { signal } = hooks;
  const short = { timeoutMs: 5 * 60_000, intervalMs: 3_000, hooks };
  let vcn = await findVcn(client, tenancyId, signal);
  if (!vcn) {
    vcn = await client.post<Vcn>(
      'iaas',
      `${API}/vcns`,
      { compartmentId: tenancyId, cidrBlocks: [VCN_CIDR], displayName: NAMES.vcn, dnsLabel: 'comffeecctv' },
      retryHeader(),
      signal,
    );
  }
  const vcnId = vcn.id;
  vcn = await waitFor(() => client.get<Vcn>('iaas', `${API}/vcns/${vcnId}`, undefined, signal), (v) => v.lifecycleState === 'AVAILABLE', isGoneState('network'), {
    ...short,
    what: 'network',
  });

  let gateway = await findGateway(client, tenancyId, vcnId, signal);
  if (!gateway) {
    gateway = await client.post<InternetGateway>(
      'iaas',
      `${API}/internetGateways`,
      { compartmentId: tenancyId, vcnId, isEnabled: true, displayName: NAMES.igw },
      retryHeader(),
      signal,
    );
  } else if (gateway.isEnabled === false) {
    gateway = await client.put<InternetGateway>('iaas', `${API}/internetGateways/${gateway.id}`, { isEnabled: true }, signal);
  }
  const gatewayId = gateway.id;
  gateway = await waitFor(
    () => client.get<InternetGateway>('iaas', `${API}/internetGateways/${gatewayId}`, undefined, signal),
    (g) => g.lifecycleState === 'AVAILABLE',
    isGoneState('internet gateway'),
    { ...short, what: 'internet gateway' },
  );

  let subnet = await findSubnet(client, tenancyId, vcnId, signal);
  if (!subnet) {
    subnet = await client.post<Subnet>(
      'iaas',
      `${API}/subnets`,
      {
        compartmentId: tenancyId,
        vcnId,
        cidrBlock: SUBNET_CIDR,
        displayName: NAMES.subnet,
        dnsLabel: 'hub',
        prohibitPublicIpOnVnic: false,
        routeTableId: vcn.defaultRouteTableId,
        securityListIds: [vcn.defaultSecurityListId],
      },
      retryHeader(),
      signal,
    );
  }
  const subnetId = subnet.id;
  subnet = await waitFor(
    () => client.get<Subnet>('iaas', `${API}/subnets/${subnetId}`, undefined, signal),
    (s) => s.lifecycleState === 'AVAILABLE',
    isGoneState('subnet'),
    { ...short, what: 'subnet' },
  );
  if (subnet.prohibitPublicIpOnVnic) {
    throw new UserError(`The subnet ${NAMES.subnet} in Oracle Cloud is private. Delete or rename it there, then try again.`);
  }
  return { vcn, gateway, subnet };
}

async function ensureRules(client: OciClient, net: { vcn: Vcn; gateway: InternetGateway; subnet: Subnet }, hooks: RunHooks): Promise<void> {
  const { signal } = hooks;
  // Default route to the internet gateway, on the route table the subnet really uses.
  const table = await client.get<RouteTable>('iaas', `${API}/routeTables/${net.subnet.routeTableId}`, undefined, signal);
  const rules = table.routeRules ?? [];
  const isDefault = (r: RouteRule) => (r.destination ?? r.cidrBlock) === '0.0.0.0/0';
  if (!rules.some((r) => isDefault(r) && r.networkEntityId === net.gateway.id)) {
    const kept = rules
      .filter((r) => !isDefault(r) && r.routeType !== 'LOCAL')
      .map((r) => ({ destination: r.destination ?? r.cidrBlock, destinationType: r.destinationType ?? 'CIDR_BLOCK', networkEntityId: r.networkEntityId, description: r.description }));
    await client.put('iaas', `${API}/routeTables/${table.id}`, {
      routeRules: [...kept, { destination: '0.0.0.0/0', destinationType: 'CIDR_BLOCK', networkEntityId: net.gateway.id, description: 'Comffee CCTV: internet' }],
    }, signal);
  }

  // The VCN's default security list carries the hub rules; make sure the subnet uses it.
  const listId = net.vcn.defaultSecurityListId;
  const attached = net.subnet.securityListIds ?? [];
  if (!attached.includes(listId)) {
    if (attached.length >= 5) throw new UserError(`The subnet ${NAMES.subnet} has too many security lists. Remove one in Oracle Cloud, then try again.`);
    await client.put('iaas', `${API}/subnets/${net.subnet.id}`, { securityListIds: [...attached, listId] }, signal);
  }
  const list = await client.get<SecurityList>('iaas', `${API}/securityLists/${listId}`, undefined, signal);
  const ingress = mergeIngressRules(list.ingressSecurityRules ?? [], requiredIngressRules(VCN_CIDR));
  const egress = mergeEgressRules(list.egressSecurityRules ?? []);
  if (ingress.added.length || egress.added.length) {
    await client.put('iaas', `${API}/securityLists/${listId}`, { ingressSecurityRules: ingress.rules, egressSecurityRules: egress.rules }, signal);
  }
}

export async function findUbuntuImage(client: OciClient, tenancyId: string, signal?: AbortSignal): Promise<Image> {
  const images = await client.get<Image[]>(
    'iaas',
    `${API}/images`,
    {
      compartmentId: tenancyId,
      operatingSystem: 'Canonical Ubuntu',
      operatingSystemVersion: '24.04',
      shape: SHAPE,
      lifecycleState: 'AVAILABLE',
      sortBy: 'TIMECREATED',
      sortOrder: 'DESC',
      limit: 50,
    },
    signal,
  );
  const image = (images ?? []).find((i) => /aarch64/i.test(i.displayName ?? '') && !/minimal/i.test(i.displayName ?? ''));
  if (!image) throw new UserError('Oracle did not offer an Ubuntu 24.04 image for free Ampere servers in this region.');
  return image;
}

function launchBody(input: RunInput, availabilityDomain: string, imageId: string, subnetId: string, size: ServerSize): Record<string, unknown> {
  return {
    availabilityDomain,
    compartmentId: input.tenancyId,
    displayName: NAMES.instance,
    shape: SHAPE,
    shapeConfig: { ocpus: SIZES[size].ocpus, memoryInGBs: SIZES[size].memoryInGBs },
    sourceDetails: { sourceType: 'image', imageId, bootVolumeSizeInGBs: BOOT_VOLUME_GBS },
    createVnicDetails: { subnetId, assignPublicIp: true, displayName: NAMES.vnic, hostnameLabel: 'hub' },
    metadata: { ssh_authorized_keys: input.sshPublicKey, user_data: input.userData },
    freeformTags: { 'comffee-cctv': 'hub' },
  };
}

/** Exported for tests. */
export async function launchWithRetry(input: RunInput, subnetId: string, availabilityDomains: string[], size: SizeChoice): Promise<Instance> {
  const { client, tenancyId, hooks } = input;
  if (!size.start) throw new UserError(size.blocked ?? 'There is not enough free room left in this Oracle account.');
  const image = await findUbuntuImage(client, tenancyId, hooks.signal);
  const options = { adCount: availabilityDomains.length, canFallBack: size.canFallBack };
  let state = initialCapacityState(size.start);
  // One retry token per launch try (one size in one domain). It is kept when a try is repeated after
  // throttling, an Oracle-side error or a lost answer, so Oracle runs a launch it already received only
  // once and never makes a second, billed server. Only a definite "out of capacity" answer ends the try.
  let tryKey = '';
  let tryHeaders: Record<string, string> = {};
  hooks.onCapacity(state);
  while (!isFinished(state)) {
    checkAbort(hooks.signal);
    if (state.status === 'waiting') {
      hooks.onCapacity(state);
      await hooks.sleep(RETRY_DELAY_MS, hooks.signal);
      state = nextCapacityState(state, { type: 'retry' }, options);
      hooks.onCapacity(state);
      continue;
    }
    try {
      // A launch that timed out on our side may still have gone through.
      const existing = await findInstance(client, tenancyId, hooks.signal);
      if (existing) return existing;
      const ad = availabilityDomains[state.adIndex]!;
      const key = `${state.size}|${ad}`;
      if (tryKey !== key) {
        tryKey = key;
        tryHeaders = retryHeader();
      }
      return await client.post<Instance>('iaas', `${API}/instances`, launchBody(input, ad, image.id, subnetId, state.size), tryHeaders, hooks.signal);
    } catch (err) {
      checkAbort(hooks.signal);
      if (isCapacityError(err)) {
        tryKey = '';
        state = nextCapacityState(state, { type: 'capacity' }, options);
      } else if (isTransientError(err)) {
        state = nextCapacityState(state, { type: 'busy' }, options);
      } else {
        throw err;
      }
      hooks.onCapacity(state);
    }
  }
  throw new Cancelled();
}

async function publicIpOf(client: OciClient, tenancyId: string, instanceId: string, hooks: RunHooks): Promise<string> {
  const attachment = await waitFor(
    async () => {
      const list = await client.list<VnicAttachment>('iaas', `${API}/vnicAttachments`, { compartmentId: tenancyId, instanceId }, hooks.signal);
      return list.find((a) => a.lifecycleState === 'ATTACHED' && a.vnicId) ?? null;
    },
    (a) => a !== null,
    () => null,
    { timeoutMs: 10 * 60_000, intervalMs: 5_000, hooks, what: 'network card' },
  );
  const vnic = await waitFor(
    () => client.get<Vnic>('iaas', `${API}/vnics/${attachment!.vnicId}`, undefined, hooks.signal),
    (v) => typeof v.publicIp === 'string' && v.publicIp.length > 0,
    () => null,
    { timeoutMs: 10 * 60_000, intervalMs: 5_000, hooks, what: 'public address' },
  );
  return vnic.publicIp!;
}

export async function provisionServer(input: RunInput): Promise<RunResult> {
  const { client, tenancyId, hooks } = input;
  hooks.onStep('network', 'active');
  const availabilityDomains = await listAvailabilityDomains(client, tenancyId, hooks.signal);
  if (!availabilityDomains.length) throw new UserError('Oracle did not list any place to make a server in this region.');
  const net = await ensureNetwork(client, tenancyId, hooks);
  hooks.onStep('network', 'done');

  hooks.onStep('rules', 'active');
  await ensureRules(client, net, hooks);
  hooks.onStep('rules', 'done');

  hooks.onStep('server', 'active');
  let instance = await findInstance(client, tenancyId, hooks.signal);
  const reused = instance !== null;
  if (!instance) {
    const usage = await measureUsage(client, tenancyId, availabilityDomains, hooks.signal);
    instance = await launchWithRetry(input, net.subnet.id, availabilityDomains, chooseSize(usage));
  }
  const instanceId = instance.id;
  hooks.onInstance(instanceId, reused);
  if (instance.lifecycleState === 'STOPPED') {
    await client.post('iaas', `${API}/instances/${instanceId}?action=START`, undefined, retryHeader(), hooks.signal).catch(() => undefined);
  }
  await waitFor(
    () => client.get<Instance>('iaas', `${API}/instances/${instanceId}`, undefined, hooks.signal),
    (i) => i.lifecycleState === 'RUNNING',
    (i) => (GONE.has(i.lifecycleState) ? 'The server was deleted in Oracle Cloud. Try again.' : null),
    { timeoutMs: 30 * 60_000, intervalMs: 10_000, hooks, what: 'server' },
  );
  hooks.onStep('server', 'done');

  hooks.onStep('address', 'active');
  const publicIp = await publicIpOf(client, tenancyId, instanceId, hooks);
  hooks.onStep('address', 'done');
  return { instanceId, publicIp, reused };
}
