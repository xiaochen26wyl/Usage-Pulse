import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { CLAUDE_OAUTH_TOKEN_PREFIX } from "@shared/claude-auth";

const execFileAsync = promisify(execFile);

// Exported so the hand-pasted setup-token can be format-checked in the IPC
// boundary before it ever reaches the API or Keychain.
export const SETUP_TOKEN_PREFIX = CLAUDE_OAUTH_TOKEN_PREFIX;
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
