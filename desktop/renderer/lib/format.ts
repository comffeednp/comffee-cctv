// Small display helpers for the local screens.
import type { AccountView, ServerView } from '../../src/lib/ipc-types.ts';
import { regionLabel } from '../../src/lib/oci-regions.ts';

export function timeOfDay(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function minutes(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return m === 1 ? '1 min' : `${m} min`;
}

export function hostOf(server: ServerView): string {
  try {
    return new URL(server.url).host;
  } catch {
    return server.url;
  }
}

/** One short line about an account's sign-in. */
export function accountStatus(account: AccountView): string {
  if (account.kind === 'api-key') return 'API key';
  if (!account.usable) return 'Signed out. Sign in again to use it';
  return account.sessionExpiresAt ? `Signed in until ${timeOfDay(account.sessionExpiresAt)}` : 'Signed in';
}

export function accountRegion(account: AccountView): string {
  return regionLabel(account.homeRegion);
}
