import { execFile } from "node:child_process";
import { access, constants, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SETUP_TOKEN_PREFIX = "sk-ant-oat01-";
// Official tokens are ~108 characters. Terminal wrap used to yield a 79-char
// stump that the usage API rejects; refuse anything shorter than this floor.
const MIN_TOKEN_LENGTH = 100;
const SETUP_TOKEN_TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 500;
const CAPTURE_FILE_NAME = "setup-token-capture.txt";

export type SetupTokenErrorCode = "notFound" | "timeout" | "inProgress" | "noToken" | "launchFailed";

export class SetupTokenError extends Error {
  constructor(public readonly code: SetupTokenErrorCode) {
    super(code);
    this.name = "SetupTokenError";
  }
}

/**
 * Pulls a long-lived `sk-ant-oat01-` token out of CLI stdout. The official
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
const AUTH_URL_HOSTS = ["claude.ai", "anthropic.com"] as const;

const isTrustedAuthHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase();
  return AUTH_URL_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
};

export const extractAuthUrlFromOutput = (text: string): string | null => {
  // Collect candidates loosely, then let the URL parser decide.
  const candidates = text.match(/https:\/\/[^\s"'<>]+/gi);
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

const resolveClaudeBinary = async (): Promise<string> => {
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

const appleScriptQuote = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const shellSingleQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

const launchSetupTokenWindow = async (claudePath: string, capturePath: string): Promise<void> => {
  const pathPrefix = extraBinDirs().join(":");
  if (process.platform === "darwin") {
    const command = [
      `export PATH=${shellSingleQuote(pathPrefix)}:"$PATH"`,
      `${shellSingleQuote(claudePath)} setup-token 2>&1 | tee ${shellSingleQuote(capturePath)}`,
      `echo`,
      `echo ${shellSingleQuote("Usage-Pulse is watching this output. You can close the window after login finishes.")}`
    ].join("; ");
    const script = `tell application "Terminal"\nactivate\ndo script ${appleScriptQuote(command)}\nend tell`;
    await execFileAsync("osascript", ["-e", script]);
    return;
  }

  if (process.platform === "win32") {
    const psCommand = [
      `& ${shellSingleQuote(claudePath)} setup-token *>&1 | Tee-Object -FilePath ${shellSingleQuote(capturePath)}`,
      `Write-Host "Usage-Pulse is watching this output. You can close the window after login finishes."`
    ].join("; ");
    await execFileAsync("cmd.exe", [
      "/c",
      "start",
      "Usage-Pulse Claude",
      "powershell.exe",
      "-NoExit",
      "-Command",
      psCommand
    ]);
    return;
  }

  throw new SetupTokenError("launchFailed");
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const watchCaptureFile = async (
  capturePath: string,
  onAuthUrl?: (url: string) => void
): Promise<string> => {
  const startedAt = Date.now();
  let openedUrl: string | null = null;

  while (Date.now() - startedAt < SETUP_TOKEN_TIMEOUT_MS) {
    let text = "";
    try {
      text = await readFile(capturePath, "utf-8");
    } catch {
      text = "";
    }

    if (onAuthUrl && !openedUrl) {
      const url = extractAuthUrlFromOutput(text);
      if (url) {
        openedUrl = url;
        onAuthUrl(url);
      }
    }

    const token = extractSetupTokenFromOutput(text);
    if (token) {
      return token;
    }

    await sleep(POLL_MS);
  }

  throw new SetupTokenError("timeout");
};

let inFlight: Promise<string> | null = null;

const collectSetupToken = async (options: {
  userDataDir: string;
  onAuthUrl?: (url: string) => void;
}): Promise<string> => {
  const claudePath = await resolveClaudeBinary();
  const capturePath = join(options.userDataDir, CAPTURE_FILE_NAME);
  await writeFile(capturePath, "", { mode: 0o600 });

  try {
    try {
      await launchSetupTokenWindow(claudePath, capturePath);
    } catch (error) {
      if (error instanceof SetupTokenError) {
        throw error;
      }
      throw new SetupTokenError("launchFailed");
    }
    return await watchCaptureFile(capturePath, options.onAuthUrl);
  } finally {
    // Overwrite before unlinking: the token sat in this file in cleartext for
    // as long as the login took, and truncating it first means a crash between
    // these two lines cannot leave a readable copy behind.
    await writeFile(capturePath, "", { mode: 0o600 }).catch(() => undefined);
    await unlink(capturePath).catch(() => undefined);
  }
};

/**
 * Clears a capture file left behind by a previous run that died mid-login.
 * Called at startup, before anything else can read the directory.
 */
export const clearStaleSetupTokenCapture = async (userDataDir: string): Promise<void> => {
  const capturePath = join(userDataDir, CAPTURE_FILE_NAME);
  try {
    await writeFile(capturePath, "", { mode: 0o600, flag: "r+" });
  } catch {
    // Nothing there, or not writable — either way there is nothing to clear.
  }
  await unlink(capturePath).catch(() => undefined);
};

/**
 * Opens a system terminal running the official CLI's long-lived-token command
 * and returns the token printed to that window. The value never leaves main.
 */
export const runClaudeSetupToken = (options: {
  userDataDir: string;
  onAuthUrl?: (url: string) => void;
}): Promise<string> => {
  if (inFlight) {
    return Promise.reject(new SetupTokenError("inProgress"));
  }
  inFlight = collectSetupToken(options).finally(() => {
    inFlight = null;
  });
  return inFlight;
};
