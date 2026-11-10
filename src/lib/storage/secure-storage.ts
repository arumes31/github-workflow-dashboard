/**
 * Secure Storage
 *
 * Persists sensitive values (the GitHub token and the selected repositories)
 * with AES-256-GCM. The encryption material is a random 256-bit secret stored
 * in IndexedDB, never in localStorage and never derived from a predictable
 * browser fingerprint.
 *
 * Threat model
 * ------------
 * - An attacker who can dump localStorage (shared machine, backup, extension
 *   with storage access) only sees authenticated ciphertext.
 * - An attacker with full script execution on the origin (XSS) can still ask
 *   this module to decrypt. The CSP and the lack of user-controlled HTML are
 *   the controls for that scenario. No client-only scheme can defend against
 *   arbitrary same-origin script execution.
 * - Values are bound to their storage key through AES-GCM additional data, so
 *   a ciphertext cannot be copied from one key to another.
 */

export const STORAGE_KEYS = {
  GITHUB_TOKEN: 'github_flow_dashboard_token',
  GITHUB_USER_ID: 'github_flow_dashboard_user_id',
  GITHUB_TOKEN_SCOPES: 'github_flow_dashboard_token_scopes',
  SELECTED_REPOSITORIES: 'github_flow_dashboard_selected_repos',
  USER_PREFERENCES: 'github_flow_dashboard_preferences',
  LAST_SYNC: 'github_flow_dashboard_last_sync',
} as const;

const DB_NAME = 'github-workflow-monitor';
const DB_VERSION = 1;
const SECRET_STORE = 'secrets';
const DEVICE_SECRET_ID = 'device-secret-v2';
const FORMAT_VERSION = 2;
const HKDF_INFO = 'github-workflow-monitor/storage/v2';
const LEGACY_SALT = 'github-flow-dashboard-v1';

interface EncryptedPayload {
  v: number;
  alg: 'AES-GCM';
  iv: string;
  salt: string;
  data: string;
  createdAt: number;
}

interface LegacyPayload {
  encrypted: number[];
  salt: number[];
  iv: number[];
  timestamp?: number;
}

function getLocalStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
    if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
      return globalThis.localStorage;
    }
  } catch {
    // Access can throw in private mode / blocked-cookie contexts.
  }
  return null;
}

function getCrypto(): Crypto | null {
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.subtle) {
    return globalThis.crypto;
  }
  return null;
}

function getIndexedDB(): IDBFactory | null {
  try {
    if (typeof globalThis !== 'undefined' && globalThis.indexedDB) {
      return globalThis.indexedDB;
    }
  } catch {
    // IndexedDB can be disabled by policy.
  }
  return null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string') throw new Error('Invalid base64 value');
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function openDatabase(): Promise<IDBDatabase> {
  const idb = getIndexedDB();
  if (!idb) return Promise.reject(new Error('IndexedDB is not available'));

  return new Promise((resolve, reject) => {
    const request = idb.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SECRET_STORE)) {
        db.createObjectStore(SECRET_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    request.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  });
}

function readSecret(db: IDBDatabase): Promise<ArrayBuffer | undefined> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(SECRET_STORE, 'readonly');
    const request = transaction.objectStore(SECRET_STORE).get(DEVICE_SECRET_ID);
    request.onsuccess = () => resolve(request.result as ArrayBuffer | undefined);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'));
  });
}

function writeSecret(db: IDBDatabase, secret: Uint8Array<ArrayBuffer>): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(SECRET_STORE, 'readwrite');
    // Copy into a fresh ArrayBuffer so structured clone always succeeds.
    const buffer = secret.buffer.slice(
      secret.byteOffset,
      secret.byteOffset + secret.byteLength
    ) as ArrayBuffer;
    transaction.objectStore(SECRET_STORE).put(buffer, DEVICE_SECRET_ID);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB write failed'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB write aborted'));
  });
}

/**
 * Returns the random per-install storage secret, creating it on first use.
 * The secret is generated with the platform CSPRNG and never leaves IndexedDB
 * as part of a localStorage dump.
 *
 * The promise is cached so concurrent writes cannot race to create two
 * different secrets and make earlier ciphertext unreadable.
 */
let deviceSecretPromise: Promise<Uint8Array<ArrayBuffer>> | null = null;

async function loadOrCreateDeviceSecret(crypto: Crypto): Promise<Uint8Array<ArrayBuffer>> {
  const db = await openDatabase();
  try {
    const existing = await readSecret(db);
    if (existing && existing.byteLength >= 32) {
      return new Uint8Array(existing);
    }

    const secret = crypto.getRandomValues(new Uint8Array(32));
    await writeSecret(db, secret);
    return secret;
  } finally {
    db.close();
  }
}

async function getOrCreateDeviceSecret(crypto: Crypto): Promise<Uint8Array<ArrayBuffer>> {
  if (!deviceSecretPromise) {
    deviceSecretPromise = loadOrCreateDeviceSecret(crypto).catch((error) => {
      deviceSecretPromise = null;
      throw error;
    });
  }
  return deviceSecretPromise;
}

async function deriveItemKey(
  crypto: Crypto,
  secret: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    secret,
    'HKDF',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: new TextEncoder().encode(HKDF_INFO),
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Check whether encrypted persistence is possible in this browser.
 */
export async function isSecureStorageAvailable(): Promise<boolean> {
  if (typeof window === 'undefined') return false;

  const crypto = getCrypto();
  const localStorage = getLocalStorage();
  if (!crypto || !localStorage || !getIndexedDB()) return false;

  try {
    const testKey = '__gwm_storage_test__';
    localStorage.setItem(testKey, 'test');
    localStorage.removeItem(testKey);

    const db = await openDatabase();
    db.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Encrypt and persist a value in localStorage.
 */
export async function setSecureItem(key: string, value: string): Promise<void> {
  const crypto = getCrypto();
  const localStorage = getLocalStorage();

  if (!crypto || !localStorage) {
    throw new Error('Secure storage is not available in this browser');
  }

  const secret = await getOrCreateDeviceSecret(crypto);
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const derivedKey = await deriveItemKey(crypto, secret, salt);

  const encrypted = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: new TextEncoder().encode(key),
    },
    derivedKey,
    new TextEncoder().encode(value)
  );

  const payload: EncryptedPayload = {
    v: FORMAT_VERSION,
    alg: 'AES-GCM',
    iv: bytesToBase64(iv),
    salt: bytesToBase64(salt),
    data: bytesToBase64(new Uint8Array(encrypted)),
    createdAt: Date.now(),
  };

  localStorage.setItem(key, JSON.stringify(payload));
}

async function decryptV2(
  crypto: Crypto,
  key: string,
  payload: EncryptedPayload
): Promise<string> {
  if (payload.v !== FORMAT_VERSION || payload.alg !== 'AES-GCM') {
    throw new Error('Unsupported storage format');
  }

  const secret = await getOrCreateDeviceSecret(crypto);
  const salt = base64ToBytes(payload.salt);
  const iv = base64ToBytes(payload.iv);
  const data = base64ToBytes(payload.data);

  if (salt.byteLength !== 32 || iv.byteLength !== 12) {
    throw new Error('Invalid storage format');
  }

  const derivedKey = await deriveItemKey(crypto, secret, salt);
  const decrypted = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: new TextEncoder().encode(key),
    },
    derivedKey,
    data
  );

  return new TextDecoder().decode(decrypted);
}

/**
 * Legacy v1 keys were derived from a public browser fingerprint. They are
 * transparently re-encrypted with the v2 scheme on first read.
 */
async function decryptLegacy(
  crypto: Crypto,
  key: string,
  payload: LegacyPayload
): Promise<string> {
  if (
    !Array.isArray(payload.encrypted) ||
    !Array.isArray(payload.salt) ||
    !Array.isArray(payload.iv)
  ) {
    throw new Error('Invalid legacy storage format');
  }

  const fingerprint = [
    typeof navigator !== 'undefined' ? navigator.userAgent || 'unknown' : 'unknown',
    typeof navigator !== 'undefined' ? navigator.language || 'unknown' : 'unknown',
    typeof screen !== 'undefined' ? `${screen.width}x${screen.height}` : 'unknown',
    typeof Date !== 'undefined' ? new Date().getTimezoneOffset().toString() : '0',
    LEGACY_SALT,
  ].join('|');

  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(fingerprint)
  );
  const password = `pwd_${Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32)}`;

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  const derivedKey = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: new Uint8Array(payload.salt),
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(payload.iv) },
    derivedKey,
    new Uint8Array(payload.encrypted)
  );

  const plaintext = new TextDecoder().decode(decrypted);
  // Migrate to the non-fingerprint scheme immediately.
  await setSecureItem(key, plaintext);
  return plaintext;
}

/**
 * Read and decrypt a value. Returns null when the value is missing or cannot
 * be authenticated; corrupted entries are deleted instead of being retried.
 */
export async function getSecureItem(key: string): Promise<string | null> {
  const crypto = getCrypto();
  const localStorage = getLocalStorage();
  if (!crypto || !localStorage) return null;

  const stored = localStorage.getItem(key);
  if (!stored) return null;

  try {
    const payload = JSON.parse(stored) as EncryptedPayload | LegacyPayload;

    if ('v' in payload) {
      return await decryptV2(crypto, key, payload as EncryptedPayload);
    }
    return await decryptLegacy(crypto, key, payload as LegacyPayload);
  } catch {
    localStorage.removeItem(key);
    return null;
  }
}

/**
 * Remove a single value.
 */
export function removeSecureItem(key: string): void {
  try {
    getLocalStorage()?.removeItem(key);
  } catch {
    // Ignore storage removal failures.
  }
}

/**
 * Remove every value owned by this application.
 */
export function clearAllSecureStorage(): void {
  Object.values(STORAGE_KEYS).forEach(removeSecureItem);
  try {
    getLocalStorage()?.removeItem('github-flow-dashboard-last-org');
    getLocalStorage()?.removeItem('github-flow-dashboard-settings');
    getLocalStorage()?.removeItem('github-flow-dashboard-theme');
  } catch {
    // Ignore storage removal failures.
  }
}
