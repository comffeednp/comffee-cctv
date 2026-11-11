import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, publicEncrypt, constants, randomBytes, createPublicKey } from 'node:crypto';
import {
  CHUNK_SIZE,
  TAG_BYTES,
  HEADER_FIXED_BYTES,
  base64ToBytes,
  base64UrlToBytes,
  bytesToBase64,
  bytesToBase64Url,
  bytesToHex,
  chunkAad,
  chunkCount,
  chunkLayout,
  chunkNonce,
  cipherBodyLength,
  concatBytes,
  createRecoveryFile,
  decodeHeader,
  encodeHeader,
  exportSpki,
  generateVaultKeyPair,
  hexToBytes,
  keyIdFromSpki,
  openRecoveryFile,
  openVaultFile,
  readHeaderLength,
  sealVaultFile,
} from '../vault-format.ts';
import type { VaultHeader, VaultMeta } from '../vault-format.ts';

const meta: VaultMeta = {
  v: 1,
  cameraId: 7,
  locationId: 3,
  start: '2026-01-31T13:05:00.000Z',
  durationMs: 300000,
  mime: 'video/mp4',
};

function sampleHeader(): VaultHeader {
  return {
    keyId: '00112233445566778899aabbccddeeff',
    wrappedKey: new Uint8Array(384).fill(9),
    noncePrefix: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    chunkSize: CHUNK_SIZE,
    meta,
  };
}

const pairPromise = generateVaultKeyPair();

test('base64, base64url and hex round trip', () => {
  for (const len of [0, 1, 2, 3, 4, 5, 100, 70000]) {
    const bytes = new Uint8Array(len).map((_, i) => (i * 37 + 11) & 0xff);
    assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
    assert.deepEqual(base64UrlToBytes(bytesToBase64Url(bytes)), bytes);
    assert.deepEqual(hexToBytes(bytesToHex(bytes)), bytes);
    assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
    assert.equal(bytesToBase64Url(bytes), Buffer.from(bytes).toString('base64url'));
  }
  assert.throws(() => base64ToBytes('abc'));
  assert.throws(() => base64UrlToBytes('a+b'));
  assert.throws(() => hexToBytes('abc'));
});

test('header encodes and decodes exactly', () => {
  const h = sampleHeader();
  const bytes = encodeHeader(h);
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'CCV1');
  assert.equal(readHeaderLength(bytes), bytes.length);
  const metaLen = new TextEncoder().encode(JSON.stringify(meta)).length;
  assert.equal(bytes.length, HEADER_FIXED_BYTES + 384 + metaLen);
  const d = decodeHeader(concatBytes([bytes, new Uint8Array(50)]));
  assert.equal(d.keyId, h.keyId);
  assert.deepEqual(d.wrappedKey, h.wrappedKey);
  assert.deepEqual(d.noncePrefix, h.noncePrefix);
  assert.equal(d.chunkSize, CHUNK_SIZE);
  assert.deepEqual(d.meta, meta);
  assert.equal(d.headerLength, bytes.length);
  assert.deepEqual(d.headerBytes, bytes);
});

test('header decoding rejects any mismatch', () => {
  const good = encodeHeader(sampleHeader());
  const mutate = (fn: (b: Uint8Array, v: DataView) => void) => {
    const b = new Uint8Array(good);
    fn(b, new DataView(b.buffer));
    return b;
  };
  assert.throws(() => decodeHeader(mutate((b) => (b[0] = 0x58))), /bad magic/);
  assert.throws(() => decodeHeader(good.subarray(0, good.length - 1)), /truncated/);
  assert.throws(() => decodeHeader(mutate((_, v) => v.setUint32(4, good.length + 1))), /truncated|match/);
  assert.throws(() => decodeHeader(concatBytes([mutate((_, v) => v.setUint32(4, good.length + 1)), new Uint8Array(1)])), /match/);
  assert.throws(() => decodeHeader(mutate((_, v) => v.setUint16(24, 0))), /wrappedKey/);
  assert.throws(() => decodeHeader(mutate((_, v) => v.setUint32(26 + 384 + 8, 0))), /chunkSize/);
  assert.throws(() => decodeHeader(mutate((b) => (b[b.length - 2] = 0x20))), /meta/);
  assert.throws(() => encodeHeader({ ...sampleHeader(), keyId: 'abcd' }), /keyId/);
  assert.throws(() => encodeHeader({ ...sampleHeader(), noncePrefix: new Uint8Array(7) }), /noncePrefix/);
  assert.throws(() => encodeHeader({ ...sampleHeader(), meta: { ...meta, mime: 'video/webm' as 'video/mp4' } }), /mime/);
  assert.throws(() => encodeHeader({ ...sampleHeader(), meta: { ...meta, start: 'yesterday' } }), /start/);
  assert.throws(() => encodeHeader({ ...sampleHeader(), meta: { ...meta, extra: 1 } as VaultMeta }), /keys/);
});

test('nonce and AAD layout', () => {
  const n = chunkNonce(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 0x01020304);
  assert.deepEqual([...n], [1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 3, 4]);
  const aad = chunkAad(new Uint8Array([9, 9]), 5, true);
  assert.deepEqual([...aad], [9, 9, 0, 0, 0, 5, 1]);
  assert.deepEqual([...chunkAad(new Uint8Array([9]), 0, false)], [9, 0, 0, 0, 0, 0]);
  assert.throws(() => chunkNonce(new Uint8Array(8), -1));
  assert.throws(() => chunkNonce(new Uint8Array(8), 2 ** 32));
});

test('chunk layout math', () => {
  const cs = 1000;
  for (const [p, count, last] of [
    [0, 1, 0],
    [1, 1, 1],
    [cs - 1, 1, cs - 1],
    [cs, 2, 0],
    [2 * cs + 5, 3, 5],
  ] as const) {
    assert.equal(chunkCount(p, cs), count);
    const body = cipherBodyLength(p, cs);
    assert.equal(body, p + TAG_BYTES * count);
    const l = chunkLayout(body, cs);
    assert.deepEqual(l, { count, lastCipherLength: last + TAG_BYTES, lastPlainLength: last, plainLength: p });
  }
  assert.equal(chunkLayout(cipherBodyLength(CHUNK_SIZE, CHUNK_SIZE), CHUNK_SIZE).count, 2);
  assert.throws(() => chunkLayout(15, cs), /short/);
  assert.throws(() => chunkLayout(cs + TAG_BYTES + 15, cs), /impossible/);
  assert.throws(() => chunkLayout(100, 0), /chunkSize/);
});

test('keyId is SHA-256 of SPKI, first 16 bytes', async () => {
  const { publicKey } = await pairPromise;
  const spki = await exportSpki(publicKey);
  const id = await keyIdFromSpki(spki);
  assert.match(id, /^[0-9a-f]{32}$/);
  const { createHash } = await import('node:crypto');
  assert.equal(id, createHash('sha256').update(spki).digest('hex').slice(0, 32));
});

test('WebCrypto seal and open round trip, including edge sizes', async () => {
  const { publicKey, privateKey } = await pairPromise;
  const cs = 64;
  for (const p of [0, 1, cs, 2 * cs + 5, 1000]) {
    const plain = crypto.getRandomValues(new Uint8Array(p));
    const file = await sealVaultFile(plain, publicKey, meta, cs);
    const header = decodeHeader(file);
    assert.equal(file.length, header.headerLength + cipherBodyLength(p, cs));
    const opened = await openVaultFile(file, privateKey);
    assert.deepEqual(opened.plain, plain);
    assert.deepEqual(opened.header.meta, meta);
  }
});

test('opening fails on tampering, truncation or reordering', async () => {
  const { publicKey, privateKey } = await pairPromise;
  const cs = 32;
  const plain = crypto.getRandomValues(new Uint8Array(3 * cs));
  const file = await sealVaultFile(plain, publicKey, meta, cs);
  const headerLength = readHeaderLength(file);
  const flipped = new Uint8Array(file);
  flipped[headerLength + 3] ^= 1;
  await assert.rejects(openVaultFile(flipped, privateKey));
  // Drop the final (empty) chunk: layout still valid, but the new last chunk was not sealed as last.
  await assert.rejects(openVaultFile(file.subarray(0, file.length - TAG_BYTES), privateKey));
  // Swap the first two chunks.
  const full = cs + TAG_BYTES;
  const swapped = new Uint8Array(file);
  swapped.set(file.subarray(headerLength + full, headerLength + 2 * full), headerLength);
  swapped.set(file.subarray(headerLength, headerLength + full), headerLength + full);
  await assert.rejects(openVaultFile(swapped, privateKey));
  // Change the meta inside the header (AAD covers the header).
  const metaEdited = new Uint8Array(file);
  const at = Buffer.from(file.subarray(0, headerLength)).indexOf('"cameraId":7');
  metaEdited[at + 11] = '8'.charCodeAt(0);
  assert.equal(decodeHeader(metaEdited).meta.cameraId, 8);
  await assert.rejects(openVaultFile(metaEdited, privateKey));
});

test('a file written with node:crypto (as the hub does) opens with WebCrypto', async () => {
  const { publicKey, privateKey } = await pairPromise;
  const spki = await exportSpki(publicKey);
  const keyId = await keyIdFromSpki(spki);
  const cs = CHUNK_SIZE;
  const plain = randomBytes(2 * cs + 5);
  const aesKey = randomBytes(32);
  const wrappedKey = publicEncrypt(
    { key: createPublicKey({ key: Buffer.from(spki), format: 'der', type: 'spki' }), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    aesKey,
  );
  const noncePrefix = randomBytes(8);
  const headerBytes = encodeHeader({ keyId, wrappedKey, noncePrefix, chunkSize: cs, meta });
  const parts: Uint8Array[] = [headerBytes];
  const count = chunkCount(plain.length, cs);
  for (let i = 0; i < count; i++) {
    const c = createCipheriv('aes-256-gcm', aesKey, chunkNonce(noncePrefix, i));
    c.setAAD(chunkAad(headerBytes, i, i === count - 1));
    parts.push(c.update(plain.subarray(i * cs, (i + 1) * cs)), c.final(), c.getAuthTag());
  }
  const file = concatBytes(parts);
  assert.equal(chunkLayout(file.length - headerBytes.length, cs).count, 3);
  const opened = await openVaultFile(file, privateKey);
  assert.equal(Buffer.compare(Buffer.from(opened.plain), plain), 0);
});

test('recovery file round trip, wrong passphrase and key mismatch', async () => {
  const { publicKey, privateKey } = await pairPromise;
  const keyId = await keyIdFromSpki(await exportSpki(publicKey));
  const file = await createRecoveryFile(privateKey, keyId, 'correct horse battery staple');
  const parsed = JSON.parse(JSON.stringify(file));
  assert.equal(parsed.format, 'comffee-cctv-recovery');
  assert.equal(parsed.kdf.iterations, 600000);
  const opened = await openRecoveryFile(parsed, 'correct horse battery staple');
  assert.equal(opened.keyId, keyId);
  assert.equal(opened.privateKey.extractable, false);
  const sealed = await sealVaultFile(new Uint8Array([1, 2, 3]), publicKey, meta, 16);
  assert.deepEqual([...(await openVaultFile(sealed, opened.privateKey)).plain], [1, 2, 3]);
  await assert.rejects(openRecoveryFile(parsed, 'wrong passphrase here'), /Wrong passphrase/);
  await assert.rejects(openRecoveryFile({ ...parsed, keyId: '0'.repeat(32) }, 'correct horse battery staple'), /does not match/);
  await assert.rejects(openRecoveryFile({ ...parsed, format: 'other' }, 'x'), /Not a Comffee CCTV recovery file/);
  await assert.rejects(createRecoveryFile(privateKey, keyId, 'short'), /too short/);
});
