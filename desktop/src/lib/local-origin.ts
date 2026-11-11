/**
 * Where the local screens live, and the checks that a URL or frame belongs to them.
 *
 * Node's URL parser (the one the main process uses) treats app: as a non-special scheme and gives it
 * the opaque origin "null", even though Chromium registers it as standard. So never compare
 * `new URL(x).origin` with LOCAL_ORIGIN: it is never equal, and every check would fail.
 */

export const LOCAL_ORIGIN = 'app://local';

/** True for app://local/... and nothing else (no other host, port or user part). */
export function isLocalUrl(target: string): boolean {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  return url.protocol === 'app:' && url.host === 'local' && url.username === '' && url.password === '';
}

/** A frame is local when Chromium's own origin for it and its URL both say app://local. */
export function isLocalFrame(frame: { origin: string; url: string }): boolean {
  return frame.origin === LOCAL_ORIGIN && isLocalUrl(frame.url);
}
