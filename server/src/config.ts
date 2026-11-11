/**
 * Hub configuration loader.
 *
 * The config file is JSON with the keys of HubConfig. Keys missing from the file take
 * HUB_CONFIG_DEFAULTS. The file path comes from COMFFEE_CCTV_CONFIG (or the shorter CCTV_CONFIG),
 * default /etc/comffee-cctv/hub.json.
 *
 * Development: with CCTV_DEV=1 a missing file is fine and these defaults apply instead:
 * dataDir ./data, publicOrigin http://localhost:8080, devInsecureCookies true, WireGuard off.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_PATH_ENV, DEFAULT_CONFIG_PATH, HUB_CONFIG_DEFAULTS } from './contracts.ts';
import type { HubConfig } from './contracts.ts';

/** Shorter alias for CONFIG_PATH_ENV. */
export const CONFIG_PATH_ENV_ALIAS = 'CCTV_CONFIG';
/** Set to "1" for development defaults. */
export const DEV_ENV = 'CCTV_DEV';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function isDevMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DEV_ENV] === '1';
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return env[CONFIG_PATH_ENV] || env[CONFIG_PATH_ENV_ALIAS] || DEFAULT_CONFIG_PATH;
}

function devDefaults(): HubConfig {
  return {
    ...HUB_CONFIG_DEFAULTS,
    dataDir: './data',
    publicOrigin: 'http://localhost:8080',
    devInsecureCookies: true,
    wireguard: { ...HUB_CONFIG_DEFAULTS.wireguard, enabled: false },
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function expectString(obj: Record<string, unknown>, key: string, fallback: string): string {
  const v = obj[key];
  if (v === undefined) return fallback;
  if (typeof v !== 'string') throw new Error(`Config "${key}" must be a string`);
  return v;
}

function expectBool(obj: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = obj[key];
  if (v === undefined) return fallback;
  if (typeof v !== 'boolean') throw new Error(`Config "${key}" must be true or false`);
  return v;
}

function expectPort(obj: Record<string, unknown>, key: string, fallback: number): number {
  const v = obj[key];
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 65535) {
    throw new Error(`Config "${key}" must be a port number 1..65535`);
  }
  return v;
}

/** Optional https:// address; null (or an empty string) means none. */
function expectHttpsUrlOrNull(obj: Record<string, unknown>, key: string, fallback: string | null): string | null {
  const v = obj[key];
  if (v === undefined) return fallback;
  if (v === null || v === '') return null;
  const problem = `Config "${key}" must be an https:// address or null`;
  if (typeof v !== 'string') throw new Error(problem);
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new Error(problem);
  }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error(problem);
  return url.href;
}

/** Normalises an origin such as "https://cctv.example.com" and rejects anything that is not one. */
export function normaliseOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Config "publicOrigin" is not a valid URL: ${value}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Config "publicOrigin" must start with https:// (or http:// for development)');
  }
  if (url.origin !== value.replace(/\/+$/, '')) {
    throw new Error('Config "publicOrigin" must be an origin only, for example https://cctv.example.com');
  }
  return url.origin;
}

/** Merges a parsed config object over a base config and validates it. */
export function buildConfig(raw: unknown, base: HubConfig = HUB_CONFIG_DEFAULTS): HubConfig {
  if (!isPlainObject(raw)) throw new Error('Config file must contain a JSON object');
  const wgRaw = raw.wireguard === undefined ? {} : raw.wireguard;
  if (!isPlainObject(wgRaw)) throw new Error('Config "wireguard" must be an object');

  const cfg: HubConfig = {
    dataDir: expectString(raw, 'dataDir', base.dataDir),
    listenHost: expectString(raw, 'listenHost', base.listenHost),
    listenPort: expectPort(raw, 'listenPort', base.listenPort),
    publicOrigin: expectString(raw, 'publicOrigin', base.publicOrigin),
    publicHost: expectString(raw, 'publicHost', base.publicHost),
    publicIp: expectString(raw, 'publicIp', base.publicIp),
    dashboardDir: expectString(raw, 'dashboardDir', base.dashboardDir),
    mediamtxApi: expectString(raw, 'mediamtxApi', base.mediamtxApi),
    mediamtxRtsp: expectString(raw, 'mediamtxRtsp', base.mediamtxRtsp),
    mediamtxWebrtc: expectString(raw, 'mediamtxWebrtc', base.mediamtxWebrtc),
    ffmpegPath: expectString(raw, 'ffmpegPath', base.ffmpegPath),
    ffprobePath: expectString(raw, 'ffprobePath', base.ffprobePath),
    wireguard: {
      enabled: expectBool(wgRaw, 'enabled', base.wireguard.enabled),
      interface: expectString(wgRaw, 'interface', base.wireguard.interface),
      listenPort: expectPort(wgRaw, 'listenPort', base.wireguard.listenPort),
      hubAddress: expectString(wgRaw, 'hubAddress', base.wireguard.hubAddress),
      publicKey: expectString(wgRaw, 'publicKey', base.wireguard.publicKey),
    },
    devInsecureCookies: expectBool(raw, 'devInsecureCookies', base.devInsecureCookies),
    bridgeDownloadUrl: expectHttpsUrlOrNull(raw, 'bridgeDownloadUrl', base.bridgeDownloadUrl),
  };

  if (!cfg.publicOrigin) throw new Error('Config "publicOrigin" is required, for example https://cctv.example.com');
  cfg.publicOrigin = normaliseOrigin(cfg.publicOrigin);
  if (!cfg.publicHost) cfg.publicHost = new URL(cfg.publicOrigin).hostname;
  if (!cfg.dataDir) throw new Error('Config "dataDir" must not be empty');
  cfg.dataDir = path.resolve(cfg.dataDir);
  cfg.dashboardDir = cfg.dashboardDir ? path.resolve(cfg.dashboardDir) : path.join(REPO_ROOT, 'dashboard', 'dist');
  if (cfg.wireguard.enabled && !cfg.wireguard.publicKey) {
    throw new Error('Config "wireguard.publicKey" is required when WireGuard is enabled');
  }
  return cfg;
}

/** Reads and validates the hub config. Throws with a plain message when something is wrong. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const file = configPath(env);
  const dev = isDevMode(env);
  const base = dev ? devDefaults() : HUB_CONFIG_DEFAULTS;
  if (!existsSync(file)) {
    if (dev) return buildConfig({}, base);
    throw new Error(`Config file not found: ${file} (set ${CONFIG_PATH_ENV}, or ${DEV_ENV}=1 for development)`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Config file ${file} is not valid JSON: ${(err as Error).message}`);
  }
  return buildConfig(raw, base);
}
