import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SqlJsStatic } from "sql.js";

const execFileAsync = promisify(execFile);

/**
 * Supplies the hand-entered Claude Code token, if the user has stored one.
 *
 * Injected rather than imported from the store, so this module keeps depending
 * on nothing but the OS — the same reason credential-monitor takes its quota
 * refresher by injection.
 */
let manualClaudeTokenProvider: (() => string | null | undefined) | null = null;

export const setManualClaudeTokenProvider = (provider: () => string | null | undefined): void => {
  manualClaudeTokenProvider = provider;
};
const require = createRequire(import.meta.url);
// Loaded via require(), not a static `import`: sql.js ships its Emscripten/CJS
// glue as a UMD-style script doing `module.exports = ...`. Vite/Rollup statically
// bundling that into the main process's SSR output breaks its module/exports
// binding (throws "Cannot set properties of undefined (setting 'exports')" the
// moment initSqlJs() is called) even though the build itself succeeds silently.
// require() keeps it out of the bundle so Node's real CJS loader runs it as-is.
const initSqlJs = require("sql.js") as (config?: {
  locateFile?: (file: string) => string;
}) => Promise<SqlJsStatic>;

const CURSOR_ACCESS_TOKEN_KEY = "cursorAuth/accessToken";
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
// sql.js loads the whole db file into the JS heap; beyond this size that becomes
// slow/memory-heavy enough to effectively hang, so fall back to the sqlite3 CLI instead.
const CURSOR_STATE_DB_LARGE_FILE_THRESHOLD_BYTES = 150 * 1024 * 1024;
let sqlJsPromise: Promise<SqlJsStatic> | null = null;

class CursorStateDbTooLargeError extends Error {}

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

// Milliseconds-since-epoch expiry advertised alongside the token, when the
// credential blob carries one. Mirrors pickAccessTokenFromUnknown, which walks
// the same shapes but keeps only the token itself.
const pickExpiresAtFromUnknown = (value: unknown): number | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of ["expiresAt", "expires_at", "expiresAtMs"]) {
    const candidate = record[key];
    const numeric = typeof candidate === "string" ? Number(candidate) : candidate;
    if (typeof numeric === "number" && Number.isFinite(numeric) && numeric > 0) {
      // Some blobs store seconds rather than milliseconds; anything below this
      // threshold cannot be a sane millisecond timestamp.
      return numeric < 1e12 ? numeric * 1000 : numeric;
    }
  }

  const claudeOauth = record.claudeAiOauth as Record<string, unknown> | undefined;
  return claudeOauth ? pickExpiresAtFromUnknown(claudeOauth) : null;
};

// Expiry carried inside the token itself. Both providers hand out JWTs, so a
// blob with no explicit expiry field still yields one from the `exp` claim.
const decodeJwtExpiryMs = (token: string): number | null => {
  const segments = token.split(".");
  if (segments.length < 2) {
    return null;
  }

  try {
    const payloadJson = Buffer.from(segments[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    const exp = payload.exp;
    return typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
  } catch {
    return null;
  }
};

const toIsoOrNull = (ms: number | null): string | null =>
  ms === null ? null : new Date(ms).toISOString();

// A token plus whatever expiry we could derive for it. `expiresAt` is null when
// neither the surrounding blob nor the token's own claims declare one.
export interface RawCredential {
  token: string;
  expiresAt: string | null;
}

const toCredential = (token: string, explicitExpiryMs: number | null): RawCredential => ({
  token,
  expiresAt: toIsoOrNull(explicitExpiryMs ?? decodeJwtExpiryMs(token))
});

const parseCredentialFromRawText = (rawText: string): RawCredential | null => {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const token = pickAccessTokenFromUnknown(parsed);
    return token ? toCredential(token, pickExpiresAtFromUnknown(parsed)) : null;
  } catch {
    const token = pickAccessTokenFromUnknown(trimmed);
    return token ? toCredential(token, null) : null;
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

const getSqlJs = async (): Promise<SqlJsStatic> => {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs({
      locateFile: (file: string) => require.resolve(`sql.js/dist/${file}`)
    });
  }
  return sqlJsPromise;
};

const runReadOnlySqliteQuery = async (dbPath: string, key: string): Promise<string> => {
  const SQL = await getSqlJs();
  const databaseBytes = await readFile(dbPath);
  const db = new SQL.Database(new Uint8Array(databaseBytes));
  const statement = db.prepare("SELECT value FROM ItemTable WHERE key = $key LIMIT 1;");

  statement.bind({ $key: key });
  try {
    if (!statement.step()) {
      return "";
    }
    const row = statement.getAsObject() as Record<string, unknown>;
    const value = row.value;
    if (typeof value === "string") {
      return value.trim();
    }
    return value === null || value === undefined ? "" : String(value).trim();
  } finally {
    statement.free();
    db.close();
  }
};

const readValueViaSqliteCli = async (dbPath: string, key: string): Promise<string> => {
  const escapedKey = key.replace(/'/g, "''");
  const { stdout } = await execFileAsync("sqlite3", [
    "-readonly",
    "-batch",
    "-noheader",
    dbPath,
    `SELECT value FROM ItemTable WHERE key = '${escapedKey}' LIMIT 1;`
  ]);
  return stdout.trim();
};

const readValueFromLargeStateDb = async (dbPath: string, key: string, sizeBytes: number): Promise<string> => {
  try {
    return await readValueViaSqliteCli(dbPath, key);
  } catch {
    const sizeMb = Math.round(sizeBytes / 1024 / 1024);
    throw new CursorStateDbTooLargeError(
      `Cursor 本機資料庫異常肥大（約 ${sizeMb} MB），無法安全載入。請先關閉 Cursor，備份並移除此檔案讓 Cursor 重新建立（會需要重新登入 Cursor）：${dbPath}`
    );
  }
};

export const readCursorCredentialFromStateDbPath = async (dbPath: string): Promise<RawCredential> => {
  const { size } = await stat(dbPath);
  const raw =
    size > CURSOR_STATE_DB_LARGE_FILE_THRESHOLD_BYTES
      ? await readValueFromLargeStateDb(dbPath, CURSOR_ACCESS_TOKEN_KEY, size)
      : await runReadOnlySqliteQuery(dbPath, CURSOR_ACCESS_TOKEN_KEY);
  const credential = parseCredentialFromRawText(raw);
  if (!credential) {
    throw new Error("找不到 Cursor access token，請先在 Cursor Desktop 登入。");
  }
  return credential;
};

export const readCursorTokenFromStateDbPath = async (dbPath: string): Promise<string> =>
  (await readCursorCredentialFromStateDbPath(dbPath)).token;

const readCursorCredentialFromStateDb = async (): Promise<RawCredential> => {
  const dbPath = resolveCursorStateDbPath();
  try {
    return await readCursorCredentialFromStateDbPath(dbPath);
  } catch (error) {
    if (error instanceof CursorStateDbTooLargeError) {
      throw error;
    }
    throw new Error("無法讀取 Cursor 本機憑證，請先確認已登入 Cursor Desktop。");
  }
};

export const peekClaudeKeychainCredential = async (): Promise<RawCredential | null> => {
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
    return parseCredentialFromRawText(stdout);
  } catch {
    return null;
  }
};

const readExistingKeychainAccount = async (): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      CLAUDE_KEYCHAIN_SERVICE
    ]);
    const match = stdout.match(/"acct"<blob>="([^"]+)"/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
};

/**
 * Exception write: persist a long-lived setup-token into the same macOS
 * Keychain item the official CLI uses (`Claude Code-credentials`), so the next
 * re-detect and ordinary `readClaudeCredential` can find it.
 *
 * This is the only Keychain write Usage-Pulse performs. It does not write
 * `state.vscdb`, `~/.claude/.credentials.json`, or anything Cursor-related.
 * Windows has no equivalent item — callers keep the token in the app store.
 */
export const writeClaudeSetupTokenToKeychain = async (token: string): Promise<void> => {
  if (process.platform !== "darwin") {
    return;
  }

  const blob = JSON.stringify({ claudeAiOauth: { accessToken: token } });
  const account = (await readExistingKeychainAccount()) || userInfo().username || "Usage-Pulse";
  await execFileAsync("security", [
    "add-generic-password",
    "-s",
    CLAUDE_KEYCHAIN_SERVICE,
    "-a",
    account,
    "-w",
    blob,
    "-U"
  ]);
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

const readClaudeCredentialFromFile = async (): Promise<RawCredential | null> => {
  try {
    const raw = await readFile(resolveClaudeCredentialsPath(), "utf-8");
    return parseCredentialFromRawText(raw);
  } catch {
    return null;
  }
};

export const readCursorCredential = async (): Promise<RawCredential> => {
  return readCursorCredentialFromStateDb();
};

export const readClaudeCredential = async (): Promise<RawCredential> => {
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (envToken) {
    return toCredential(envToken, null);
  }

  // A token the user pasted in themselves (`claude setup-token`). It sits above
  // the automatic sources deliberately: it only ever exists because automatic
  // detection already failed twice, so letting a half-working Keychain entry
  // outrank it would put the user right back where they started.
  const manualToken = manualClaudeTokenProvider?.()?.trim();
  if (manualToken) {
    return toCredential(manualToken, null);
  }

  const fromKeychain = await peekClaudeKeychainCredential();
  if (fromKeychain) {
    return fromKeychain;
  }

  const fromFile = await readClaudeCredentialFromFile();
  if (fromFile) {
    return fromFile;
  }

  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error("目前為 API key 模式，無法讀取 Claude Code 訂閱配額。");
  }

  throw new Error("找不到 Claude Code OAuth 憑證，請先在終端機執行 claude 登入。");
};

export const getCursorAccessToken = async (): Promise<string> => {
  return (await readCursorCredential()).token;
};

export const getClaudeCodeOAuthToken = async (): Promise<string> => {
  return (await readClaudeCredential()).token;
};

