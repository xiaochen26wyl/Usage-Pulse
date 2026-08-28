import type { CredentialSource, ErrorCode, ScrapeResult, ServiceType } from "@shared/types";
import { t } from "@shared/i18n";
import { SERVICE_LABELS } from "@main/config";
import { ClaudeLoginExpiredError, collectClaudeCodeQuota } from "@main/collectors/claude-code";
import { collectCursorQuota } from "@main/collectors/cursor";
import { settingsStore } from "@main/store";

const detectErrorCode = (error: unknown): ErrorCode | undefined => {
  if (error instanceof ClaudeLoginExpiredError) {
    return "claudeLoginExpired";
  }
  return undefined;
};

// Only a confirmed 401 carries a source worth acting on; every other failure
// leaves it undefined so nothing downstream treats a network blip as proof of
// which credential was in play.
const detectCredentialSource = (error: unknown): CredentialSource | undefined =>
  error instanceof ClaudeLoginExpiredError ? error.source : undefined;

export const scrapeQuota = async (service: ServiceType): Promise<ScrapeResult> => {
  try {
    if (service === "cursor") {
      return await collectCursorQuota();
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
      message: t(lang, "scrape.fetchFailed", { service: SERVICE_LABELS[service], detail }),
      isError: true,
      errorCode: detectErrorCode(error),
      credentialSource: detectCredentialSource(error)
    };
  }
};
