// Private recording keys kept in this browser. Each key is a NON-extractable CryptoKey stored in IndexedDB
// (database "comffee-cctv", store "keys", keyed by keyId), so page scripts can use it to open recordings but
// can never read the key bytes out again. The key never leaves this device.

import { KEY_DB_NAME, KEY_STORE_NAME } from '../../../../shared/vault-format.ts';

const DB_VERSION = 1;
const KEY_ID_PATTERN = /^[0-9a-f]{32}$/;

/** Thrown when this browser cannot keep keys (private window, storage blocked or full). */
export class KeyStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyStoreError';
  }
}

const UNAVAILABLE = 'This browser cannot keep the recovery key. Leave private browsing or allow site storage, then try again.';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      if (typeof indexedDB === 'undefined') throw new Error('no indexedDB');
      request = indexedDB.open(KEY_DB_NAME, DB_VERSION);
    } catch {
      reject(new KeyStoreError(UNAVAILABLE));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KEY_STORE_NAME)) db.createObjectStore(KEY_STORE_NAME);
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab upgrading the database closes this connection; open a fresh one next time.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(new KeyStoreError(UNAVAILABLE));
    request.onblocked = () => reject(new KeyStoreError('Close other Comffee CCTV tabs, then try again.'));
  });
  dbPromise = opening;
  opening.catch(() => {
    if (dbPromise === opening) dbPromise = null;
  });
  return opening;
}

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let request: IDBRequest<T>;
        try {
          const tx = db.transaction(KEY_STORE_NAME, mode);
          request = work(tx.objectStore(KEY_STORE_NAME));
          tx.oncomplete = () => resolve(request.result);
          tx.onerror = () => reject(new KeyStoreError(UNAVAILABLE));
          tx.onabort = () => reject(new KeyStoreError(UNAVAILABLE));
        } catch {
          reject(new KeyStoreError(UNAVAILABLE));
        }
      }),
  );
}

function checkKeyId(keyId: string): void {
  if (!KEY_ID_PATTERN.test(keyId)) throw new KeyStoreError('That key id is not valid.');
}

function isPrivateDecryptKey(value: unknown): value is CryptoKey {
  return (
    typeof CryptoKey !== 'undefined' &&
    value instanceof CryptoKey &&
    value.type === 'private' &&
    value.algorithm.name === 'RSA-OAEP' &&
    value.usages.includes('decrypt')
  );
}

/** keyIds of the private keys kept in this browser. Empty when storage is unavailable. */
export async function listDeviceKeys(): Promise<string[]> {
  try {
    const keys = await run('readonly', (store) => store.getAllKeys());
    return keys.filter((key): key is string => typeof key === 'string' && KEY_ID_PATTERN.test(key)).sort();
  } catch {
    return [];
  }
}

/** The private key for `keyId`, or null when this browser does not have it. */
export async function getPrivateKey(keyId: string): Promise<CryptoKey | null> {
  if (!KEY_ID_PATTERN.test(keyId)) return null;
  try {
    const value = await run<unknown>('readonly', (store) => store.get(keyId));
    return isPrivateDecryptKey(value) ? value : null;
  } catch {
    return null;
  }
}

/** Stores a private key. Refuses extractable keys: what is kept in the browser must never be readable. */
export async function saveKey(keyId: string, key: CryptoKey): Promise<void> {
  checkKeyId(keyId);
  if (!isPrivateDecryptKey(key)) throw new KeyStoreError('Only a private recording key can be kept.');
  if (key.extractable) throw new KeyStoreError('The key must be locked before it is kept in this browser.');
  await run('readwrite', (store) => store.put(key, keyId));
}

/** Removes a private key from this browser. Its recovery file still works. */
export async function forgetDeviceKey(keyId: string): Promise<void> {
  checkKeyId(keyId);
  await run('readwrite', (store) => store.delete(keyId));
}
