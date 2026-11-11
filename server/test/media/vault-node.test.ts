import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CHUNK_SIZE,
  TAG_BYTES,
  bytesToBase64,
  cipherBodyLength,
  decodeHeader,
  exportSpki,
  generateVaultKeyPair,
  keyIdFromSpki,
  openVaultFile,
} from '../../../shared/vault-format.ts';
import type { VaultMeta } from '../../../shared/vault-format.ts';
import { encryptFileToVault, loadVaultPublicKey } from '../../src/crypto/vault-node.ts';

const meta: VaultMeta = {
  v: 1,
  cameraId: 12,
  locationId: 4,
  start: '2026-03-01T08:15:00.000Z',
  durationMs: 300000,
  mime: 'video/mp4',
};

const pairPromise = generateVaultKeyPair();
const dir = mkdtempSync(path.join(tmpdir(), 'ccv-vault-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

function pattern(length: number, seed = 7): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

async function sealWithNode(plain: Uint8Array, chunkSize?: number): Promise<{ file: Uint8Array; size: number }> {
  const { publicKey } = await pairPromise;
  const spki = await exportSpki(publicKey);
  const pub = loadVaultPublicKey(bytesToBase64(spki));
  const src = path.join(dir, `plain-${plain.length}-${chunkSize ?? CHUNK_SIZE}.mp4`);
  const dest = path.join(dir, 'out', `${plain.length}-${chunkSize ?? CHUNK_SIZE}.ccv`);
  writeFileSync(src, plain);
  const { sizeBytes, plainBytes } = await encryptFileToVault(src, dest, pub, meta, chunkSize);
  assert.equal(plainBytes, plain.length);
  assert.equal(existsSync(`${dest}.part`), false, 'temporary file is renamed away');
  assert.equal(statSync(dest).size, sizeBytes);
  return { file: new Uint8Array(readFileSync(dest)), size: sizeBytes };
}

test('keyId from Node matches the shared WebCrypto keyId', async () => {
  const { publicKey } = await pairPromise;
  const spki = await exportSpki(publicKey);
  assert.equal(loadVaultPublicKey(bytesToBase64(spki)).keyId, await keyIdFromSpki(spki));
});

test('Node-encrypted files open with WebCrypto, as a browser would', async () => {
  const { privateKey } = await pairPromise;
  const cases: [number, number][] = [
    [0, 1024],
    [1, 1024],
    [1023, 1024],
    [1024, 1024], // exact multiple: an empty last chunk
    [5000, 1024],
    [CHUNK_SIZE * 2 + 12345, CHUNK_SIZE],
  ];
  for (const [length, chunkSize] of cases) {
    const plain = pattern(length, length + 1);
    const { file, size } = await sealWithNode(plain, chunkSize);
    const header = decodeHeader(file);
    assert.equal(size, header.headerLength + cipherBodyLength(length, chunkSize));
    assert.equal(header.chunkSize, chunkSize);
    assert.deepEqual(header.meta, meta);
    const opened = await openVaultFile(file, privateKey);
    assert.deepEqual(opened.plain, plain, `round trip of ${length} bytes`);
  }
});

test('a changed byte in any chunk or in the header is rejected', async () => {
  const { privateKey } = await pairPromise;
  const { file } = await sealWithNode(pattern(3000, 3), 1024);
  const header = decodeHeader(file);
  const positions = [
    header.headerLength + 5, // first chunk
    header.headerLength + (1024 + TAG_BYTES) + 100, // second chunk
    file.length - 1, // last tag
    20, // keyId in the header
    header.headerLength - 3, // meta in the header
  ];
  for (const at of positions) {
    const bad = new Uint8Array(file);
    bad[at] = (bad[at] as number) ^ 0x01;
    await assert.rejects(openVaultFile(bad, privateKey), `tampered byte at ${at}`);
  }
});

test('truncated files are rejected, including a cut exactly at a chunk boundary', async () => {
  const { privateKey } = await pairPromise;
  const { file } = await sealWithNode(pattern(4096, 9), 1024);
  const header = decodeHeader(file);
  const full = 1024 + TAG_BYTES;
  // 4096 bytes = 4 full chunks + an empty last chunk (tag only).
  const cuts = [
    file.length - 1,
    file.length - TAG_BYTES, // drop the empty last chunk
    header.headerLength + full * 3, // keep three chunks
    header.headerLength + full * 2 + 500,
    header.headerLength + 3,
    10,
  ];
  for (const cut of cuts) {
    await assert.rejects(openVaultFile(file.subarray(0, cut), privateKey), `cut at ${cut}`);
  }
});

test('two files of the same plaintext differ (fresh key and nonce prefix per file)', async () => {
  const plain = pattern(2000, 5);
  const a = await sealWithNode(plain, 1024);
  const b = await sealWithNode(plain, 1000);
  const ha = decodeHeader(a.file);
  const hb = decodeHeader(b.file);
  assert.notDeepEqual(ha.wrappedKey, hb.wrappedKey);
  assert.notDeepEqual(ha.noncePrefix, hb.noncePrefix);
});
