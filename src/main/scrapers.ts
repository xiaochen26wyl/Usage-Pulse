import type { ScrapeResult, ServiceType } from "@shared/types";
import { t } from "@shared/i18n";
import { SERVICE_LABELS } from "@main/config";
import { collectClaudeCodeQuota } from "@main/collectors/claude-code";
import { collectCursorQuota } from "@main/collectors/cursor";
import { settingsStore } from "@main/store";

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
      isError: true
    };
  }
};
