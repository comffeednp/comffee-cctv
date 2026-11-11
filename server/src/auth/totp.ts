/**
 * 2-step codes: RFC 4226 HOTP / RFC 6238 TOTP (SHA-1, 6 digits, 30 s), RFC 4648 base32.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { TOTP_DIGITS, TOTP_ISSUER, TOTP_PERIOD_SECONDS } from '../../../shared/api-types.ts';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const SECRET_BYTES = 20;
/** Accepted clock drift in steps, either way. */
export const TOTP_WINDOW = 1;

export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Decodes base32 (case-insensitive, spaces, dashes and padding ignored). Throws on other characters. */
export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32 character');
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

export type HotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

/** RFC 4226 HOTP value for one counter. */
export function hotp(secret: Uint8Array, counter: number, digits = TOTP_DIGITS, algorithm: HotpAlgorithm = 'sha1'): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** The TOTP code at a given time. */
export function totpCode(secretBase32: string, nowMs: number, digits = TOTP_DIGITS): string {
  return hotp(base32Decode(secretBase32), totpStep(nowMs), digits);
}

function sameCode(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Checks a 6-digit code within +-1 step. Returns the matched step, or null.
 * Replay guard: steps at or before lastStep are never accepted.
 */
export function verifyTotp(secretBase32: string, code: string, nowMs: number, lastStep: number): number | null {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const current = totpStep(nowMs);
  let matched: number | null = null;
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step++) {
    // Check every step so the time taken does not depend on which one matched.
    if (sameCode(hotp(secret, step), code) && step > lastStep && matched === null) matched = step;
  }
  return matched;
}

/** otpauth://totp/Comffee%20CCTV:<username>?secret=...&issuer=Comffee%20CCTV&algorithm=SHA1&digits=6&period=30 */
export function otpauthUrl(username: string, secretBase32: string): string {
  const issuer = encodeURIComponent(TOTP_ISSUER);
  const label = `${issuer}:${encodeURIComponent(username)}`;
  return (
    `otpauth://totp/${label}?secret=${secretBase32}&issuer=${issuer}` +
    `&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`
  );
}
