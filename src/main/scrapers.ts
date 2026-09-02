import type { CredentialSource, ErrorCode, ScrapeResult, ServiceType } from "@shared/types";
import { t } from "@shared/i18n";
import { SERVICE_LABELS } from "@main/config";
import {
  ClaudeLoginExpiredError,
  ClaudeRateLimitedError,
  ClaudeUsageScopeError,
  collectClaudeCodeQuota
} from "@main/collectors/claude-code";
import { CodexLoginExpiredError, collectCodexQuota } from "@main/collectors/codex";
import { collectCursorQuota } from "@main/collectors/cursor";
import { CredentialMissingError } from "@main/credential-provider";
import { settingsStore } from "@main/store";

const detectErrorCode = (error: unknown): ErrorCode | undefined => {
  if (error instanceof ClaudeLoginExpiredError) {
    return "claudeLoginExpired";
  }
  if (error instanceof ClaudeUsageScopeError) {
    return "claudeScopeInsufficient";
  }
  if (error instanceof ClaudeRateLimitedError) {
    return "claudeRateLimited";
  }
  if (error instanceof CodexLoginExpiredError) {
    return "codexLoginExpired";
  }
  return undefined;
};

// Only a confirmed auth/scope failure carries a source worth acting on; every
// other failure leaves it undefined so nothing downstream treats a network blip
// as proof of which credential was in play.
const detectCredentialSource = (error: unknown): CredentialSource | undefined => {
  if (error instanceof ClaudeLoginExpiredError) {
    return error.source;
  }
  if (error instanceof ClaudeUsageScopeError) {
    return error.source;
  }
  if (error instanceof CodexLoginExpiredError) {
    return error.source;
  }
  return undefined;
};

// Credential-monitor uses the same error type to classify a missing login;
// the UI already shows a dedicated hint for that case, so repeating it here
// as a scrape failure just adds noise.
const isMissingCredential = (error: unknown): boolean => error instanceof CredentialMissingError;

export const scrapeQuota = async (service: ServiceType): Promise<ScrapeResult> => {
  try {
    if (service === "cursor") {
      return await collectCursorQuota();
    }
    if (service === "codex") {
      return await collectCodexQuota();
    }
    return await collectClaudeCodeQuota();
  } catch (error) {
    const lang = settingsStore.get().language;
    const detail = error instanceof Error ? error.message : t(lang, "scrape.unknownError");
    return {
      remaining: null,
      total: null,
      unit: service === "cursor" ? "usd" : "percent",
      resetsAt: null,
      windows: [],
      message: isMissingCredential(error)
        ? ""
        : t(lang, "scrape.fetchFailed", { service: SERVICE_LABELS[service], detail }),
      isError: true,
      errorCode: detectErrorCode(error),
      credentialSource: detectCredentialSource(error)
    };
  }
};
