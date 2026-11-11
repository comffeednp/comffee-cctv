/**
 * Minimal ONVIF client: unauthenticated GetSystemDateAndTime (detection) and GetDeviceInformation with a
 * WS-Security UsernameToken PasswordDigest (manufacturer and model when a camera is added).
 * Plain node:http, SOAP 1.2, small capped responses. Also used by the bridge program.
 */

import { request } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

const DEVICE_WSDL = 'http://www.onvif.org/ver10/device/wsdl';
const WSSE_NS = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
const WSU_NS = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd';
const PASSWORD_DIGEST =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest';
const BASE64_BINARY =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary';

export const ONVIF_DEVICE_PATH = '/onvif/device_service';
const MAX_RESPONSE_BYTES = 256 * 1024;

export interface SoapTarget {
  /** Address the hub or bridge connects to (may be a relay or a mapped address). */
  host: string;
  port: number;
  /** Host header value, normally the camera's real "ip:port". */
  hostHeader: string;
}

export interface SoapResponse {
  status: number;
  body: string;
}

/** WS-Security PasswordDigest = Base64(SHA-1(nonce bytes + created + password)). */
export function wsseDigest(nonce: Uint8Array, created: string, password: string): string {
  return createHash('sha1')
    .update(nonce)
    .update(Buffer.from(created, 'utf8'))
    .update(Buffer.from(password, 'utf8'))
    .digest('base64');
}

export function xmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlUnescape(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d{1,6});/g, (_, d: string) => safeCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (_, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function safeCodePoint(n: number): string {
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

/** UTC time without milliseconds, as cameras expect in <Created>. */
export function wsseCreated(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function envelope(header: string, body: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">' +
    header +
    `<s:Body>${body}</s:Body></s:Envelope>`
  );
}

export function getSystemDateAndTimeRequest(): string {
  return envelope('', `<GetSystemDateAndTime xmlns="${DEVICE_WSDL}"/>`);
}

/** GetDeviceInformation with a UsernameToken PasswordDigest header. */
export function getDeviceInformationRequest(
  username: string,
  password: string,
  created: Date,
  nonce: Uint8Array = randomBytes(16),
): string {
  const createdText = wsseCreated(created);
  const digest = wsseDigest(nonce, createdText, password);
  const header =
    '<s:Header>' +
    `<Security s:mustUnderstand="1" xmlns="${WSSE_NS}">` +
    '<UsernameToken>' +
    `<Username>${xmlEscape(username)}</Username>` +
    `<Password Type="${PASSWORD_DIGEST}">${digest}</Password>` +
    `<Nonce EncodingType="${BASE64_BINARY}">${Buffer.from(nonce).toString('base64')}</Nonce>` +
    `<Created xmlns="${WSU_NS}">${createdText}</Created>` +
    '</UsernameToken></Security></s:Header>';
  return envelope(header, `<GetDeviceInformation xmlns="${DEVICE_WSDL}"/>`);
}

/** Text of the first element with this local name (any namespace prefix), unescaped and trimmed. */
export function xmlElementText(xml: string, localName: string): string | null {
  const re = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${localName}(?:\\s[^>]*)?>([^<]*)</(?:[A-Za-z0-9_.-]+:)?${localName}>`);
  const m = re.exec(xml);
  if (!m) return null;
  return xmlUnescape(m[1]).trim();
}

/** Short, printable text for the database; null when empty. */
function cleanField(value: string | null): string | null {
  if (value === null) return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100);
  return clean.length > 0 ? clean : null;
}

export function parseDeviceInformation(xml: string): { manufacturer: string | null; model: string | null } | null {
  if (!/GetDeviceInformationResponse/.test(xml)) return null;
  return {
    manufacturer: cleanField(xmlElementText(xml, 'Manufacturer')),
    model: cleanField(xmlElementText(xml, 'Model')),
  };
}

/** The camera's UTC clock from a GetSystemDateAndTime response; null when absent. */
export function parseUtcDateTime(xml: string): Date | null {
  const start = xml.search(/<(?:[A-Za-z0-9_.-]+:)?UTCDateTime[\s>]/);
  if (start < 0) return null;
  const part = xml.slice(start, start + 2000);
  const num = (name: string): number | null => {
    const t = xmlElementText(part, name);
    return t !== null && /^\d{1,4}$/.test(t) ? Number(t) : null;
  };
  const y = num('Year');
  const mo = num('Month');
  const d = num('Day');
  const h = num('Hour');
  const mi = num('Minute');
  const s = num('Second');
  if (y === null || mo === null || d === null || h === null || mi === null || s === null) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  return Number.isFinite(ms) && y >= 2000 ? new Date(ms) : null;
}

/** One SOAP 1.2 POST to the device service. Rejects on network errors and timeouts. */
export function soapPost(target: SoapTarget, action: string, body: string, timeoutMs: number): Promise<SoapResponse> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(body, 'utf8');
    const req = request(
      {
        host: target.host,
        port: target.port,
        method: 'POST',
        path: ONVIF_DEVICE_PATH,
        headers: {
          Host: target.hostHeader,
          'Content-Type': `application/soap+xml; charset=utf-8; action="${DEVICE_WSDL}/${action}"`,
          'Content-Length': String(payload.length),
          Connection: 'close',
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new Error('Response too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    const timer = setTimeout(() => req.destroy(new Error('Timed out')), timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}

/** Unauthenticated GetSystemDateAndTime. `onvif` is true when a SOAP envelope came back. */
export async function onvifProbe(target: SoapTarget, timeoutMs = 3000): Promise<{ onvif: boolean; utc: Date | null }> {
  try {
    const res = await soapPost(target, 'GetSystemDateAndTime', getSystemDateAndTimeRequest(), timeoutMs);
    const onvif = /<(?:[A-Za-z0-9_.-]+:)?Envelope[\s>]/.test(res.body);
    return { onvif, utc: onvif && res.status === 200 ? parseUtcDateTime(res.body) : null };
  } catch {
    return { onvif: false, utc: null };
  }
}

/**
 * Manufacturer and model with WS-Security digest. The <Created> time follows the camera's own clock when
 * it reports one, so cameras with a wrong clock still accept the digest. Null when ONVIF did not answer.
 */
export async function onvifDeviceInfo(
  target: SoapTarget,
  username: string,
  password: string,
  timeoutMs = 5000,
): Promise<{ manufacturer: string | null; model: string | null } | null> {
  const probe = await onvifProbe(target, timeoutMs);
  const created = probe.utc ?? new Date();
  try {
    const res = await soapPost(
      target,
      'GetDeviceInformation',
      getDeviceInformationRequest(username, password, created),
      timeoutMs,
    );
    if (res.status !== 200) return null;
    return parseDeviceInformation(res.body);
  } catch {
    return null;
  }
}
