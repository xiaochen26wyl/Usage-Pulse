import { safeStorage } from "electron";

/**
 * Encrypts a secret with the OS-native keychain (macOS Keychain / Windows DPAPI via
 * Electron's safeStorage) before it is written to the on-disk electron-store JSON file.
 * Falls back to plain text only when OS encryption isn't available on the host.
 */

/**
 * Whether the OS can actually protect a secret at rest on this machine.
 *
 * Exposed so the UI can say so out loud. Silently downgrading to plain text is
 * the worst of both worlds: the user believes the token is protected and has no
 * way to find out otherwise.
 */
export const isSecretStorageAvailable = (): boolean => {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
};

export function encryptSecret(plainText: string): string {
  if (!plainText) {
    return "";
  }
  if (!isSecretStorageAvailable()) {
    console.warn("[secure-store] OS encryption unavailable; storing secret in plain text");
    return plainText;
  }
  return safeStorage.encryptString(plainText).toString("base64");
}

// A stored value written by encryptSecret is base64 and nothing else. Anything
// with a character outside that alphabet predates encryption and is the legacy
// plain-text case.
const LOOKS_LIKE_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function decryptSecret(stored: string): string {
  if (!stored) {
    return "";
  }
  if (!isSecretStorageAvailable()) {
    return stored;
  }
  if (!LOOKS_LIKE_BASE64.test(stored)) {
    // Legacy plain-text value written before encryption was introduced.
    return stored;
  }
  try {
    return safeStorage.decryptString(Buffer.from(stored, "base64"));
  } catch {
    // Genuine ciphertext we can no longer read — a reset Keychain, a different
    // login, a copied config file. Returning `stored` here would hand the raw
    // ciphertext to callers, which would then present it as a bearer token and
    // send it to the provider. Report "no secret" and let the user re-enter one.
    console.warn("[secure-store] stored secret could not be decrypted; treating it as absent");
    return "";
  }
}
