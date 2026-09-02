import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import axios from "axios";
import type { SqlJsStatic } from "sql.js";
import type { CredentialSource, Language } from "@shared/types";
import { isClaudeOAuthToken } from "@shared/claude-auth";
import { jwtExpiryMs, parseCodexAuthJson, parseCodexCredentialsStore, type ParsedCodexAuth } from "@shared/codex-auth";
import { t } from "@shared/i18n";

const execFileAsync = promisify(execFile);

// Loaded lazily (not a static import) so this module — otherwise plain,
// Electron-free logic that credential-provider.test.ts exercises directly
// under node:test — never pulls in electron-store's `app.getPath`
// dependency just by being imported.
const currentLanguage = async (): Promise<Language> => {
  const { settingsStore } = await import("@main/store");
  return settingsStore.get().language;
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
const CLAUDE_CLI_KEYCHAIN_SERVICE = "Claude Code-credentials";
// Usage-Pulse no longer writes any Claude credential itself — the official
// `claude auth login` flow already writes this Keychain item, and Usage-Pulse
// only ever reads it. This service name is kept only so a leftover item from
// the retired setup-token flow (pre-System-1) can be cleaned up once on startup.
const LEGACY_SETUP_TOKEN_KEYCHAIN_SERVICE = "Usage-Pulse-Claude-setup-token";

/**
 * One-time cleanup: removes the Keychain item the retired `claude setup-token`
 * flow used to write. That item could only ever hold a `user:inference`-only
 * token (see the comment on `readClaudeCliKeychainCredential`), so leaving it
 * around only risks confusing future debugging. Safe to call on every launch —
 * a missing item is not an error.
 */
export const removeLegacySetupTokenKeychainItem = async (): Promise<void> => {
  if (process.platform !== "darwin") {
    return;
  }
  try {
    await execFileAsync("security", ["delete-generic-password", "-s", LEGACY_SETUP_TOKEN_KEYCHAIN_SERVICE]);
  } catch {
    // Nothing to remove, or already removed.
  }
};

// sql.js loads the whole db file into the JS heap; beyond this size that becomes
// slow/memory-heavy enough to effectively hang, so fall back to the sqlite3 CLI instead.
const CURSOR_STATE_DB_LARGE_FILE_THRESHOLD_BYTES = 150 * 1024 * 1024;
let sqlJsPromise: Promise<SqlJsStatic> | null = null;

class CursorStateDbTooLargeError extends Error {}

// A credential simply isn't there yet (never logged in, or logged out) — the
// ordinary, expected case. Distinguished from every other read failure via
// `instanceof` rather than by matching on message text, so the message itself
// is free to be localized without breaking that classification.
export class CredentialMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialMissingError";
  }
}

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
// neither the surrounding blob nor the token's own claims declare one. `source`
// records which ranked source in readClaudeCredential handed it over, so a
// later 401 can be attributed to the right one.
export interface RawCredential {
  token: string;
  expiresAt: string | null;
  source: CredentialSource;
}

const toCredential = (
  token: string,
  explicitExpiryMs: number | null,
  source: CredentialSource
): RawCredential => ({
  token,
  expiresAt: toIsoOrNull(explicitExpiryMs ?? decodeJwtExpiryMs(token)),
  source
});

const parseCredentialFromRawText = (rawText: string, source: CredentialSource): RawCredential | null => {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const token = pickAccessTokenFromUnknown(parsed);
    return token ? toCredential(token, pickExpiresAtFromUnknown(parsed), source) : null;
  } catch {
    const token = pickAccessTokenFromUnknown(trimmed);
    return token ? toCredential(token, null, source) : null;
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
    const lang = await currentLanguage();
    throw new CursorStateDbTooLargeError(
      t(lang, "error.cursorStateDbTooLarge", { sizeMb, dbPath })
    );
  }
};

export const readCursorCredentialFromStateDbPath = async (dbPath: string): Promise<RawCredential> => {
  const { size } = await stat(dbPath);
  const raw =
    size > CURSOR_STATE_DB_LARGE_FILE_THRESHOLD_BYTES
      ? await readValueFromLargeStateDb(dbPath, CURSOR_ACCESS_TOKEN_KEY, size)
      : await runReadOnlySqliteQuery(dbPath, CURSOR_ACCESS_TOKEN_KEY);
  const credential = parseCredentialFromRawText(raw, "cursorStateDb");
  if (!credential) {
    const lang = await currentLanguage();
    throw new CredentialMissingError(t(lang, "error.cursorCredentialMissing"));
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
    if (error instanceof CursorStateDbTooLargeError || error instanceof CredentialMissingError) {
      throw error;
    }
    const lang = await currentLanguage();
    throw new Error(t(lang, "error.cursorCredentialReadFailed"));
  }
};

const uniqueStrings = (values: Array<string | null | undefined>): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
};

const readKeychainCredentialForService = async (
  service: string,
  account?: string
): Promise<RawCredential | null> => {
  if (process.platform !== "darwin") {
    return null;
  }

  let stdout: string;
  try {
    const args = [
      "find-generic-password",
      "-s",
      service
    ];
    if (account) {
      args.push("-a", account);
    }
    args.push("-w");
    ({ stdout } = await execFileAsync("security", args));
  } catch {
    // No such Keychain item for this service/account — genuinely not logged in.
    return null;
  }

  const credential = parseCredentialFromRawText(stdout, "keychain");
  if (credential && isClaudeOAuthToken(credential.token)) {
    return credential;
  }

  // The item exists but its contents don't look like a Claude OAuth token.
  // Thrown (not swallowed) so callers can tell this apart from "nothing in
  // Keychain at all" — e.g. a newer CLI version changed the storage shape.
  const lang = await currentLanguage();
  throw new Error(t(lang, "error.claudeKeychainFormatInvalid", { service }));
};

const readExistingKeychainAccount = async (service: string): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      service
    ]);
    const match = stdout.match(/"acct"<blob>="([^"]+)"/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
};

/**
 * Claude CLI interactive login (`Claude Code-credentials`) carries
 * `user:profile`, which the usage API requires. `claude setup-token` only
 * mints `user:inference` and can never call `/api/oauth/usage` — preferring
 * a saved setup-token therefore permanently breaks quota monitoring.
 * See anthropics/claude-code#22450 / #11985.
 */
const readClaudeCliKeychainCredential = async (): Promise<RawCredential | null> => {
  // readKeychainCredentialForService throws when it finds the Keychain item
  // but can't parse it as a valid token. Keep trying other accounts (the
  // item may just be filed under a different one), but remember the error so
  // it can be reported instead of a misleading "nothing found" once every
  // account has been tried.
  let invalidFormatError: Error | null = null;
  const tryRead = async (account?: string): Promise<RawCredential | null> => {
    try {
      return await readKeychainCredentialForService(CLAUDE_CLI_KEYCHAIN_SERVICE, account);
    } catch (error) {
      invalidFormatError = error instanceof Error ? error : new Error(String(error));
      return null;
    }
  };

  const direct = await tryRead();
  if (direct) {
    return direct;
  }

  const existingAccount = await readExistingKeychainAccount(CLAUDE_CLI_KEYCHAIN_SERVICE);
  for (const account of uniqueStrings([existingAccount, userInfo().username])) {
    const credential = await tryRead(account);
    if (credential) {
      return credential;
    }
  }

  if (invalidFormatError) {
    throw invalidFormatError;
  }
  return null;
};

export const peekClaudeKeychainCredential = async (): Promise<RawCredential | null> => {
  if (process.platform !== "darwin") {
    return null;
  }

  return readClaudeCliKeychainCredential();
};

export const readCursorCredential = async (): Promise<RawCredential> => {
  return readCursorCredentialFromStateDb();
};

export const readClaudeCredential = async (): Promise<RawCredential> => {
  const fromKeychain = await peekClaudeKeychainCredential();
  if (fromKeychain) {
    return fromKeychain;
  }

  const lang = await currentLanguage();
  throw new CredentialMissingError(t(lang, "error.claudeCredentialMissing"));
};

export const getCursorAccessToken = async (): Promise<string> => {
  return (await readCursorCredential()).token;
};

export const getClaudeCodeOAuthToken = async (): Promise<string> => {
  return (await readClaudeCredential()).token;
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

const CODEX_HOME_DEFAULT = ".codex";
const CODEX_AUTH_FILE = "auth.json";
const CODEX_CONFIG_FILE = "config.toml";
const CODEX_KEYRING_SERVICES = ["Codex Auth", "com.openai.codex", "Codex Auth Credentials"] as const;
// Public client id the official Codex CLI uses for ChatGPT OAuth refresh.
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_REFRESH_SKEW_MS = 60_000;

export const resolveCodexHome = (): string => {
  const custom = process.env.CODEX_HOME?.trim();
  if (custom) {
    return custom;
  }
  return join(homedir(), CODEX_HOME_DEFAULT);
};

export interface CodexAuthContext {
  token: string;
  accountId: string | null;
  expiresAt: string | null;
  source: CredentialSource;
}

let codexMemoryAuth: ParsedCodexAuth | null = null;

const toRawFromParsed = (parsed: ParsedCodexAuth): RawCredential => ({
  token: parsed.accessToken,
  expiresAt: parsed.expiresAtMs === null ? null : new Date(parsed.expiresAtMs).toISOString(),
  source: parsed.source
});

const isParsedFresh = (parsed: ParsedCodexAuth, nowMs = Date.now()): boolean =>
  parsed.expiresAtMs === null || parsed.expiresAtMs - CODEX_REFRESH_SKEW_MS > nowMs;

const readCodexAuthFile = async (): Promise<ParsedCodexAuth | null> => {
  try {
    const raw = await readFile(join(resolveCodexHome(), CODEX_AUTH_FILE), "utf-8");
    return parseCodexAuthJson(raw, "codexAuthFile");
  } catch {
    return null;
  }
};

const readCodexConfigStorePref = async (): Promise<"file" | "keyring" | "auto" | null> => {
  try {
    const raw = await readFile(join(resolveCodexHome(), CODEX_CONFIG_FILE), "utf-8");
    return parseCodexCredentialsStore(raw);
  } catch {
    return null;
  }
};

const peekCodexKeyringCredential = async (): Promise<ParsedCodexAuth | null> => {
  if (process.platform !== "darwin") {
    return null;
  }
  for (const service of CODEX_KEYRING_SERVICES) {
    try {
      const { stdout } = await execFileAsync("security", ["find-generic-password", "-s", service, "-w"]);
      const parsed = parseCodexAuthJson(stdout, "codexKeyring");
      if (parsed) {
        return parsed;
      }
    } catch {
      // Try the next known service name.
    }
  }
  return null;
};

const loadCodexAuthFromDisk = async (): Promise<ParsedCodexAuth> => {
  const pref = await readCodexConfigStorePref();
  const fromFile = await readCodexAuthFile();
  if (pref === "keyring") {
    const fromKeyring = await peekCodexKeyringCredential();
    if (fromKeyring) {
      return fromKeyring;
    }
    if (fromFile) {
      return fromFile;
    }
  } else {
    if (fromFile) {
      return fromFile;
    }
    if (pref !== "file") {
      const fromKeyring = await peekCodexKeyringCredential();
      if (fromKeyring) {
        return fromKeyring;
      }
    }
  }
  const lang = await currentLanguage();
  throw new CredentialMissingError(t(lang, "error.codexCredentialMissing"));
};

const applyParsedToMemory = (parsed: ParsedCodexAuth): ParsedCodexAuth => {
  codexMemoryAuth = parsed;
  return parsed;
};

/**
 * ChatGPT OAuth refresh. The new access token stays in process memory only —
 * this never writes ~/.codex/auth.json (phase 1 / scheme A).
 */
const refreshCodexAccessToken = async (refreshToken: string, source: CredentialSource): Promise<ParsedCodexAuth> => {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CODEX_OAUTH_CLIENT_ID
  });
  const response = await axios.post(CODEX_OAUTH_TOKEN_URL, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15_000
  });
  const data = (response.data ?? {}) as Record<string, unknown>;
  const accessToken = typeof data.access_token === "string" ? data.access_token.trim() : "";
  if (!accessToken) {
    const lang = await currentLanguage();
    throw new Error(t(lang, "error.codexTokenRefreshFailed"));
  }
  const nextRefresh =
    typeof data.refresh_token === "string" && data.refresh_token.trim() ? data.refresh_token.trim() : refreshToken;
  const expiresIn = typeof data.expires_in === "number" && Number.isFinite(data.expires_in) ? data.expires_in : null;
  const parsed: ParsedCodexAuth = {
    accessToken,
    refreshToken: nextRefresh,
    idToken: typeof data.id_token === "string" ? data.id_token : null,
    accountId: parseCodexAuthJson(JSON.stringify({ tokens: data }), source)?.accountId ?? null,
    expiresAtMs: expiresIn !== null ? Date.now() + expiresIn * 1000 : jwtExpiryMs(accessToken),
    source
  };
  return applyParsedToMemory(parsed);
};

const resolveFreshCodexAuth = async (): Promise<ParsedCodexAuth> => {
  if (codexMemoryAuth && isParsedFresh(codexMemoryAuth)) {
    return codexMemoryAuth;
  }

  const fromDisk = await loadCodexAuthFromDisk();
  if (isParsedFresh(fromDisk)) {
    return applyParsedToMemory(fromDisk);
  }

  if (fromDisk.refreshToken) {
    try {
      const refreshed = await refreshCodexAccessToken(fromDisk.refreshToken, fromDisk.source);
      if (!refreshed.accountId) {
        refreshed.accountId = fromDisk.accountId;
      }
      return refreshed;
    } catch {
      // Fall through to the expired disk token so credential-monitor can
      // surface expiry rather than a network blip.
    }
  }

  return applyParsedToMemory(fromDisk);
};

export const readCodexCredential = async (): Promise<RawCredential> => {
  return toRawFromParsed(await resolveFreshCodexAuth());
};

export const getCodexAuthContext = async (): Promise<CodexAuthContext> => {
  const parsed = await resolveFreshCodexAuth();
  return {
    token: parsed.accessToken,
    accountId: parsed.accountId,
    expiresAt: parsed.expiresAtMs === null ? null : new Date(parsed.expiresAtMs).toISOString(),
    source: parsed.source
  };
};

export const getCodexAccessToken = async (): Promise<string> => (await getCodexAuthContext()).token;

export const hasCodexAccessToken = async (): Promise<boolean> => {
  try {
    await getCodexAccessToken();
    return true;
  } catch {
    return false;
  }
};
