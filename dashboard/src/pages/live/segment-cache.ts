// Opened (decrypted) recording segments for the player. At most `max` are kept; the least recently used one is
// dropped and its object URL released as soon as a new one arrives. Loads that are no longer wanted are stopped.

import type { RecordingItem } from '../../../../shared/api-types.ts';
import { apiRaw } from '../../lib/api.ts';
import { getPrivateKey } from '../../lib/crypto/keystore.ts';
import { decryptRecording } from '../../lib/crypto/vault-decrypt.ts';

export interface OpenedSegment {
  item: RecordingItem;
  blob: Blob;
  /** Object URL of the plain video; valid until the segment is dropped from the cache. */
  url: string;
}

/** The private key this segment is locked with is not on this device. */
export class MissingKeyError extends Error {
  readonly keyId: string;

  constructor(keyId: string) {
    super('The recovery key for this recording is not on this device.');
    this.name = 'MissingKeyError';
    this.keyId = keyId;
  }
}

interface Loading {
  promise: Promise<OpenedSegment>;
  controller: AbortController;
  listeners: Set<(percent: number | null) => void>;
}

export class SegmentCache {
  private readonly max: number;
  private readonly ready = new Map<number, OpenedSegment>();
  private readonly loading = new Map<number, Loading>();
  private closed = false;
  /** The segment on screen; never dropped while it plays. */
  private playing: number | null = null;

  constructor(max = 3) {
    this.max = Math.max(1, max);
  }

  /** The opened segment, when it is ready (and marks it as just used). */
  get(id: number): OpenedSegment | undefined {
    const found = this.ready.get(id);
    if (found) {
      this.ready.delete(id);
      this.ready.set(id, found);
    }
    return found;
  }

  /** Marks the segment on screen, which is never dropped to make room. */
  setPlaying(id: number | null): void {
    this.playing = id;
    if (id !== null) this.get(id);
  }

  isLoading(id: number): boolean {
    return this.loading.has(id);
  }

  /**
   * Opens a segment (or joins the load already running). `onProgress` gets the download percent, null while
   * the size is unknown. Rejects with MissingKeyError, VaultDecryptError, ApiFailure or an AbortError.
   */
  open(item: RecordingItem, onProgress?: (percent: number | null) => void): Promise<OpenedSegment> {
    const done = this.get(item.id);
    if (done) return Promise.resolve(done);
    const running = this.loading.get(item.id);
    if (running) {
      if (onProgress) running.listeners.add(onProgress);
      return running.promise;
    }
    const controller = new AbortController();
    const listeners = new Set<(percent: number | null) => void>();
    if (onProgress) listeners.add(onProgress);
    const promise = this.load(item, controller.signal, listeners).finally(() => {
      if (this.loading.get(item.id)?.controller === controller) this.loading.delete(item.id);
    });
    this.loading.set(item.id, { promise, controller, listeners });
    return promise;
  }

  /** Stops every load whose segment is not in `wanted`. */
  keepLoading(wanted: readonly number[]): void {
    for (const [id, entry] of this.loading) {
      if (!wanted.includes(id)) {
        entry.controller.abort();
        this.loading.delete(id);
      }
    }
  }

  /** Releases everything; later loads are refused. */
  clear(): void {
    this.closed = true;
    for (const entry of this.loading.values()) entry.controller.abort();
    this.loading.clear();
    for (const segment of this.ready.values()) URL.revokeObjectURL(segment.url);
    this.ready.clear();
  }

  private async load(item: RecordingItem, signal: AbortSignal, listeners: Set<(percent: number | null) => void>): Promise<OpenedSegment> {
    const key = await getPrivateKey(item.keyId);
    if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
    if (!key) throw new MissingKeyError(item.keyId);
    const res = await apiRaw(`/api/recordings/${item.id}/file`, { signal });
    let shown: number | null | undefined;
    const blob = await decryptRecording(res, key, {
      signal,
      expectedKeyId: item.keyId,
      onProgress: (read, total) => {
        const percent = total ? Math.min(99, Math.floor((read / total) * 100)) : null;
        if (percent === shown) return;
        shown = percent;
        for (const listener of listeners) listener(percent);
      },
    });
    if (signal.aborted || this.closed) throw new DOMException('Stopped', 'AbortError');
    const segment: OpenedSegment = { item, blob, url: URL.createObjectURL(blob) };
    this.ready.set(item.id, segment);
    this.trim(item.id);
    return segment;
  }

  /** Drops the least recently used segments beyond `max`, never `keepId` or the one playing. */
  private trim(keepId: number): void {
    for (const [id, segment] of this.ready) {
      if (this.ready.size <= this.max) break;
      if (id === keepId || id === this.playing) continue;
      this.ready.delete(id);
      URL.revokeObjectURL(segment.url);
    }
  }
}
