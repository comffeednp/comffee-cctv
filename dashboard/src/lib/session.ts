// Who is signed in (GET /api/me) and whether the hub still needs its first setup (GET /api/setup/status).
// Both are small shared stores: every component that uses them re-renders when they change.

import { useEffect, useState } from 'preact/hooks';
import type { Me, SetupStatus } from '../../../shared/api-types.ts';
import { ApiFailure, SIGNED_OUT_EVENT, apiGet, apiSend } from './api.ts';
import { navigate } from './router.ts';

type Listener = () => void;

interface Store<T> {
  value: T;
  /** True once the first answer (or failure) came back. */
  loaded: boolean;
  error: unknown;
  inflight: Promise<unknown> | null;
  listeners: Set<Listener>;
}

function createStore<T>(value: T): Store<T> {
  return { value, loaded: false, error: null, inflight: null, listeners: new Set() };
}

function emit<T>(store: Store<T>): void {
  for (const listener of [...store.listeners]) listener();
}

function useStore<T>(store: Store<T>, load: () => Promise<unknown>): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((n) => n + 1);
    store.listeners.add(listener);
    if (!store.loaded && !store.inflight) void load();
    return () => {
      store.listeners.delete(listener);
    };
  }, []);
}

/* ------------------------------------------------------------------ me */

const meStore = createStore<Me | null>(null);

/** Asks the hub who is signed in. Resolves null when nobody is. Concurrent calls share one request. */
export function refreshMe(): Promise<Me | null> {
  if (meStore.inflight) return meStore.inflight as Promise<Me | null>;
  const run = (async () => {
    try {
      const me = await apiGet<Me>('/api/me');
      meStore.value = me;
      meStore.error = null;
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 401) {
        meStore.value = null;
        meStore.error = null;
      } else {
        // The hub did not answer: keep what we knew and let the screen offer a retry.
        meStore.error = err;
      }
    } finally {
      meStore.loaded = true;
      meStore.inflight = null;
      emit(meStore);
    }
    return meStore.value;
  })();
  meStore.inflight = run;
  return run;
}

/** Stores the signed-in person (after sign-in) or clears it (after sign-out). */
export function setMe(me: Me | null): void {
  meStore.value = me;
  meStore.loaded = true;
  meStore.error = null;
  emit(meStore);
}

/**
 * The signed-in person. `loading` is true only until the first answer, so a background refresh never
 * blanks the screen.
 */
export function useMe(): { me: Me | null; loading: boolean; error: unknown } {
  useStore(meStore, refreshMe);
  return { me: meStore.value, loading: !meStore.loaded, error: meStore.error };
}

export function isOwner(me: Me | null | undefined): boolean {
  return me?.role === 'owner';
}

/** True when the person may see this location (the owner sees every location). */
export function canSeeLocation(me: Me | null | undefined, locationId: number): boolean {
  if (!me) return false;
  return me.locationIds === 'all' || me.locationIds.includes(locationId);
}

/** Signs out on the hub (best effort), forgets the person and goes to the sign-in page. */
export async function signOut(): Promise<void> {
  try {
    await apiSend('POST', '/api/auth/logout');
  } catch {
    // Already signed out or the hub is unreachable: forget the session here anyway.
  }
  setMe(null);
  navigate('/login', { replace: true });
}

if (typeof window !== 'undefined') {
  window.addEventListener(SIGNED_OUT_EVENT, () => {
    if (meStore.value !== null) setMe(null);
  });
}

/* --------------------------------------------------------------- setup */

const setupStore = createStore<SetupStatus | null>(null);

/** Asks the hub whether it still needs its owner account and recording key. */
export function refreshSetupStatus(): Promise<SetupStatus | null> {
  if (setupStore.inflight) return setupStore.inflight as Promise<SetupStatus | null>;
  const run = (async () => {
    try {
      setupStore.value = await apiGet<SetupStatus>('/api/setup/status');
      setupStore.error = null;
    } catch (err) {
      setupStore.error = err;
    } finally {
      setupStore.loaded = true;
      setupStore.inflight = null;
      emit(setupStore);
    }
    return setupStore.value;
  })();
  setupStore.inflight = run;
  return run;
}

export function useSetupStatus(): { status: SetupStatus | null; loading: boolean; error: unknown } {
  useStore(setupStore, refreshSetupStatus);
  return { status: setupStore.value, loading: !setupStore.loaded, error: setupStore.error };
}
