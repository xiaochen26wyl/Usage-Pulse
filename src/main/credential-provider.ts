import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CURSOR_ACCESS_TOKEN_KEY = "cursorAuth/accessToken";
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

const pickAccessTokenFromUnknown = (value: unknown): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const direct = pickAccessTokenFromUnknown(record.accessToken);
  if (direct) {
    return direct;
  }

  const claudeOauth = record.claudeAiOauth as Record<string, unknown> | undefined;
  if (claudeOauth) {
    const nested = pickAccessTokenFromUnknown(claudeOauth.accessToken);
    if (nested) {
      return nested;
    }
  }

  return null;
};

const parseTokenFromRawText = (rawText: string): string | null => {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return pickAccessTokenFromUnknown(parsed);
  } catch {
    return pickAccessTokenFromUnknown(trimmed);
  }
};

const resolveCursorStateDbPath = (): string => {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appData, "Cursor", "User", "globalStorage", "state.vscdb");
  }
  return join(homedir(), ".config", "Cursor", "User", "globalStorage", "state.vscdb");
};

const runReadOnlySqliteQuery = async (dbPath: string, sql: string): Promise<string> => {
  const dbUri = `${pathToFileURL(dbPath).toString()}?mode=ro`;
  const { stdout } = await execFileAsync("sqlite3", [dbUri, sql], {
    timeout: 10_000,
    maxBuffer: 1024 * 1024
  });
  return stdout.trim();
};

const readCursorTokenFromStateDb = async (): Promise<string> => {
  const dbPath = resolveCursorStateDbPath();
  const raw = await runReadOnlySqliteQuery(
    dbPath,
    `SELECT value FROM ItemTable WHERE key = '${CURSOR_ACCESS_TOKEN_KEY}' LIMIT 1;`
  );
  const token = parseTokenFromRawText(raw);
  if (!token) {
    throw new Error("找不到 Cursor access token，請先在 Cursor Desktop 登入。");
  }
  return token;
};

const readClaudeTokenFromKeychain = async (): Promise<string | null> => {
  if (process.platform !== "darwin") {
    return null;
  }

  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      CLAUDE_KEYCHAIN_SERVICE,
      "-w"
    ]);
    return parseTokenFromRawText(stdout);
  } catch {
    return null;
  }
};

const resolveClaudeCredentialsPath = (): string => {
  const customDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (customDir) {
    return join(customDir, ".credentials.json");
  }
  if (process.platform === "win32") {
    const profile = process.env.USERPROFILE || homedir();
    return join(profile, ".claude", ".credentials.json");
  }
  return join(homedir(), ".claude", ".credentials.json");
};

const readClaudeTokenFromCredentialsFile = async (): Promise<string | null> => {
  try {
    const raw = await readFile(resolveClaudeCredentialsPath(), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return pickAccessTokenFromUnknown(parsed);
  } catch {
    return null;
  }
};

export const getCursorAccessToken = async (): Promise<string> => {
  try {
    return await readCursorTokenFromStateDb();
  } catch {
    throw new Error("無法讀取 Cursor 本機憑證，請先確認已登入 Cursor Desktop。");
  }
};

export const getClaudeCodeOAuthToken = async (): Promise<string> => {
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (envToken) {
    return envToken;
  }

  const keychainToken = await readClaudeTokenFromKeychain();
  if (keychainToken) {
    return keychainToken;
  }

  const fileToken = await readClaudeTokenFromCredentialsFile();
  if (fileToken) {
    return fileToken;
  }

  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error("目前為 API key 模式，無法讀取 Claude Code 訂閱配額。");
  }

  throw new Error("找不到 Claude Code OAuth 憑證，請先在終端機執行 claude 登入。");
};

export const hasCursorAccessToken = async (): Promise<boolean> => {
  try {
    await getCursorAccessToken();
    return true;
  } catch {
    return false;
  }
};

export const hasClaudeCodeOAuthToken = async (): Promise<boolean> => {
  try {
    await getClaudeCodeOAuthToken();
    return true;
  } catch {
    return false;
  }
};
