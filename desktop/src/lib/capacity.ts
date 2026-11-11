/**
 * The "out of capacity" retry loop for launching a free Ampere server, as a pure state machine.
 *
 * - One try = one launch request in one availability domain.
 * - A capacity error moves to the next availability domain at once; after the last one, wait 60 s.
 * - After `fallbackAfterRounds` full rounds of capacity errors at 4 cores / 24 GB, drop to 2 / 12
 *   (only when that is allowed) and start counting again.
 * - Throttling and network errors wait 60 s and retry the same domain; they do not count toward the fallback.
 * - A fatal error, success or cancel ends it.
 */

export const RETRY_DELAY_MS = 60_000;
export const FALLBACK_AFTER_ROUNDS = 3;

export type ServerSize = 'full' | 'half';

export const SIZES: Record<ServerSize, { ocpus: number; memoryInGBs: number }> = {
  full: { ocpus: 4, memoryInGBs: 24 },
  half: { ocpus: 2, memoryInGBs: 12 },
};

export type CapacityStatus = 'trying' | 'waiting' | 'done' | 'failed' | 'cancelled';

export interface CapacityState {
  status: CapacityStatus;
  /** Number of the current or last try, from 1. */
  tries: number;
  size: ServerSize;
  /** Index into the availability domain list. */
  adIndex: number;
  /** Capacity errors at the current size. */
  capacityErrors: number;
  /** Why it is waiting, or why it failed. */
  reason: 'capacity' | 'busy' | null;
  error: string | null;
}

export interface CapacityOptions {
  adCount: number;
  /** False when only one size fits the free allowance. */
  canFallBack: boolean;
  fallbackAfterRounds?: number;
}

export type CapacityEvent =
  | { type: 'capacity' }
  | { type: 'busy' }
  | { type: 'success' }
  | { type: 'fatal'; message: string }
  | { type: 'cancel' }
  | { type: 'retry' };

export function initialCapacityState(size: ServerSize = 'full'): CapacityState {
  return { status: 'trying', tries: 1, size, adIndex: 0, capacityErrors: 0, reason: null, error: null };
}

export function isFinished(state: CapacityState): boolean {
  return state.status === 'done' || state.status === 'failed' || state.status === 'cancelled';
}

export function nextCapacityState(state: CapacityState, event: CapacityEvent, options: CapacityOptions): CapacityState {
  if (isFinished(state)) return state;
  const adCount = Math.max(1, options.adCount);
  const rounds = options.fallbackAfterRounds ?? FALLBACK_AFTER_ROUNDS;
  switch (event.type) {
    case 'cancel':
      return { ...state, status: 'cancelled' };
    case 'success':
      return state.status === 'trying' ? { ...state, status: 'done', reason: null } : state;
    case 'fatal':
      return { ...state, status: 'failed', error: event.message };
    case 'capacity': {
      if (state.status !== 'trying') return state;
      let size = state.size;
      let capacityErrors = state.capacityErrors + 1;
      if (size === 'full' && options.canFallBack && capacityErrors >= rounds * adCount) {
        size = 'half';
        capacityErrors = 0;
      }
      const adIndex = (state.adIndex + 1) % adCount;
      // Another domain left in this round: try it now. Otherwise wait before the next round.
      if (adIndex !== 0) return { ...state, status: 'trying', tries: state.tries + 1, size, adIndex, capacityErrors, reason: 'capacity' };
      return { ...state, status: 'waiting', size, adIndex, capacityErrors, reason: 'capacity' };
    }
    case 'busy':
      if (state.status !== 'trying') return state;
      return { ...state, status: 'waiting', reason: 'busy' };
    case 'retry':
      if (state.status !== 'waiting') return state;
      return { ...state, status: 'trying', tries: state.tries + 1 };
  }
}

/** The line shown while it keeps trying. */
export function capacityMessage(state: CapacityState): string | null {
  if (state.reason === null || isFinished(state)) return null;
  return `Oracle is busy, still trying (try ${state.tries})`;
}
