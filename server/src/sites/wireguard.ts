/**
 * Hub-side WireGuard peers for router locations. Runs `wg` and `ip` with argument arrays (never a shell),
 * after strict validation of every argument. Does nothing when config.wireguard.enabled is false.
 */

import { execFile } from 'node:child_process';
import type { HubConfig } from '../contracts.ts';
import { mappedCameraSubnet, routerTunnelIp } from '../contracts.ts';
import { isInterfaceName, isValidSlot, isWireguardKey } from './net.ts';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a program with arguments; never throws for a non-zero exit. */
export type CommandRunner = (program: 'wg' | 'ip', args: string[]) => Promise<CommandResult>;

export const runCommand: CommandRunner = (program, args) =>
  new Promise((resolve) => {
    execFile(
      program,
      args,
      { timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr || (err ? err.message : '')) });
      },
    );
  });

export interface Peer {
  slot: number;
  publicKey: string;
}

export class WireGuard {
  readonly enabled: boolean;
  private readonly iface: string;
  private readonly hubKey: string;
  private readonly run: CommandRunner;
  /** Serialises every change so peers and routes are never half-applied by two callers. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(config: HubConfig['wireguard'], run: CommandRunner = runCommand) {
    this.iface = config.interface;
    this.hubKey = config.publicKey;
    this.run = run;
    this.enabled = config.enabled === true && isInterfaceName(config.interface);
    if (config.enabled && !isInterfaceName(config.interface)) {
      console.warn('comffee-cctv: WireGuard interface name in the config is invalid; router connector disabled');
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private checkPeer(peer: Peer): void {
    if (!isValidSlot(peer.slot)) throw new Error('Invalid router slot');
    if (!isWireguardKey(peer.publicKey)) throw new Error('Invalid WireGuard public key');
    if (peer.publicKey === this.hubKey) throw new Error('Router key equals the hub key');
  }

  private async must(program: 'wg' | 'ip', args: string[]): Promise<string> {
    const r = await this.run(program, args);
    if (r.code !== 0) throw new Error(`${program} ${args[0]} failed: ${r.stderr.trim().slice(0, 200)}`);
    return r.stdout;
  }

  /** Adds or updates the peer: allowed-ips 10.77.S.2/32 and 10.78.S.0/24, route 10.78.S.0/24 dev wg0. */
  async applyPeer(peer: Peer): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    this.checkPeer(peer);
    return this.serial(async () => {
      const allowed = `${routerTunnelIp(peer.slot)}/32,${mappedCameraSubnet(peer.slot)}`;
      await this.must('wg', ['set', this.iface, 'peer', peer.publicKey, 'allowed-ips', allowed]);
      await this.must('ip', ['route', 'replace', mappedCameraSubnet(peer.slot), 'dev', this.iface]);
    });
  }

  /** Removes the peer and its route; a missing route is not an error. */
  async removePeer(peer: Peer): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    this.checkPeer(peer);
    return this.serial(async () => {
      await this.must('wg', ['set', this.iface, 'peer', peer.publicKey, 'remove']);
      await this.run('ip', ['route', 'del', mappedCameraSubnet(peer.slot), 'dev', this.iface]);
    });
  }

  /** Public keys of the interface's current peers. */
  async listPeers(): Promise<string[]> {
    if (!this.enabled) return [];
    const out = await this.must('wg', ['show', this.iface, 'peers']);
    return out.split(/\r?\n/).map((l) => l.trim()).filter(isWireguardKey);
  }

  /**
   * Peers this hub created: those whose allowed-ips hold a 10.78.S.0/24 router range. Other peers on the
   * interface (for example an administrator's own device) are never touched.
   */
  async listManagedPeers(): Promise<Peer[]> {
    if (!this.enabled) return [];
    const out = await this.must('wg', ['show', this.iface, 'allowed-ips']);
    const peers: Peer[] = [];
    for (const line of out.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2 || !isWireguardKey(parts[0])) continue;
      for (const range of parts.slice(1)) {
        const m = /^10\.78\.(\d{1,3})\.0\/24$/.exec(range);
        const slot = m ? Number(m[1]) : NaN;
        if (isValidSlot(slot)) {
          peers.push({ slot, publicKey: parts[0] });
          break;
        }
      }
    }
    return peers;
  }

  /** Latest handshake per peer key, unix ms (peers that never shook hands are left out). */
  async latestHandshakes(): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (!this.enabled) return map;
    const out = await this.must('wg', ['show', this.iface, 'latest-handshakes']);
    for (const line of out.split(/\r?\n/)) {
      const m = /^(\S+)\s+(\d+)$/.exec(line.trim());
      if (!m || !isWireguardKey(m[1])) continue;
      const seconds = Number(m[2]);
      if (seconds > 0) map.set(m[1], seconds * 1000);
    }
    return map;
  }
}

/** A tunnel counts as up while its latest handshake is younger than this (WireGuard re-handshakes every 2 minutes). */
export const TUNNEL_UP_WINDOW_MS = 180_000;
