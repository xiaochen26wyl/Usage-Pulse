import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Exported so a hand-pasted token (the manual fallback when automatic
// capture fails) can be format-checked with the same rule the captured-output
// parser below uses, instead of a second, possibly-diverging definition.
export const SETUP_TOKEN_PREFIX = "sk-ant-oat01-";
// Official tokens are ~108 characters. Terminal wrap used to yield a 79-char
// stump that the usage API rejects; refuse anything shorter than this floor.
export const MIN_TOKEN_LENGTH = 100;

export type SetupTokenErrorCode = "notFound" | "launchFailed";

export class SetupTokenError extends Error {
  constructor(public readonly code: SetupTokenErrorCode) {
    super(code);
    this.name = "SetupTokenError";
  }
}

/**
 * `claude setup-token` prints "valid for 1 year". No expiry claim lives
 * inside the token itself (it isn't a JWT), so this is the only place that
 * duration is recorded — it lets the re-detect flow trust a stored token
 * without ever calling the usage API just to find out whether it's still good.
 */
export const computeSetupTokenExpiryIso = (): string => {
  const expiry = new Date();
  expiry.setFullYear(expiry.getFullYear() + 1);
  return expiry.toISOString();
};

/**
 * Pulls a long-lived `sk-ant-oat01-` token out of CLI output. The official
 * command wraps the value across two lines at typical terminal widths, so
 * whitespace between the prefix and the rest of the body is discarded.
 */
export const extractSetupTokenFromOutput = (text: string): string | null => {
  const start = text.indexOf(SETUP_TOKEN_PREFIX);
  if (start < 0) {
    return null;
  }

  let collected = "";
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (/\s/.test(character)) {
      // A wrap only continues the same token. Once we already have a full
      // value, the next word ("Store this token…") is prose, not body.
      if (collected.length >= MIN_TOKEN_LENGTH) {
        break;
      }
      continue;
    }
    if (!/[A-Za-z0-9_-]/.test(character)) {
      break;
    }
    collected += character;
  }

  return collected.length >= MIN_TOKEN_LENGTH ? collected : null;
};

// The login URL is opened in the user's browser without asking, so the host has
// to be checked properly rather than by substring. A pattern like
// `claude\.ai[^\s]*` happily matches `https://claude.ai.evil.com/…`, where
// `claude.ai` is only a prefix of the real registrable domain.
const AUTH_URL_HOSTS = ["claude.ai", "claude.com", "anthropic.com"] as const;

const isTrustedAuthHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase();
  return AUTH_URL_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
};

export const extractAuthUrlFromOutput = (text: string): string | null => {
  // Collect candidates loosely, then let the URL parser decide. Raw PTY
  // output carries ANSI/OSC-8 escape bytes (e.g. a terminal hyperlink's
  // `\x1B]8;;<url>\x07` wrapper) right up against the URL text with no
  // whitespace in between — excluding control characters (\x00-\x1f, \x7f)
  // keeps those out of the match instead of gluing them onto the end.
  const candidates = text.match(/https:\/\/[^\s"'<>\x00-\x1f\x7f]+/gi);
  if (!candidates) {
    return null;
  }

  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" && isTrustedAuthHost(url.hostname)) {
        return candidate;
      }
    } catch {
      // Not a URL after all; keep looking.
    }
  }

  return null;
};

const extraBinDirs = (): string[] => {
  const dirs = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".local", "bin"),
    join(homedir(), ".npm-global", "bin")
  ];
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    if (appData) {
      dirs.push(join(appData, "npm"));
    }
  }
  return dirs;
};

const binaryNames = (): string[] =>
  process.platform === "win32" ? ["claude.cmd", "claude.exe", "claude"] : ["claude"];

const isExecutable = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export const resolveClaudeBinary = async (): Promise<string> => {
  const names = binaryNames();
  const searchDirs = [...extraBinDirs(), ...(process.env.PATH || "").split(delimiter)];
  for (const dir of searchDirs) {
    if (!dir) {
      continue;
    }
    for (const name of names) {
      const candidate = join(dir, name);
      if (await isExecutable(candidate)) {
        return candidate;
      }
    }
  }

  const whichCommand = process.platform === "win32" ? "where" : "which";
  const augmentedPath = [...extraBinDirs(), process.env.PATH || ""].join(delimiter);
  try {
    const { stdout } = await execFileAsync(whichCommand, ["claude"], {
      env: { ...process.env, PATH: augmentedPath }
    });
    const first = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (first && (await isExecutable(first))) {
      return first;
    }
  } catch {
    // Fall through to the not-found error.
  }

  throw new SetupTokenError("notFound");
};
