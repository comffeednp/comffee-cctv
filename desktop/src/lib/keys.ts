/**
 * Key helpers: the app's SSH key for new servers, Oracle API key fingerprints, the JWK Oracle's browser
 * sign-in expects, and reading the claims of an Oracle session token.
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

export interface SshKeyPair {
  /** PKCS8 PEM. Stored only through the OS secret store. */
  privateKeyPem: string;
  /** "ssh-ed25519 AAAA... comffee-cctv" for the server's authorized_keys. */
  publicKey: string;
}

function sshString(data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  return Buffer.concat([len, data]);
}

export function sshPublicKeyFromEd25519(publicKey: KeyObject, comment = 'comffee-cctv'): string {
  const jwk = publicKey.export({ format: 'jwk' });
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') throw new Error('Not an Ed25519 key.');
  const raw = Buffer.from(jwk.x, 'base64url');
  const blob = Buffer.concat([sshString(Buffer.from('ssh-ed25519')), sshString(raw)]);
  return `ssh-ed25519 ${blob.toString('base64')} ${comment}`;
}

export function generateSshKeyPair(): SshKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: sshPublicKeyFromEd25519(publicKey),
  };
}

/** Oracle's API key fingerprint: MD5 of the public key's SubjectPublicKeyInfo DER, as colon-separated hex. */
export function apiKeyFingerprint(key: KeyObject): string {
  const pub = key.type === 'private' ? createPublicKey(key) : key;
  const der = pub.export({ format: 'der', type: 'spki' });
  const hex = createHash('md5').update(der).digest('hex');
  return hex.match(/../g)!.join(':');
}

export interface SessionKeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** PKCS8 PEM of the private key, for the OS secret store. */
  privateKeyPem: string;
}

/** A fresh RSA 2048 key for a browser sign-in, as the OCI CLI makes. */
export function generateSessionKeyPair(): SessionKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 });
  return { privateKey, publicKey, privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() };
}

/**
 * The public_key query value of Oracle's browser sign-in: the JWK as the OCI CLI's to_jwk() writes it
 * (Python json.dumps spacing, kid "Ignored"), then base64url with padding (urlsafe_b64encode).
 */
export function signInPublicKeyParam(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: 'jwk' });
  if (jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') throw new Error('Not an RSA key.');
  const json = `{"kty": "RSA", "n": "${jwk.n}", "e": "${jwk.e}", "kid": "Ignored"}`;
  return Buffer.from(json, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

export function newNonce(): string {
  return randomUUID();
}

export function loadPrivateKey(pem: string): KeyObject {
  return createPrivateKey({ key: pem, format: 'pem' });
}

/** The claims of a JWT, without checking its signature (Oracle checks it on every call). Null when unreadable. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as unknown;
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface SessionTokenInfo {
  userId: string;
  tenancyId: string;
  /** Unix ms. */
  expiresAt: number;
  /** The RSA modulus (base64url) the token is bound to, when the token says. */
  boundKeyN: string | null;
}

export function readSessionToken(token: string): SessionTokenInfo | null {
  if (!/^[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$/.test(token) || token.length > 16_384) return null;
  const claims = decodeJwtPayload(token);
  if (!claims) return null;
  const sub = claims.sub;
  const tenant = claims.tenant;
  const exp = claims.exp;
  if (typeof sub !== 'string' || typeof tenant !== 'string' || typeof exp !== 'number') return null;
  let boundKeyN: string | null = null;
  let jwk: unknown = claims.jwk;
  if (typeof jwk === 'string') {
    try {
      jwk = JSON.parse(jwk);
    } catch {
      jwk = null;
    }
  }
  if (jwk && typeof jwk === 'object' && typeof (jwk as { n?: unknown }).n === 'string') boundKeyN = (jwk as { n: string }).n;
  return { userId: sub, tenancyId: tenant, expiresAt: exp * 1000, boundKeyN };
}

export function rsaModulus(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: 'jwk' });
  return typeof jwk.n === 'string' ? jwk.n : '';
}
