import { safeStorage } from "electron";

/**
 * Encrypts a secret with the OS-native keychain (macOS Keychain / Windows DPAPI via
 * Electron's safeStorage) before it is written to the on-disk electron-store JSON file.
 * Falls back to plain text only when OS encryption isn't available on the host.
 */
export function encryptSecret(plainText: string): string {
  if (!plainText) {
    return "";
  }
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn("[secure-store] OS encryption unavailable; storing secret in plain text");
    return plainText;
  }
  return safeStorage.encryptString(plainText).toString("base64");
}

export function decryptSecret(stored: string): string {
  if (!stored) {
    return "";
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return stored;
  }
  try {
    return safeStorage.decryptString(Buffer.from(stored, "base64"));
  } catch {
    // Legacy plain-text value written before encryption was introduced.
    return stored;
  }
}
