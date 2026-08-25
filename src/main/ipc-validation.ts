import type { AppSettings, ServiceType, WaterCupSizeMl } from "@shared/types";
import { normalizeWaterCupSize } from "@shared/water";
import { DEFAULT_SETTINGS } from "@main/config";

/**
 * Everything arriving over IPC is renderer input, and renderer input is not
 * trusted just because the renderer is ours.
 *
 * The sharpest edge is `service`: it used to flow straight from an IPC argument
 * into `store.set(`credentials.${service}`)`, where electron-store reads the
 * template as a dot path — so an unexpected string was a write primitive
 * pointing anywhere in the config file. Everything here fails closed: an
 * unrecognised value becomes null and the handler declines to act.
 */

const SERVICE_TYPES: ReadonlySet<string> = new Set<ServiceType>(["cursor", "claude"]);

export const asServiceType = (value: unknown): ServiceType | null =>
  typeof value === "string" && SERVICE_TYPES.has(value) ? (value as ServiceType) : null;

export const asWaterCupSize = (value: unknown): WaterCupSizeMl | null => {
  if (value === undefined || value === null) {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? normalizeWaterCupSize(numeric) : null;
};

// Longest string value a settings patch may carry, so a runaway renderer
// cannot push an unbounded string through validation and into the settings file.
const MAX_TOKEN_LENGTH = 4096;

// Only ever the two short CLI commands the UI offers to copy.
const MAX_CLIPBOARD_LENGTH = 256;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export const asClipboardText = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length > MAX_CLIPBOARD_LENGTH) {
    return null;
  }
  // No control characters: whatever lands on the clipboard is pasted into a shell.
  return CONTROL_CHARACTERS.test(value) ? null : value;
};

/**
 * Filters a settings patch down to keys that actually exist, with the type the
 * default declares. `settingsStore.update` already clamps ranges; this layer
 * exists to stop unknown keys and wrong types from getting that far.
 */
export const asSettingsPatch = (value: unknown): Partial<AppSettings> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const patch: Record<string, unknown> = {};
  const defaults = DEFAULT_SETTINGS as unknown as Record<string, unknown>;

  for (const [key, candidate] of Object.entries(value as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(defaults, key)) {
      continue;
    }
    if (typeof candidate !== typeof defaults[key]) {
      continue;
    }
    if (typeof candidate === "number" && !Number.isFinite(candidate)) {
      continue;
    }
    if (typeof candidate === "string" && candidate.length > MAX_TOKEN_LENGTH) {
      continue;
    }
    patch[key] = candidate;
  }

  return patch as Partial<AppSettings>;
};
