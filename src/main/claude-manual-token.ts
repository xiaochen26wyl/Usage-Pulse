import { isClaudeOAuthToken } from "@shared/claude-auth";
import { t } from "@shared/i18n";
import type { ClaudeTokenSaveResult, Language, ScrapeResult } from "@shared/types";

/**
 * The decision behind "paste a Claude token here": a token is stored only after
 * it has proved, in that same click, that it can actually read the usage API.
 *
 * This is deliberately the whole rule. Usage-Pulse has been bitten repeatedly by
 * inferring credential health locally — from a token's shape, from an expiry
 * timestamp, from whether a Keychain item exists — and then disagreeing with
 * what the API says a moment later. A token that cannot fetch data is not a
 * usable credential, no matter how healthy it looks, so it never reaches the
 * store and the user is told which of the possible refusals actually happened.
 *
 * Kept free of Electron imports so the branches below are directly testable.
 */

/** How the live validation attempt ended. */
export type ClaudeTokenProbe = { ok: true; result: ScrapeResult } | { ok: false; error: unknown };

/**
 * The checks that can be answered without spending an API request.
 *
 * Returns null when the token is worth spending a request on, and a refusal
 * otherwise — a shape that is definitely wrong should never cost a call to
 * Anthropic, nor look to them like a credential-stuffing attempt.
 */
export const preflightClaudeToken = (value: unknown, lang: Language): ClaudeTokenSaveResult | null => {
  const token = typeof value === "string" ? value.trim() : "";
  if (!token) {
    return { ok: false, code: "empty", message: t(lang, "claudeToken.empty") };
  }
  if (!isClaudeOAuthToken(token)) {
    return { ok: false, code: "formatInvalid", message: t(lang, "claudeToken.formatInvalid") };
  }
  return null;
};

/**
 * Errors cross module boundaries here, so they are matched by `name` rather than
 * `instanceof`: the collector owns the classes, and importing them would drag
 * electron-store into every test of this file.
 */
const rejectionFor = (error: unknown): { code: ClaudeTokenSaveResult["code"]; messageKey: string } => {
  const name = error instanceof Error ? error.name : "";
  if (name === "ClaudeUsageScopeError") {
    return { code: "scopeInsufficient", messageKey: "claudeToken.scopeInsufficient" };
  }
  if (name === "ClaudeLoginExpiredError") {
    return { code: "loginExpired", messageKey: "claudeToken.loginExpired" };
  }
  if (name === "ClaudeRateLimitedError") {
    // Rate limiting says nothing about the token. Refusing to store it is the
    // honest outcome: we were not able to verify it, and storing an unverified
    // token is exactly the guesswork this flow exists to remove.
    return { code: "rateLimited", messageKey: "claudeToken.rateLimited" };
  }
  return { code: "apiFailed", messageKey: "claudeToken.apiFailed" };
};

/**
 * Turns a validation attempt into "store it" or "refuse it, and say why".
 *
 * A 200 that carries no quota windows still counts as success: the token
 * answered the usage API, which is the only thing being tested here. The user
 * simply has no usage recorded yet, and the message says so instead of blaming
 * the credential.
 */
export const classifyClaudeTokenProbe = (probe: ClaudeTokenProbe, lang: Language): ClaudeTokenSaveResult => {
  if (probe.ok) {
    return {
      ok: true,
      message: probe.result.windows.length > 0 ? t(lang, "claudeToken.saved") : t(lang, "claudeToken.savedNoUsage")
    };
  }
  const { code, messageKey } = rejectionFor(probe.error);
  return { ok: false, code, message: t(lang, messageKey as Parameters<typeof t>[1]) };
};
