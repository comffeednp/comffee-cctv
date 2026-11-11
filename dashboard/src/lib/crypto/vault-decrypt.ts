// Streams a CCV1 recording file (contract section 10) through WebCrypto, one chunk at a time, and returns
// the plain MP4. Every chunk's tag is checked, only the final chunk is opened with the last-chunk flag, and
// the byte count must match the response length, so a cut, reordered or altered file always fails.

import {
  AES_KEY_BYTES,
  HEADER_PREFIX_BYTES,
  NONCE_PREFIX_BYTES,
  TAG_BYTES,
  chunkAad,
  chunkNonce,
  decodeHeader,
  readHeaderLength,
} from '../../../../shared/vault-format.ts';
import type { DecodedHeader } from '../../../../shared/vault-format.ts';

export type VaultDecryptReason = 'format' | 'wrong-key' | 'damaged' | 'truncated' | 'aborted';

/** Any failure while opening a recording. The message can be shown as is. */
export class VaultDecryptError extends Error {
  readonly reason: VaultDecryptReason;

  constructor(reason: VaultDecryptReason, message: string) {
    super(message);
    this.name = 'VaultDecryptError';
    this.reason = reason;
  }
}

export interface DecryptOptions {
  /** Stops reading and decrypting; the promise rejects with reason 'aborted'. */
  signal?: AbortSignal;
  /** The keyId the file must name (RecordingItem.keyId); a different one fails before any decryption. */
  expectedKeyId?: string;
  /** Called after each chunk with the encrypted bytes read so far and the total (null when unknown). */
  onProgress?: (readBytes: number, totalBytes: number | null) => void;
  /** Receives the decoded header once it has been read and checked. */
  onHeader?: (header: DecodedHeader) => void;
}

const MESSAGES: Record<VaultDecryptReason, string> = {
  format: 'This file is not a Comffee CCTV recording.',
  'wrong-key': 'This recording was locked with a different recovery key.',
  damaged: 'This recording is damaged or was changed, so it cannot be played.',
  truncated: 'This recording did not download completely. Try again.',
  aborted: 'Stopped.',
};

function failWith(reason: VaultDecryptReason): never {
  throw new VaultDecryptError(reason, MESSAGES[reason]);
}

/** A queue of received byte pieces that hands out exact-sized slices without re-copying the whole buffer. */
class ByteQueue {
  private pieces: Uint8Array[] = [];
  private head = 0;
  length = 0;

  push(piece: Uint8Array): void {
    if (piece.length === 0) return;
    this.pieces.push(piece);
    this.length += piece.length;
  }

  /** Removes and returns exactly `n` bytes (n <= length) in a fresh buffer. */
  take(n: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const piece = this.pieces[0];
      const available = piece.length - this.head;
      const want = Math.min(available, n - filled);
      out.set(piece.subarray(this.head, this.head + want), filled);
      filled += want;
      this.head += want;
      if (this.head === piece.length) {
        this.pieces.shift();
        this.head = 0;
      }
    }
    this.length -= n;
    return out;
  }

  /** Copies the first `n` bytes without removing them. */
  peek(n: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(n);
    let filled = 0;
    let index = 0;
    let offset = this.head;
    while (filled < n) {
      const piece = this.pieces[index];
      const want = Math.min(piece.length - offset, n - filled);
      out.set(piece.subarray(offset, offset + want), filled);
      filled += want;
      index += 1;
      offset = 0;
    }
    return out;
  }
}

function declaredLength(res: Response): number | null {
  // A compressed transfer reports the compressed size, which says nothing about the bytes we read.
  const encoding = res.headers.get('Content-Encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') return null;
  const raw = res.headers.get('Content-Length');
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

async function unwrapKey(header: DecodedHeader, privateKey: CryptoKey): Promise<CryptoKey> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, new Uint8Array(header.wrappedKey)));
  } catch {
    failWith('wrong-key');
  }
  if (raw.length !== AES_KEY_BYTES) {
    raw.fill(0);
    failWith('damaged');
  }
  try {
    return await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
  } finally {
    raw.fill(0);
  }
}

/**
 * Decrypts a CCV1 response (from GET /api/recordings/:id/file) with the owner's private key and returns the
 * plain video as a Blob (type from the header, video/mp4). Throws VaultDecryptError on any problem; nothing
 * partial is ever returned.
 */
export async function decryptRecording(res: Response, privateKey: CryptoKey, options: DecryptOptions = {}): Promise<Blob> {
  const { signal, expectedKeyId, onProgress, onHeader } = options;
  if (!res.ok || !res.body) failWith('truncated');
  if (signal?.aborted) failWith('aborted');

  const total = declaredLength(res);
  const reader = res.body.getReader();
  const onAbort = () => {
    reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort);

  const queue = new ByteQueue();
  const plainParts: Uint8Array<ArrayBuffer>[] = [];
  let readBytes = 0;
  let done = false;
  let header: DecodedHeader | null = null;
  let headerLength = 0;
  let aesKey: CryptoKey | null = null;
  let chunkIndex = 0;
  let fullCipher = 0;

  const pull = async (): Promise<void> => {
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await reader.read();
    } catch {
      if (signal?.aborted) failWith('aborted');
      failWith('truncated');
    }
    if (signal?.aborted) failWith('aborted');
    if (result.done) {
      done = true;
      return;
    }
    readBytes += result.value.length;
    if (total !== null && readBytes > total) failWith('damaged');
    queue.push(result.value);
    onProgress?.(readBytes, total);
  };

  const openChunk = async (cipher: Uint8Array<ArrayBuffer>, isLast: boolean): Promise<void> => {
    if (!header || !aesKey) failWith('format');
    if (chunkIndex > 0xffffffff) failWith('damaged');
    let clear: ArrayBuffer;
    try {
      clear = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: chunkNonce(header.noncePrefix, chunkIndex),
          additionalData: chunkAad(header.headerBytes, chunkIndex, isLast),
          tagLength: TAG_BYTES * 8,
        },
        aesKey,
        cipher,
      );
    } catch {
      failWith('damaged');
    }
    if (signal?.aborted) failWith('aborted');
    plainParts.push(new Uint8Array(clear));
    chunkIndex += 1;
  };

  try {
    // 1. Header: learn its length from the first 8 bytes, then read and check all of it.
    while (!done && queue.length < HEADER_PREFIX_BYTES) await pull();
    if (queue.length < HEADER_PREFIX_BYTES) failWith(readBytes === 0 ? 'truncated' : 'format');
    try {
      headerLength = readHeaderLength(queue.peek(HEADER_PREFIX_BYTES));
    } catch {
      failWith('format');
    }
    while (!done && queue.length < headerLength) await pull();
    if (queue.length < headerLength) failWith('truncated');
    try {
      header = decodeHeader(queue.take(headerLength));
    } catch {
      failWith('format');
    }
    if (header.noncePrefix.length !== NONCE_PREFIX_BYTES) failWith('format');
    if (expectedKeyId && header.keyId !== expectedKeyId.toLowerCase()) failWith('wrong-key');
    if (total !== null && total - headerLength < TAG_BYTES) failWith('truncated');
    onHeader?.(header);
    aesKey = await unwrapKey(header, privateKey);
    fullCipher = header.chunkSize + TAG_BYTES;

    // 2. Body. A full-size chunk is never the last one (the last holds fewer than chunkSize plain bytes), so
    //    any chunk with more bytes after it is opened as "not last"; whatever is left at the end is the last.
    for (;;) {
      while (!done && queue.length <= fullCipher) await pull();
      if (queue.length > fullCipher) {
        await openChunk(queue.take(fullCipher), false);
        continue;
      }
      if (!done) continue;
      // End of stream: every announced byte must have arrived, and the remainder is the last chunk, which holds
      // at least its tag and is shorter than a full chunk.
      if (total !== null && readBytes !== total) failWith('truncated');
      if (queue.length < TAG_BYTES || queue.length === fullCipher) failWith('truncated');
      await openChunk(queue.take(queue.length), true);
      break;
    }
    return new Blob(plainParts, { type: header.meta.mime });
  } catch (err) {
    reader.cancel().catch(() => undefined);
    if (err instanceof VaultDecryptError) throw err;
    const reason: VaultDecryptReason = signal?.aborted ? 'aborted' : 'damaged';
    throw new VaultDecryptError(reason, MESSAGES[reason]);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
