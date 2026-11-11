/** Errors whose message is written for the person using the app. */

import { NetworkError } from './https-transport.ts';
import { OciError, isCapacityError } from './oci-client.ts';
import { TemplateError } from './cloud-init.ts';

/** A plain-English message that may be shown as is. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

/** The Oracle sign-in ended (session over 24 hours, or Oracle refused the refresh). */
export class SignInNeeded extends UserError {
  constructor(message = 'Your Oracle sign-in ended. Sign in again, then try again.') {
    super(message);
    this.name = 'SignInNeeded';
  }
}

export class Cancelled extends Error {
  constructor() {
    super('Cancelled.');
    this.name = 'Cancelled';
  }
}

export const FALLBACK_MESSAGE = 'That did not go through. Try again.';

/** Turns any error into a sentence for the screen. Raw codes and request details never reach it. */
export function describeError(err: unknown): { message: string; needsSignIn: boolean } {
  if (err instanceof SignInNeeded) return { message: err.message, needsSignIn: true };
  if (err instanceof UserError || err instanceof TemplateError) return { message: err.message, needsSignIn: false };
  if (err instanceof NetworkError) return { message: 'Could not reach Oracle. Check the internet connection and try again.', needsSignIn: false };
  if (err instanceof OciError) {
    if (err.status === 401) return { message: 'Oracle did not accept the sign-in. Sign in again.', needsSignIn: true };
    if (isCapacityError(err)) return { message: 'Oracle has no free servers left in this region right now. Try again later.', needsSignIn: false };
    if (err.code === 'LimitExceeded' || err.code === 'QuotaExceeded') {
      return { message: 'Oracle says this account has no free room left for this. Check for other servers in Oracle Cloud.', needsSignIn: false };
    }
    if (err.status === 404 && err.code === 'NotAuthorizedOrNotFound') {
      return { message: 'Oracle refused this. Use the Oracle user that made the account (the administrator).', needsSignIn: false };
    }
    if (err.status === 429) return { message: 'Oracle is busy. Wait a minute and try again.', needsSignIn: false };
    if (err.status >= 500) return { message: 'Oracle had a problem. Wait a minute and try again.', needsSignIn: false };
  }
  return { message: FALLBACK_MESSAGE, needsSignIn: false };
}
