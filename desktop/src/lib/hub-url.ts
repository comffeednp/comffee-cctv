/** Server addresses: the free sslip.io name for a new server, and links people paste. */

export function isPublicIpv4(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  return true;
}

/** https://203-0-113-10.sslip.io, the name the installer uses when there is no domain. */
export function hubUrlFromIp(ip: string): string {
  if (!isPublicIpv4(ip)) throw new Error('Not a public IPv4 address.');
  return `https://${ip.replace(/\./g, '-')}.sslip.io`;
}

export type LinkResult = { ok: true; origin: string } | { ok: false; error: string };

/**
 * A server link someone pasted, reduced to its https origin. "cctv.example.com" gets https:// in front.
 * Plain http, user names, passwords and non-standard schemes are refused.
 */
export function normaliseServerLink(input: string): LinkResult {
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text) return { ok: false, error: 'Paste the link of your server.' };
  if (text.length > 300) return { ok: false, error: 'That link is too long.' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, error: 'That does not look like a link. It starts with https://' };
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'Use the https:// link of your server.' };
  if (url.username || url.password) return { ok: false, error: 'Leave the user name and password out of the link.' };
  if (!url.hostname || !/^[a-z0-9.-]+$/i.test(url.hostname) || !url.hostname.includes('.')) {
    return { ok: false, error: 'That does not look like a server link.' };
  }
  return { ok: true, origin: url.origin };
}

/** True when `url` is on exactly this origin. */
export function isSameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

export function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}
