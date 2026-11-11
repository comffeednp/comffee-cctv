// The local screens' only way out: window.cctv from the preload.
import { useEffect, useState } from 'preact/hooks';
import type { AppStateView, CctvApi, EventChannel, EventPayloads, Result } from '../../src/lib/ipc-types.ts';

declare global {
  interface Window {
    cctv: CctvApi;
  }
}

export const cctv: CctvApi = window.cctv;

/** A failed call: the message is already a sentence for the screen. */
export class CallError extends Error {
  readonly needsSignIn: boolean;
  readonly cancelled: boolean;
  constructor(message: string, needsSignIn: boolean, cancelled = false) {
    super(message);
    this.name = 'CallError';
    this.needsSignIn = needsSignIn;
    this.cancelled = cancelled;
  }
}

/** Unwraps a Result, throwing CallError on failure. */
export async function call<T>(promise: Promise<Result<T>>): Promise<T> {
  let result: Result<T>;
  try {
    result = await promise;
  } catch {
    throw new CallError('That did not go through. Try again.', false);
  }
  if (result.ok) return result.value;
  throw new CallError(result.error, result.needsSignIn ?? false, result.cancelled ?? false);
}

export function isCancelled(err: unknown): boolean {
  return err instanceof CallError && err.cancelled;
}

export function errorText(err: unknown): string {
  return err instanceof CallError ? err.message : 'That did not go through. Try again.';
}

export function useEvent<C extends EventChannel>(channel: C, listener: (payload: EventPayloads[C]) => void, deps: unknown[] = []): void {
  useEffect(() => cctv.on(channel, listener), deps);
}

let cachedState: AppStateView | null = null;
const stateListeners = new Set<(state: AppStateView) => void>();

function publish(state: AppStateView): void {
  cachedState = state;
  for (const listener of stateListeners) listener(state);
}

cctv.on('state', publish);

export async function refreshState(): Promise<AppStateView> {
  const state = await call(cctv.getState());
  publish(state);
  return state;
}

/** The app's accounts, servers and settings; null until the first answer. */
export function useAppState(): AppStateView | null {
  const [state, setState] = useState<AppStateView | null>(cachedState);
  useEffect(() => {
    stateListeners.add(setState);
    if (!cachedState) void refreshState().catch(() => undefined);
    else setState(cachedState);
    return () => {
      stateListeners.delete(setState);
    };
  }, []);
  return state;
}
