/**
 * Bridge settings from a JSON config file and/or command-line flags (flags win).
 *
 * Config file: {"hub": "wss://cctv.example.com/bridge", "token": "...", "name": "front desk PC"}
 * Looked up from --config, else bridge.json in $CREDENTIALS_DIRECTORY (systemd LoadCredential).
 * The token may also come from the COMFFEE_CCTV_BRIDGE_TOKEN environment variable.
 */

import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

export const BRIDGE_VERSION = '0.1.0';
export const TOKEN_ENV = 'COMFFEE_CCTV_BRIDGE_TOKEN';
const BRIDGE_PATH = '/bridge';

export interface BridgeConfig {
  /** wss:// URL of the hub's /bridge endpoint. */
  hub: string;
  token: string;
  /** Shown to the owner; defaults to the host name. */
  name: string;
}

export type ParseResult =
  | { kind: 'run'; config: BridgeConfig; configPath: string | null }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'error'; message: string };

export const USAGE = `Comffee CCTV bridge ${BRIDGE_VERSION}

Relays camera connections from this network to a Comffee CCTV hub. It only reaches private
IPv4 addresses on ports 554, 2020, 80 and 8000, and never stores video.

Usage:
  comffee-cctv-bridge --hub wss://<hub>/bridge --token <token> [--name <name>]
  comffee-cctv-bridge --config <path to bridge.json>

Options:
  --hub <url>       Hub address, for example wss://cctv.example.com/bridge
  --token <token>   Bridge token from the location page (or set ${TOKEN_ENV})
  --name <name>     Name shown on the location page (default: this computer's name)
  --config <path>   JSON file with "hub", "token" and optional "name"
  --help            Show this help
  --version         Show the version
`;

/** Normalises the hub address: https becomes wss, the path defaults to /bridge. Plain ws only for this computer. */
export function normalizeHubUrl(text: string): string {
  let url: URL;
  try {
    url = new URL(text.includes('://') ? text : `wss://${text}`);
  } catch {
    throw new Error('The hub address is not a valid URL.');
  }
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') throw new Error('The hub address must start with wss://');
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol === 'ws:' && !local) throw new Error('The hub address must use wss:// (encrypted).');
  if (url.username || url.password) throw new Error('The hub address must not contain a user name or password.');
  if (url.pathname === '' || url.pathname === '/') url.pathname = BRIDGE_PATH;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function isTokenShape(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}

function cleanName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);
}

function readConfigFile(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`Could not read the config file ${path}.`);
  }
  try {
    const v: unknown = JSON.parse(text.replace(/^﻿/, ''));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v as Record<string, unknown>;
  } catch {
    throw new Error(`The config file ${path} is not a JSON object.`);
  }
}

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv): ParseResult {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { kind: 'help' };
    if (arg === '--version' || arg === '-v') return { kind: 'version' };
    const m = /^--(hub|token|name|config)(?:=(.*))?$/.exec(arg);
    if (!m) return { kind: 'error', message: `Unknown option ${arg}. Use --help.` };
    const value = m[2] ?? argv[++i];
    if (value === undefined || value === '') return { kind: 'error', message: `Option --${m[1]} needs a value.` };
    flags.set(m[1], value);
  }

  let configPath = flags.get('config') ?? null;
  if (configPath === null && env.CREDENTIALS_DIRECTORY) {
    const candidate = join(env.CREDENTIALS_DIRECTORY, 'bridge.json');
    if (existsSync(candidate)) configPath = candidate;
  }
  let file: Record<string, unknown> = {};
  try {
    if (configPath !== null) file = readConfigFile(configPath);
  } catch (err) {
    return { kind: 'error', message: (err as Error).message };
  }

  const pick = (key: string): string | undefined => {
    const v = flags.get(key) ?? file[key];
    return typeof v === 'string' && v !== '' ? v : undefined;
  };
  const hubText = pick('hub');
  const token = pick('token') ?? env[TOKEN_ENV];
  if (!hubText) return { kind: 'error', message: 'The hub address is missing (--hub or "hub" in the config file).' };
  if (!token) return { kind: 'error', message: 'The bridge token is missing (--token, "token" in the config file, or ' + TOKEN_ENV + ').' };
  if (!isTokenShape(token)) return { kind: 'error', message: 'The bridge token does not look right. Copy it again from the location page.' };
  let hub: string;
  try {
    hub = normalizeHubUrl(hubText);
  } catch (err) {
    return { kind: 'error', message: (err as Error).message };
  }
  const name = cleanName(pick('name') ?? hostname()) || 'bridge';
  return { kind: 'run', config: { hub, token, name }, configPath };
}
