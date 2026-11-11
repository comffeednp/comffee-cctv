/**
 * Recording (vault) public keys: GET /api/keys/vault (signed in), PUT /api/keys/vault (owner, password re-check).
 * The owner's private key never reaches the hub; only the RSA-OAEP 3072 public key (SPKI) is stored.
 */

import { createHash, createPublicKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { VaultKeyInfo, VaultKeysResponse } from '../../../shared/api-types.ts';
import { KEY_ID_BYTES, RSA_MODULUS_BITS } from '../../../shared/vault-format.ts';
import { HttpError } from '../contracts.ts';
import type { RegisterRoutes } from '../contracts.ts';
import { requestMeta } from '../audit.ts';
import { iso } from '../auth/accounts.ts';
import { transaction } from '../db.ts';
import { bodyObject, invalidInput } from '../http.ts';

interface VaultKeyRow {
  key_id: string;
  spki_b64: string;
  created_at: number;
  active: number;
}

function toInfo(r: VaultKeyRow): VaultKeyInfo {
  return { keyId: r.key_id, spkiB64: r.spki_b64, createdAt: iso(r.created_at), active: r.active === 1 };
}

/** Checks the SPKI is an RSA 3072 key with exponent 65537; returns its DER bytes. */
export function parseVaultPublicKey(spkiB64: unknown): Buffer {
  if (typeof spkiB64 !== 'string' || spkiB64.length < 16 || spkiB64.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(spkiB64)) {
    throw invalidInput('spkiB64 must be a base64 SPKI public key');
  }
  const der = Buffer.from(spkiB64, 'base64');
  let key: KeyObject;
  try {
    key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    throw invalidInput('spkiB64 is not a valid public key');
  }
  const details = key.asymmetricKeyDetails;
  if (key.asymmetricKeyType !== 'rsa' || details?.modulusLength !== RSA_MODULUS_BITS || details.publicExponent !== 65537n) {
    throw invalidInput(`The recording key must be an RSA ${RSA_MODULUS_BITS}-bit key`);
  }
  return der;
}

export function keyIdOf(der: Buffer): string {
  return createHash('sha256').update(der).digest().subarray(0, KEY_ID_BYTES).toString('hex');
}

export const registerKeyRoutes: RegisterRoutes = (app, deps) => {
  const { db } = deps;

  function list(): VaultKeysResponse {
    const rows = db.prepare('SELECT * FROM vault_keys ORDER BY created_at DESC, key_id').all() as unknown as VaultKeyRow[];
    const active = rows.find((r) => r.active === 1);
    return { keys: rows.map(toInfo), activeKeyId: active ? active.key_id : null };
  }

  app.get('/api/keys/vault', async (req): Promise<VaultKeysResponse> => {
    deps.auth.requireUser(req);
    return list();
  });

  app.put('/api/keys/vault', async (req): Promise<VaultKeyInfo> => {
    const owner = deps.auth.requireOwner(req);
    const body = bodyObject(req);
    const der = parseVaultPublicKey(body.spkiB64);
    if (!(await deps.auth.verifyPassword(owner.id, typeof body.password === 'string' ? body.password : ''))) {
      throw new HttpError(422, 'wrong_password', 'Your password is not correct');
    }
    const keyId = keyIdOf(der);
    const spkiB64 = der.toString('base64');
    const row = transaction(db, () => {
      db.prepare('UPDATE vault_keys SET active = 0 WHERE active = 1').run();
      const existing = db.prepare('SELECT * FROM vault_keys WHERE key_id = ?').get(keyId) as VaultKeyRow | undefined;
      if (existing) {
        db.prepare('UPDATE vault_keys SET active = 1 WHERE key_id = ?').run(keyId);
      } else {
        db.prepare('INSERT INTO vault_keys (key_id, spki_b64, created_at, active) VALUES (?, ?, ?, 1)').run(keyId, spkiB64, Date.now());
      }
      return db.prepare('SELECT * FROM vault_keys WHERE key_id = ?').get(keyId) as unknown as VaultKeyRow;
    });
    deps.audit({ userId: owner.id, action: 'vault.key_set', target: `key:${keyId}`, ...requestMeta(req) });
    // Recording can start (or switch keys) now; MediaMTX paths follow on the next reconcile.
    Promise.resolve()
      .then(() => deps.media.reconcile())
      .catch((err: unknown) => req.log.warn({ err }, 'reconcile after vault key change failed'));
    return toInfo(row);
  });
};
