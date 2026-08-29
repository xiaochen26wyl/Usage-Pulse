import type { CredentialSource } from "./types";

/**
 * Pure parsing for Codex CLI auth blobs (`~/.codex/auth.json` or the same
 * JSON stored in the OS keyring). No I/O: the credential provider owns the
 * file/keyring read and the in-memory refresh.
 */

const CHATGPT_ACCOUNT_CLAIM = "https://api.openai.com/auth.chatgpt_account_id";

export interface ParsedCodexAuth {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  accountId: string | null;
  expiresAtMs: number | null;
  source: CredentialSource;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const decodeBase64Url = (segment: string): string => {
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return atob(normalized + pad);
};

export const decodeJwtPayload = (token: string): Record<string, unknown> | null => {
  const segments = token.split(".");
  if (segments.length < 2) {
    return null;
  }
  try {
    return asRecord(JSON.parse(decodeBase64Url(segments[1])));
  } catch {
    return null;
  }
};

export const jwtExpiryMs = (token: string): number | null => {
  const payload = decodeJwtPayload(token);
  const exp = payload?.exp;
  return typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
};

const jwtAccountId = (token: string | null): string | null => {
  if (!token) {
    return null;
  }
  const payload = decodeJwtPayload(token);
  if (!payload) {
    return null;
  }
  const claim = payload[CHATGPT_ACCOUNT_CLAIM];
  const nested = asRecord(payload["https://api.openai.com/auth"]);
  return (
    asNonEmptyString(claim) ??
    asNonEmptyString(nested?.chatgpt_account_id) ??
    asNonEmptyString(payload.chatgpt_account_id) ??
    asNonEmptyString(payload.account_id)
  );
};

const pickTokensObject = (root: Record<string, unknown>): Record<string, unknown> => {
  const nested = asRecord(root.tokens);
  return nested ?? root;
};

/**
 * Turns a Codex auth.json (or keyring) JSON blob into tokens + account id.
 * `source` is stamped by the caller so a later 401 can name the right store.
 */
export const parseCodexAuthJson = (rawText: string, source: CredentialSource): ParsedCodexAuth | null => {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const root = asRecord(parsed);
  if (!root) {
    return null;
  }

  const tokens = pickTokensObject(root);
  const accessToken =
    asNonEmptyString(tokens.access_token) ??
    asNonEmptyString(tokens.accessToken) ??
    asNonEmptyString(root.access_token) ??
    asNonEmptyString(root.accessToken);
  if (!accessToken) {
    return null;
  }

  const refreshToken =
    asNonEmptyString(tokens.refresh_token) ??
    asNonEmptyString(tokens.refreshToken) ??
    asNonEmptyString(root.refresh_token);
  const idToken =
    asNonEmptyString(tokens.id_token) ?? asNonEmptyString(tokens.idToken) ?? asNonEmptyString(root.id_token);

  const accountId =
    asNonEmptyString(root.account_id) ??
    asNonEmptyString(root.accountId) ??
    asNonEmptyString(tokens.account_id) ??
    jwtAccountId(idToken) ??
    jwtAccountId(accessToken);

  return {
    accessToken,
    refreshToken,
    idToken,
    accountId,
    expiresAtMs: jwtExpiryMs(accessToken),
    source
  };
};

export const parseCodexCredentialsStore = (configToml: string): "file" | "keyring" | "auto" | null => {
  const match = configToml.match(/cli_auth_credentials_store\s*=\s*["'](file|keyring|auto)["']/i);
  if (!match) {
    return null;
  }
  const value = match[1].toLowerCase();
  if (value === "file" || value === "keyring" || value === "auto") {
    return value;
  }
  return null;
};
