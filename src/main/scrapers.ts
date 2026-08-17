import type { ScrapeResult, ServiceType } from "@shared/types";
import { SERVICE_LABELS } from "@main/config";
import { collectClaudeCodeQuota } from "@main/collectors/claude-code";
import { collectCursorQuota } from "@main/collectors/cursor";

export const scrapeQuota = async (service: ServiceType): Promise<ScrapeResult> => {
  try {
    if (service === "cursor") {
      return await collectCursorQuota();
    }
    return await collectClaudeCodeQuota();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return {
      remaining: null,
      total: null,
      unit: service === "cursor" ? "usd" : "percent",
      resetsAt: null,
      windows: [],
      message: `${SERVICE_LABELS[service]} 抓取失敗: ${message}`
    };
  }
};
