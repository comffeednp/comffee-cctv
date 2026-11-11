/**
 * Renders deploy/cloud-init.yaml.template for a new server. The template uses {{NAME}} placeholders like
 * the other deploy templates. Every value is checked against a strict pattern before it goes in, so
 * nothing that YAML or a shell would treat specially (quotes, $, backticks, spaces, new lines, #, ;)
 * can reach the file. Unknown placeholders are an error rather than being left in.
 */

import { randomBytes } from 'node:crypto';

export const DEFAULT_REPO_URL = 'https://github.com/comffeednp/comffee-cctv.git';
export const DEFAULT_REPO_REF = 'main';

/** Oracle's limit for metadata (user_data is sent base64-encoded inside it). */
export const USER_DATA_MAX_BYTES = 32_000;

export interface CloudInitValues {
  repoUrl: string;
  repoRef: string;
  setupCode: string;
}

/** https only, host and path of letters, digits, dot, dash, underscore, tilde and slash. No query, no user info. */
export function isSafeRepoUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 300) return false;
  if (!/^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/.test(value) || value.includes('..')) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

/** A git branch or tag (git clone --branch): letters, digits, dot, dash, underscore and slash, not starting with - or / and without "..". */
export function isSafeRepoRef(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9_][A-Za-z0-9._\/-]{0,99}$/.test(value) &&
    !value.includes('..') &&
    !value.endsWith('/') &&
    !value.endsWith('.lock') &&
    !value.includes('//')
  );
}

/** 32 base32 letters (160 bits). */
export function isSetupCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z2-7]{32}$/.test(value);
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** A fresh one-time setup code: 20 random bytes as 32 base32 letters. */
export function newSetupCode(): string {
  return base32(randomBytes(20));
}

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

export function renderCloudInit(template: string, values: CloudInitValues): string {
  if (!isSafeRepoUrl(values.repoUrl)) throw new TemplateError('The project address must be a plain https address.');
  if (!isSafeRepoRef(values.repoRef)) throw new TemplateError('The version must be a branch or tag name.');
  if (!isSetupCode(values.setupCode)) throw new TemplateError('The setup code is not valid.');
  if (!template.includes('{{SETUP_CODE}}')) throw new TemplateError('The server template has no setup code placeholder.');
  const map: Record<string, string> = {
    REPO_URL: values.repoUrl,
    REPO_REF: values.repoRef,
    SETUP_CODE: values.setupCode,
  };
  const out = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, name: string) => {
    const value = map[name];
    if (value === undefined) throw new TemplateError(`The server template has an unknown placeholder ${match}.`);
    return value;
  });
  if (/\{\{|\}\}/.test(out)) throw new TemplateError('The server template has a broken placeholder.');
  return out;
}

/** base64 for Oracle's user_data metadata, refused when over Oracle's size limit. */
export function userDataBase64(rendered: string): string {
  const encoded = Buffer.from(rendered, 'utf8').toString('base64');
  if (encoded.length > USER_DATA_MAX_BYTES) throw new TemplateError('The server template is too large for Oracle.');
  return encoded;
}
