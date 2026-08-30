import type { AppSettings, ServiceType, WaterCupSizeMl } from "@shared/types";
import { normalizeWaterCupSize } from "@shared/water";
import { DEFAULT_SETTINGS } from "@main/config";
import { MIN_TOKEN_LENGTH, SETUP_TOKEN_PREFIX } from "@main/claude-setup-token";

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

const SERVICE_TYPES: ReadonlySet<string> = new Set<ServiceType>(["cursor", "claude", "codex"]);

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
const TOKEN_CHARACTER = /[A-Za-z0-9_-]/;
const HTML_SPACE_ENTITY = /&(?:#x20|#32|nbsp);/gi;

export const asClipboardText = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length > MAX_CLIPBOARD_LENGTH) {
    return null;
  }
  // No control characters: whatever lands on the clipboard is pasted into a shell.
  return CONTROL_CHARACTERS.test(value) ? null : value;
};

// A setup-token the user hand-pastes after running `claude setup-token`.
// Obvious mistakes (empty, truncated, the wrong kind of key) are rejected
// before they ever reach the API or Keychain.
export const asClaudeManualToken = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.replace(HTML_SPACE_ENTITY, " ").trim();
  if (text.length < MIN_TOKEN_LENGTH || text.length > MAX_TOKEN_LENGTH) {
    return null;
  }
  const start = text.indexOf(SETUP_TOKEN_PREFIX);
  if (start < 0) {
    return null;
  }

  let token = "";
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (/\s/.test(character)) {
      if (token.length >= MIN_TOKEN_LENGTH) {
        break;
      }
      continue;
    }
    if (character === "\\" && text[index + 1] === "_") {
      token += "_";
      index += 1;
      continue;
    }
    if (!TOKEN_CHARACTER.test(character)) {
      break;
    }
    token += character;
  }

  return token.length >= MIN_TOKEN_LENGTH && token.length <= MAX_TOKEN_LENGTH ? token : null;
};

// A terminal resize the claude-login window reports on its own container
// size — bounded so a compromised/misbehaving renderer can't ask the PTY to
// allocate an absurd screen buffer.
const MAX_PTY_DIMENSION = 500;

// Alarm popup height reported by the renderer after layout. Bounded so a
// misbehaving renderer cannot ask for an absurd BrowserWindow size.
const MIN_ALARM_HEIGHT = 80;
const MAX_ALARM_HEIGHT = 480;

export const asAlarmHeight = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const rounded = Math.round(value);
  if (rounded < MIN_ALARM_HEIGHT || rounded > MAX_ALARM_HEIGHT) {
    return null;
  }
  return rounded;
};

export const asPtySize = (value: unknown): { cols: number; rows: number } | null => {
  if (!value || typeof value !== "object") {
    return null;
  }
  const { cols, rows } = value as { cols?: unknown; rows?: unknown };
  if (typeof cols !== "number" || typeof rows !== "number") {
    return null;
  }
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) {
    return null;
  }
  if (cols < 1 || cols > MAX_PTY_DIMENSION || rows < 1 || rows > MAX_PTY_DIMENSION) {
    return null;
  }
  return { cols, rows };
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
