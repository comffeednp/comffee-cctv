/**
 * CCV1 vault file format, shared by the hub (writer) and the dashboard (reader).
 *
 * Pure TypeScript: Uint8Array, DataView, TextEncoder/TextDecoder and globalThis.crypto.subtle only,
 * so it runs unchanged in Node and in browsers.
 *
 * Header (all integers big-endian):
 *   "CCV1" (4) | headerLength u32 (whole header incl. magic) | keyId (16) | wrappedKeyLength u16 |
 *   wrappedKey (RSA-OAEP SHA-256 of a fresh 32-byte AES-256 key) | noncePrefix (8) | chunkSize u32 |
 *   metaLength u32 | meta (UTF-8 JSON {"v":1,"cameraId","locationId","start","durationMs","mime":"video/mp4"})
 * Body:
 *   floor(P / chunkSize) + 1 chunks; the last holds P mod chunkSize plaintext bytes (may be 0).
 *   Each chunk = AES-256-GCM ciphertext || 16-byte tag.
 *   nonce = noncePrefix || u32 chunk index
 *   AAD   = full header bytes || u32 chunk index || u8 (1 if last chunk else 0)
 * keyId = first 16 bytes of SHA-256 of the public key's SPKI DER (hex in the API).
 *
 * Also defines the recovery file (the owner's passphrase-protected private key) and the
 * browser key store names.
 */

/* --------------------------------------------------------------- constants */

/** "CCV1" */
export const MAGIC = new Uint8Array([0x43, 0x43, 0x56, 0x31]);
export const MAGIC_TEXT = 'CCV1';
/** Plaintext bytes per chunk written by the hub (1 MiB). */
export const CHUNK_SIZE = 1048576;
/** Largest chunk size a reader accepts. */
export const MAX_CHUNK_SIZE = 16 * 1048576;
export const TAG_BYTES = 16;
export const KEY_ID_BYTES = 16;
export const NONCE_PREFIX_BYTES = 8;
/** AES-GCM nonce: prefix (8) + chunk index (4). */
export const NONCE_BYTES = 12;
export const AES_KEY_BYTES = 32;
/** Magic + headerLength: enough to learn the full header length. */
export const HEADER_PREFIX_BYTES = 8;
/** Header bytes besides wrappedKey and meta: 4 + 4 + 16 + 2 + 8 + 4 + 4. */
export const HEADER_FIXED_BYTES = 42;
/** Largest header a reader accepts. */
export const MAX_HEADER_BYTES = 65536;
/** Largest wrapped key a reader accepts (RSA up to 8192 bits). */
export const MAX_WRAPPED_KEY_BYTES = 1024;
export const VAULT_MIME = 'video/mp4';
export const VAULT_FILE_EXTENSION = '.ccv';

/** Vault key pair parameters (generated in the browser at setup). */
export const RSA_MODULUS_BITS = 3072;
export const RSA_PUBLIC_EXPONENT = new Uint8Array([0x01, 0x00, 0x01]);
export const RSA_HASH = 'SHA-256';

/** Recovery file parameters. */
export const RECOVERY_FORMAT = 'comffee-cctv-recovery';
export const RECOVERY_VERSION = 1;
export const PBKDF2_ITERATIONS = 600000;
export const PBKDF2_SALT_BYTES = 16;
export const RECOVERY_IV_BYTES = 12;
export const RECOVERY_PASSPHRASE_MIN = 12;

/** Browser IndexedDB where imported private keys live as non-extractable CryptoKeys, keyed by keyId. */
export const KEY_DB_NAME = 'comffee-cctv';
export const KEY_STORE_NAME = 'keys';

/* ------------------------------------------------------------------- types */

type Subtle = typeof globalThis.crypto.subtle;
/** WebCrypto key, typed so it works in both Node and DOM builds. */
export type VaultCryptoKey = Awaited<ReturnType<Subtle['importKey']>>;
export interface VaultKeyPair {
  publicKey: VaultCryptoKey;
  privateKey: VaultCryptoKey;
}

/** Segment metadata stored in the header. */
export interface VaultMeta {
  v: 1;
  cameraId: number;
  locationId: number;
  /** ISO 8601 UTC start of the segment. */
  start: string;
  durationMs: number;
  mime: 'video/mp4';
}

/** Header fields. */
export interface VaultHeader {
  /** 32 lowercase hex characters. */
  keyId: string;
  wrappedKey: Uint8Array;
  /** 8 random bytes, fresh per file. */
  noncePrefix: Uint8Array;
  chunkSize: number;
  meta: VaultMeta;
}

/** Decoded header plus the exact header bytes (needed for the AAD). */
export interface DecodedHeader extends VaultHeader {
  headerLength: number;
  headerBytes: Uint8Array<ArrayBuffer>;
}

/** Chunk arithmetic for a body (everything after the header). */
export interface ChunkLayout {
  count: number;
  /** Ciphertext + tag length of the last chunk (>= TAG_BYTES). */
  lastCipherLength: number;
  lastPlainLength: number;
  plainLength: number;
}

/** Recovery file JSON (base64 fields). */
export interface RecoveryFile {
  format: 'comffee-cctv-recovery';
  version: 1;
  keyId: string;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  cipher: { name: 'AES-GCM'; iv: string };
  /** AES-GCM encryption of the PKCS8 private key, base64. */
  data: string;
  createdAt: string;
}

/* ------------------------------------------------------------ byte helpers */

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true });

function fail(message: string): never {
  throw new Error(`CCV1: ${message}`);
}

/** Returns a view backed by a plain ArrayBuffer (WebCrypto rejects shared buffers in its types). */
function plainView(u: Uint8Array): Uint8Array<ArrayBuffer> {
  return u.buffer instanceof ArrayBuffer ? (u as Uint8Array<ArrayBuffer>) : new Uint8Array(u);
}

export function concatBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) fail('invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64)) {
    throw new Error('Invalid base64');
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Base64url without padding. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(b64url: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(b64url) || b64url.length % 4 === 1) throw new Error('Invalid base64url');
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  return base64ToBytes(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}

/* -------------------------------------------------------------------- meta */

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const META_KEYS = ['v', 'cameraId', 'locationId', 'start', 'durationMs', 'mime'];

function isPositiveId(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
}

/** Throws unless `value` is a valid VaultMeta with exactly the expected keys. */
export function validateMeta(value: unknown): VaultMeta {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('meta is not an object');
  const m = value as Record<string, unknown>;
  const keys = Object.keys(m);
  if (keys.length !== META_KEYS.length || !META_KEYS.every((k) => keys.includes(k))) fail('meta keys mismatch');
  if (m.v !== 1) fail('meta version mismatch');
  if (!isPositiveId(m.cameraId)) fail('meta cameraId invalid');
  if (!isPositiveId(m.locationId)) fail('meta locationId invalid');
  if (typeof m.start !== 'string' || !ISO_UTC.test(m.start) || !Number.isFinite(Date.parse(m.start))) {
    fail('meta start invalid');
  }
  if (typeof m.durationMs !== 'number' || !Number.isSafeInteger(m.durationMs) || m.durationMs < 0) {
    fail('meta durationMs invalid');
  }
  if (m.mime !== VAULT_MIME) fail('meta mime mismatch');
  return m as unknown as VaultMeta;
}

function encodeMeta(meta: VaultMeta): Uint8Array {
  const m = validateMeta(meta);
  return encoder.encode(
    JSON.stringify({
      v: m.v,
      cameraId: m.cameraId,
      locationId: m.locationId,
      start: m.start,
      durationMs: m.durationMs,
      mime: m.mime,
    }),
  );
}

/* ------------------------------------------------------------------ header */

function checkChunkSize(chunkSize: number): void {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_CHUNK_SIZE) fail('chunkSize out of range');
}

/** Builds the header bytes. */
export function encodeHeader(h: VaultHeader): Uint8Array<ArrayBuffer> {
  const keyId = hexToBytes(h.keyId);
  if (keyId.length !== KEY_ID_BYTES) fail('keyId must be 16 bytes');
  if (h.wrappedKey.length < 1 || h.wrappedKey.length > MAX_WRAPPED_KEY_BYTES) fail('wrappedKey length out of range');
  if (h.noncePrefix.length !== NONCE_PREFIX_BYTES) fail('noncePrefix must be 8 bytes');
  checkChunkSize(h.chunkSize);
  const meta = encodeMeta(h.meta);
  const length = HEADER_FIXED_BYTES + h.wrappedKey.length + meta.length;
  if (length > MAX_HEADER_BYTES) fail('header too large');

  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  let at = 0;
  out.set(MAGIC, at);
  at += 4;
  view.setUint32(at, length);
  at += 4;
  out.set(keyId, at);
  at += KEY_ID_BYTES;
  view.setUint16(at, h.wrappedKey.length);
  at += 2;
  out.set(h.wrappedKey, at);
  at += h.wrappedKey.length;
  out.set(h.noncePrefix, at);
  at += NONCE_PREFIX_BYTES;
  view.setUint32(at, h.chunkSize);
  at += 4;
  view.setUint32(at, meta.length);
  at += 4;
  out.set(meta, at);
  return out;
}

/**
 * Reads headerLength from the first HEADER_PREFIX_BYTES bytes, after checking the magic.
 * Lets a streaming reader know how many bytes to collect before decodeHeader.
 */
export function readHeaderLength(prefix: Uint8Array): number {
  if (prefix.length < HEADER_PREFIX_BYTES) fail('truncated header');
  for (let i = 0; i < 4; i++) if (prefix[i] !== MAGIC[i]) fail('bad magic');
  const length = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getUint32(4);
  if (length < HEADER_FIXED_BYTES + 1 + 2 || length > MAX_HEADER_BYTES) fail('headerLength out of range');
  return length;
}

/**
 * Parses and strictly validates a header. `bytes` may be the whole file; only the header part is read.
 * Throws on any mismatch (magic, lengths, sizes, meta).
 */
export function decodeHeader(bytes: Uint8Array): DecodedHeader {
  const headerLength = readHeaderLength(bytes);
  if (bytes.length < headerLength) fail('truncated header');
  const headerBytes = new Uint8Array(bytes.subarray(0, headerLength));
  const view = new DataView(headerBytes.buffer);
  let at = 8;
  const keyId = bytesToHex(headerBytes.subarray(at, at + KEY_ID_BYTES));
  at += KEY_ID_BYTES;
  const wrappedLength = view.getUint16(at);
  at += 2;
  if (wrappedLength < 1 || wrappedLength > MAX_WRAPPED_KEY_BYTES) fail('wrappedKey length out of range');
  if (at + wrappedLength + NONCE_PREFIX_BYTES + 8 > headerLength) fail('wrappedKey overruns header');
  const wrappedKey = headerBytes.slice(at, at + wrappedLength);
  at += wrappedLength;
  const noncePrefix = headerBytes.slice(at, at + NONCE_PREFIX_BYTES);
  at += NONCE_PREFIX_BYTES;
  const chunkSize = view.getUint32(at);
  at += 4;
  checkChunkSize(chunkSize);
  const metaLength = view.getUint32(at);
  at += 4;
  if (at + metaLength !== headerLength) fail('headerLength does not match field lengths');
  let metaValue: unknown;
  try {
    metaValue = JSON.parse(strictDecoder.decode(headerBytes.subarray(at, at + metaLength)));
  } catch {
    fail('meta is not valid UTF-8 JSON');
  }
  const meta = validateMeta(metaValue);
  return { keyId, wrappedKey, noncePrefix, chunkSize, meta, headerLength, headerBytes };
}

/* ------------------------------------------------------------------ chunks */

function checkIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) fail('chunk index out of range');
}

/** AES-GCM nonce for a chunk: noncePrefix || u32 BE index. */
export function chunkNonce(prefix: Uint8Array, index: number): Uint8Array<ArrayBuffer> {
  if (prefix.length !== NONCE_PREFIX_BYTES) fail('noncePrefix must be 8 bytes');
  checkIndex(index);
  const out = new Uint8Array(NONCE_BYTES);
  out.set(prefix, 0);
  new DataView(out.buffer).setUint32(NONCE_PREFIX_BYTES, index);
  return out;
}

/** AAD for a chunk: full header bytes || u32 BE index || u8 last flag. */
export function chunkAad(headerBytes: Uint8Array, index: number, isLast: boolean): Uint8Array<ArrayBuffer> {
  checkIndex(index);
  const out = new Uint8Array(headerBytes.length + 5);
  out.set(headerBytes, 0);
  const view = new DataView(out.buffer);
  view.setUint32(headerBytes.length, index);
  view.setUint8(headerBytes.length + 4, isLast ? 1 : 0);
  return out;
}

/** Number of chunks for a plaintext of `plainLength` bytes. */
export function chunkCount(plainLength: number, chunkSize: number): number {
  checkChunkSize(chunkSize);
  if (!Number.isSafeInteger(plainLength) || plainLength < 0) fail('plainLength invalid');
  return Math.floor(plainLength / chunkSize) + 1;
}

/** Encrypted body length for a plaintext of `plainLength` bytes. */
export function cipherBodyLength(plainLength: number, chunkSize: number): number {
  return plainLength + TAG_BYTES * chunkCount(plainLength, chunkSize);
}

/**
 * Chunk layout of an encrypted body of `bodyLength` bytes (file size minus headerLength).
 * Throws if no plaintext length produces that body length.
 */
export function chunkLayout(bodyLength: number, chunkSize: number): ChunkLayout {
  checkChunkSize(chunkSize);
  if (!Number.isSafeInteger(bodyLength) || bodyLength < TAG_BYTES) fail('body too short');
  const full = chunkSize + TAG_BYTES;
  const fullChunks = Math.floor(bodyLength / full);
  const lastCipherLength = bodyLength - fullChunks * full;
  if (lastCipherLength < TAG_BYTES) fail('impossible body length');
  const count = fullChunks + 1;
  if (count - 1 > 0xffffffff) fail('too many chunks');
  const lastPlainLength = lastCipherLength - TAG_BYTES;
  return { count, lastCipherLength, lastPlainLength, plainLength: fullChunks * chunkSize + lastPlainLength };
}

/* ----------------------------------------------------------------- keys */

/** keyId: hex of the first 16 bytes of SHA-256(SPKI DER). */
export async function keyIdFromSpki(spkiDer: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', plainView(spkiDer)));
  return bytesToHex(digest.subarray(0, KEY_ID_BYTES));
}

const RSA_OAEP_IMPORT = { name: 'RSA-OAEP', hash: RSA_HASH };

/** New RSA-OAEP 3072 / SHA-256 vault key pair. Extractable, so the private key can go into a recovery file. */
export async function generateVaultKeyPair(): Promise<VaultKeyPair> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: RSA_MODULUS_BITS, publicExponent: RSA_PUBLIC_EXPONENT, hash: RSA_HASH },
    true,
    ['encrypt', 'decrypt'],
  )) as VaultKeyPair;
  return pair;
}

/** Public key as SPKI DER. */
export async function exportSpki(publicKey: VaultCryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.exportKey('spki', publicKey));
}

/** Imports a vault public key (SPKI DER) for encryption. */
export async function importVaultPublicKey(spkiDer: Uint8Array): Promise<VaultCryptoKey> {
  return crypto.subtle.importKey('spki', plainView(spkiDer), RSA_OAEP_IMPORT, true, ['encrypt']);
}

/* ------------------------------------------------------- whole-file crypto */

/**
 * Encrypts a whole plaintext into a CCV1 file with WebCrypto.
 * The hub streams with node:crypto instead; this is the reference implementation and test helper.
 */
export async function sealVaultFile(
  plain: Uint8Array,
  publicKey: VaultCryptoKey,
  meta: VaultMeta,
  chunkSize: number = CHUNK_SIZE,
): Promise<Uint8Array<ArrayBuffer>> {
  const keyId = await keyIdFromSpki(await exportSpki(publicKey));
  const rawKey = crypto.getRandomValues(new Uint8Array(AES_KEY_BYTES));
  const wrappedKey = new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, rawKey));
  const aesKey = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt']);
  rawKey.fill(0);
  const noncePrefix = crypto.getRandomValues(new Uint8Array(NONCE_PREFIX_BYTES));
  const headerBytes = encodeHeader({ keyId, wrappedKey, noncePrefix, chunkSize, meta });

  const source = plainView(plain);
  const count = chunkCount(source.length, chunkSize);
  const parts: Uint8Array[] = [headerBytes];
  for (let i = 0; i < count; i++) {
    const chunk = source.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, source.length));
    const cipher = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: chunkNonce(noncePrefix, i), additionalData: chunkAad(headerBytes, i, i === count - 1), tagLength: 128 },
      aesKey,
      chunk,
    );
    parts.push(new Uint8Array(cipher));
  }
  return concatBytes(parts);
}

/**
 * Decrypts a whole CCV1 file. `privateKey` is the RSA-OAEP private key (usage 'decrypt') for header.keyId.
 * Throws if the file is malformed, truncated, reordered or altered.
 */
export async function openVaultFile(
  file: Uint8Array,
  privateKey: VaultCryptoKey,
): Promise<{ header: DecodedHeader; plain: Uint8Array<ArrayBuffer> }> {
  const header = decodeHeader(file);
  const body = plainView(file).subarray(header.headerLength);
  const layout = chunkLayout(body.length, header.chunkSize);
  const rawKey = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, plainView(header.wrappedKey)),
  );
  if (rawKey.length !== AES_KEY_BYTES) fail('wrapped key has wrong length');
  const aesKey = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
  rawKey.fill(0);

  const plain = new Uint8Array(layout.plainLength);
  const full = header.chunkSize + TAG_BYTES;
  for (let i = 0; i < layout.count; i++) {
    const isLast = i === layout.count - 1;
    const start = i * full;
    const chunk = body.subarray(start, isLast ? body.length : start + full);
    const clear = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: chunkNonce(header.noncePrefix, i), additionalData: chunkAad(header.headerBytes, i, isLast), tagLength: 128 },
      aesKey,
      chunk,
    );
    plain.set(new Uint8Array(clear), i * header.chunkSize);
  }
  return { header, plain };
}

/* --------------------------------------------------------- recovery file */

async function recoveryWrapKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
  usage: 'encrypt' | 'decrypt',
): Promise<VaultCryptoKey> {
  const base = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

/** Builds the recovery file for an extractable private key. */
export async function createRecoveryFile(
  privateKey: VaultCryptoKey,
  keyId: string,
  passphrase: string,
  createdAt: Date = new Date(),
): Promise<RecoveryFile> {
  if (passphrase.length < RECOVERY_PASSPHRASE_MIN) throw new Error('Passphrase too short');
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', privateKey));
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(RECOVERY_IV_BYTES));
  const key = await recoveryWrapKey(passphrase, salt, PBKDF2_ITERATIONS, 'encrypt');
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pkcs8));
  pkcs8.fill(0);
  return {
    format: RECOVERY_FORMAT,
    version: RECOVERY_VERSION,
    keyId,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt: bytesToBase64(salt) },
    cipher: { name: 'AES-GCM', iv: bytesToBase64(iv) },
    data: bytesToBase64(data),
    createdAt: createdAt.toISOString(),
  };
}

/** Throws unless `value` looks like a version 1 recovery file. */
export function validateRecoveryFile(value: unknown): RecoveryFile {
  const f = value as RecoveryFile | null;
  if (
    !f ||
    f.format !== RECOVERY_FORMAT ||
    f.version !== RECOVERY_VERSION ||
    typeof f.keyId !== 'string' ||
    !/^[0-9a-f]{32}$/.test(f.keyId) ||
    !f.kdf ||
    f.kdf.name !== 'PBKDF2' ||
    f.kdf.hash !== 'SHA-256' ||
    !Number.isSafeInteger(f.kdf.iterations) ||
    f.kdf.iterations < PBKDF2_ITERATIONS ||
    f.kdf.iterations > 10_000_000 ||
    typeof f.kdf.salt !== 'string' ||
    !f.cipher ||
    f.cipher.name !== 'AES-GCM' ||
    typeof f.cipher.iv !== 'string' ||
    typeof f.data !== 'string'
  ) {
    throw new Error('Not a Comffee CCTV recovery file');
  }
  return f;
}

/**
 * Opens a recovery file. Returns the private key (non-extractable unless asked) after checking it
 * really belongs to file.keyId. Throws "Wrong passphrase or damaged file" when decryption fails.
 */
export async function openRecoveryFile(
  value: unknown,
  passphrase: string,
  extractable = false,
): Promise<{ keyId: string; privateKey: VaultCryptoKey }> {
  const f = validateRecoveryFile(value);
  const key = await recoveryWrapKey(passphrase, base64ToBytes(f.kdf.salt), f.kdf.iterations, 'decrypt');
  let pkcs8: Uint8Array<ArrayBuffer>;
  try {
    pkcs8 = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(f.cipher.iv) }, key, base64ToBytes(f.data)),
    );
  } catch {
    throw new Error('Wrong passphrase or damaged file');
  }
  // Derive the public key from the private key to prove the keyId matches.
  const probe = await crypto.subtle.importKey('pkcs8', pkcs8, RSA_OAEP_IMPORT, true, ['decrypt']);
  const jwk = await crypto.subtle.exportKey('jwk', probe);
  const pub = await crypto.subtle.importKey(
    'jwk',
    { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RSA-OAEP-256', ext: true },
    RSA_OAEP_IMPORT,
    true,
    ['encrypt'],
  );
  const actualKeyId = await keyIdFromSpki(await exportSpki(pub));
  if (actualKeyId !== f.keyId) {
    pkcs8.fill(0);
    throw new Error('Recovery file key does not match its key id');
  }
  const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, RSA_OAEP_IMPORT, extractable, ['decrypt']);
  pkcs8.fill(0);
  return { keyId: f.keyId, privateKey };
}
