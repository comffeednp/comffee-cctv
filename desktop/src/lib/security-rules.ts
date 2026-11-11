/**
 * Oracle VCN security list rules for a hub: what must be open, and merging that into an existing list
 * without removing anything that is already there.
 */

export interface PortRange {
  min: number;
  max: number;
}

export interface IngressRule {
  /** "6" TCP, "17" UDP, "1" ICMP, "all". */
  protocol: string;
  source: string;
  sourceType?: string;
  isStateless?: boolean;
  description?: string;
  tcpOptions?: { destinationPortRange?: PortRange; sourcePortRange?: PortRange };
  udpOptions?: { destinationPortRange?: PortRange; sourcePortRange?: PortRange };
  icmpOptions?: { type: number; code?: number };
}

export interface EgressRule {
  protocol: string;
  destination: string;
  destinationType?: string;
  isStateless?: boolean;
  description?: string;
  tcpOptions?: { destinationPortRange?: PortRange; sourcePortRange?: PortRange };
  udpOptions?: { destinationPortRange?: PortRange; sourcePortRange?: PortRange };
  icmpOptions?: { type: number; code?: number };
}

export const PROTOCOL_TCP = '6';
export const PROTOCOL_UDP = '17';
export const PROTOCOL_ICMP = '1';

/** SSH, HTTP (certificate checks), HTTPS (dashboard). */
export const HUB_TCP_PORTS: readonly number[] = [22, 80, 443];
/** WireGuard router tunnels, WebRTC live video. */
export const HUB_UDP_PORTS: readonly number[] = [51820, 8189];

const ANYWHERE = '0.0.0.0/0';

const PORT_NAMES: Record<string, string> = {
  '6:22': 'SSH',
  '6:80': 'HTTPS certificate checks',
  '6:443': 'Dashboard',
  '17:51820': 'Router tunnels',
  '17:8189': 'Live video',
};

function portRule(protocol: string, port: number): IngressRule {
  const range = { destinationPortRange: { min: port, max: port } };
  return {
    protocol,
    source: ANYWHERE,
    sourceType: 'CIDR_BLOCK',
    isStateless: false,
    description: `Comffee CCTV: ${PORT_NAMES[`${protocol}:${port}`] ?? `port ${port}`}`,
    ...(protocol === PROTOCOL_TCP ? { tcpOptions: range } : { udpOptions: range }),
  };
}

/** Every ingress rule a hub needs. ICMP 3/4 (path MTU discovery) from anywhere and type 3 from the VCN, as Oracle's default list has. */
export function requiredIngressRules(vcnCidr: string): IngressRule[] {
  return [
    ...HUB_TCP_PORTS.map((port) => portRule(PROTOCOL_TCP, port)),
    ...HUB_UDP_PORTS.map((port) => portRule(PROTOCOL_UDP, port)),
    { protocol: PROTOCOL_ICMP, source: ANYWHERE, sourceType: 'CIDR_BLOCK', isStateless: false, icmpOptions: { type: 3, code: 4 } },
    { protocol: PROTOCOL_ICMP, source: vcnCidr, sourceType: 'CIDR_BLOCK', isStateless: false, icmpOptions: { type: 3 } },
  ];
}

function rangeCovers(have: PortRange | undefined, want: PortRange | undefined): boolean {
  if (!have) return true; // no range = every port
  if (!want) return false;
  return have.min <= want.min && have.max >= want.max;
}

/** True when `have` already lets in everything `want` needs. */
export function ruleCovers(have: IngressRule, want: IngressRule): boolean {
  if (have.source !== want.source) return false;
  if (have.protocol === 'all') return true;
  if (have.protocol !== want.protocol) return false;
  if (want.protocol === PROTOCOL_TCP || want.protocol === PROTOCOL_UDP) {
    const haveOpts = want.protocol === PROTOCOL_TCP ? have.tcpOptions : have.udpOptions;
    const wantOpts = want.protocol === PROTOCOL_TCP ? want.tcpOptions : want.udpOptions;
    if (haveOpts?.sourcePortRange) return false; // limited source ports do not cover a plain rule
    return rangeCovers(haveOpts?.destinationPortRange, wantOpts?.destinationPortRange);
  }
  if (want.protocol === PROTOCOL_ICMP) {
    if (!have.icmpOptions) return true; // all ICMP
    if (!want.icmpOptions) return false;
    if (have.icmpOptions.type !== want.icmpOptions.type) return false;
    // Oracle sends null or leaves the code out for "every code of this type".
    return have.icmpOptions.code == null || have.icmpOptions.code === want.icmpOptions.code;
  }
  return false;
}

export interface MergeResult<T> {
  rules: T[];
  added: T[];
}

/** Keeps every existing rule and appends the required ones that are not covered yet. */
export function mergeIngressRules(existing: readonly IngressRule[], required: readonly IngressRule[]): MergeResult<IngressRule> {
  const rules = [...existing];
  const added: IngressRule[] = [];
  for (const want of required) {
    if (rules.some((have) => ruleCovers(have, want))) continue;
    rules.push(want);
    added.push(want);
  }
  return { rules, added };
}

/** The server must reach the internet (packages, certificates, cameras through tunnels). */
export function mergeEgressRules(existing: readonly EgressRule[]): MergeResult<EgressRule> {
  const open = existing.some((rule) => rule.destination === ANYWHERE && rule.protocol === 'all');
  if (open) return { rules: [...existing], added: [] };
  const rule: EgressRule = { protocol: 'all', destination: ANYWHERE, destinationType: 'CIDR_BLOCK', isStateless: false };
  return { rules: [...existing, rule], added: [rule] };
}

/** Short plain list for the screen: "TCP 22, 80, 443 and UDP 51820, 8189". */
export function describeOpenPorts(): string {
  return `TCP ${HUB_TCP_PORTS.join(', ')} and UDP ${HUB_UDP_PORTS.join(', ')}`;
}
