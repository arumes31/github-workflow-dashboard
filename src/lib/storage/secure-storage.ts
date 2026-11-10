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

import {
  decryptValue,
  encryptValue,
  getCrypto,
  isCryptoStoreAvailable,
  type EncryptedPayload,
} from './storage-crypto';

export const STORAGE_KEYS = {
  GITHUB_TOKEN: 'github_flow_dashboard_token',
  GITHUB_USER_ID: 'github_flow_dashboard_user_id',
  GITHUB_TOKEN_SCOPES: 'github_flow_dashboard_token_scopes',
  SELECTED_REPOSITORIES: 'github_flow_dashboard_selected_repos',
  USER_PREFERENCES: 'github_flow_dashboard_preferences',
  LAST_SYNC: 'github_flow_dashboard_last_sync',
} as const;

const LEGACY_SALT = 'github-flow-dashboard-v1';

interface LegacyPayload {
  encrypted: number[];
  salt: number[];
  iv: number[];
  timestamp?: number;
}

function getLocalStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
    if (typeof globalThis !== 'undefined' && globalThis.localStorage) return globalThis.localStorage;
  } catch {
    // Access can throw in private mode / blocked-cookie contexts.
  }
  return null;
}

/** Check whether encrypted persistence is possible in this browser. */
export async function isSecureStorageAvailable(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (!getCrypto() || !getLocalStorage()) return false;

  try {
    const testKey = '__gwm_storage_test__';
    localStorage.setItem(testKey, 'test');
    localStorage.removeItem(testKey);
    return await isCryptoStoreAvailable();
  } catch {
    return false;
  }
}

/** Encrypt and persist a value in localStorage. */
export async function setSecureItem(key: string, value: string): Promise<void> {
  const localStorage = getLocalStorage();
  if (!localStorage) throw new Error('Secure storage is not available in this browser');

  const payload = await encryptValue(key, value);
  localStorage.setItem(key, JSON.stringify(payload));
}

/**
 * Legacy v1 keys were derived from a public browser fingerprint. They are
 * transparently re-encrypted with the v2 scheme on first read.
 */
async function decryptLegacy(key: string, payload: LegacyPayload): Promise<string> {
  const crypto = getCrypto();
  if (!crypto) throw new Error('Secure storage is not available');

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

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fingerprint));
  const password = `pwd_${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
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
  await setSecureItem(key, plaintext);
  return plaintext;
}

/**
 * Read and decrypt a value. Returns null when the value is missing or cannot
 * be authenticated; corrupted entries are deleted instead of being retried.
 */
export async function getSecureItem(key: string): Promise<string | null> {
  const localStorage = getLocalStorage();
  if (!localStorage || !getCrypto()) return null;

  const stored = localStorage.getItem(key);
  if (!stored) return null;

  try {
    const payload = JSON.parse(stored) as EncryptedPayload | LegacyPayload;
    if (payload && 'v' in payload) {
      return await decryptValue(key, payload as EncryptedPayload);
    }
    return await decryptLegacy(key, payload as LegacyPayload);
  } catch {
    localStorage.removeItem(key);
    return null;
  }
}

/** Remove a single value. */
export function removeSecureItem(key: string): void {
  try {
    getLocalStorage()?.removeItem(key);
  } catch {
    // Ignore storage removal failures.
  }
}

/** Remove every value owned by this application. */
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
