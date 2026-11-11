/**
 * Reads the "Configuration file preview" Oracle shows after adding an API key:
 *
 *   [DEFAULT]
 *   user=ocid1.user.oc1..aaaa...
 *   fingerprint=12:34:...
 *   tenancy=ocid1.tenancy.oc1..aaaa...
 *   region=ap-singapore-1
 *   key_file=<path to your private keyfile> # TODO
 *
 * key_file is ignored; the person picks the key file instead.
 */

import { isOciRegion } from './oci-regions.ts';

export interface ApiKeyConfig {
  userId: string;
  tenancyId: string;
  fingerprint: string;
  region: string;
}

export type ParseResult = { ok: true; config: ApiKeyConfig } | { ok: false; error: string };

export const CONFIG_TEXT_MAX = 4000;

const OCID_USER = /^ocid1\.user\.oc1\.[a-z0-9-]*\.[a-z0-9]{20,100}$/;
const OCID_TENANCY = /^ocid1\.tenancy\.oc1\.[a-z0-9-]*\.[a-z0-9]{20,100}$/;
const FINGERPRINT = /^([0-9a-f]{2}:){15}[0-9a-f]{2}$/;

export function isFingerprint(value: unknown): value is string {
  return typeof value === 'string' && FINGERPRINT.test(value);
}

export function parseConfigPreview(text: string): ParseResult {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'Paste the configuration text from Oracle.' };
  if (text.length > CONFIG_TEXT_MAX) return { ok: false, error: 'That text is too long. Paste only the configuration file preview.' };
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  let sections = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      sections += 1;
      continue;
    }
    // Only the first profile counts.
    if (sections > 1) break;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).replace(/\s+#.*$/, '').trim();
    if (!(key in values)) values[key] = value;
  }
  const userId = values.user ?? '';
  const tenancyId = values.tenancy ?? '';
  const fingerprint = (values.fingerprint ?? '').toLowerCase();
  const region = values.region ?? '';
  if (!OCID_USER.test(userId)) return { ok: false, error: 'The text has no user line. Copy the whole configuration file preview.' };
  if (!OCID_TENANCY.test(tenancyId)) return { ok: false, error: 'The text has no tenancy line. Copy the whole configuration file preview.' };
  if (!FINGERPRINT.test(fingerprint)) return { ok: false, error: 'The text has no fingerprint line. Copy the whole configuration file preview.' };
  if (!isOciRegion(region)) return { ok: false, error: 'The region in the text is not one this app knows.' };
  return { ok: true, config: { userId, tenancyId, fingerprint, region } };
}
