import axios from "axios";
import type { Language, QuotaWindow, ScrapeResult } from "@shared/types";
import { t } from "@shared/i18n";
import { clampPercent, extractLimits, selectPrimaryLimits } from "@shared/claude-usage";
import { latestFutureReset, readClaudeCliQuotaEvents } from "@main/collectors/claude-cli-log";
import { getClaudeCodeOAuthToken } from "@main/credential-provider";
import { settingsStore } from "@main/store";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

// Wider than the 5-hour window, so a rejection recorded at its start is still
// in scope when we go looking for the reset time it carried.
const CLI_LOG_LOOKBACK_MS = 8 * 60 * 60_000;

const SESSION_LIMIT_TYPES = ["five_hour", "session"];
const WEEKLY_LIMIT_TYPES = ["seven_day", "seven_day_all", "weekly"];

interface CliResetTimes {
  session: string | null;
  weekly: string | null;
}

/**
 * Reset times recovered from the CLI's own logs, for the windows the API left
 * blank. Best effort in every sense: a failure here just means we carry on
 * without a reset time, exactly as before.
 */
const readCliResetTimes = async (needSession: boolean, needWeekly: boolean): Promise<CliResetTimes> => {
  if (!needSession && !needWeekly) {
    return { session: null, weekly: null };
  }
  try {
    const nowMs = Date.now();
    const events = await readClaudeCliQuotaEvents(nowMs - CLI_LOG_LOOKBACK_MS);
    return {
      session: needSession ? latestFutureReset(events, SESSION_LIMIT_TYPES, nowMs) : null,
      weekly: needWeekly ? latestFutureReset(events, WEEKLY_LIMIT_TYPES, nowMs) : null
    };
  } catch {
    return { session: null, weekly: null };
  }
};

export class ClaudeLoginExpiredError extends Error {}

const fetchUsagePayload = async (token: string, lang: Language): Promise<Record<string, unknown>> => {
  try {
    const response = await axios.get(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-code/"
      },
      timeout: 15_000
    });
    return response.data as Record<string, unknown>;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 401) {
        throw new ClaudeLoginExpiredError(t(lang, "error.claudeLoginExpired"));
      }
      if (error.response?.status === 429) {
        throw new Error(t(lang, "error.claudeRateLimited"));
      }
    }
    throw new Error(t(lang, "error.claudeApiFailed"));
  }
};

/**
 * Proves a hand-pasted token actually works before it is stored.
 *
 * A token that fails here is never written anywhere, so a typo cannot quietly
 * outrank the automatic sources and make the situation worse than it was.
 */
export const validateClaudeOAuthToken = async (token: string): Promise<void> => {
  const lang = settingsStore.get().language;
  const payload = await fetchUsagePayload(token, lang);
  if (extractLimits(payload, lang).length === 0) {
    throw new Error(t(lang, "error.claudeMissingFields"));
  }
};

export const collectClaudeCodeQuota = async (): Promise<ScrapeResult> => {
  const lang = settingsStore.get().language;
  const token = await getClaudeCodeOAuthToken();
  const payload = await fetchUsagePayload(token, lang);

  const limits = extractLimits(payload, lang);
  if (limits.length === 0) {
    return {
      remaining: null,
      total: null,
      unit: "percent",
      resetsAt: null,
      windows: [],
      message: t(lang, "error.claudeMissingFields"),
      source: "api"
    };
  }

  const windows: QuotaWindow[] = limits.map((item) => {
    const remaining = item.usedPercent === null ? null : clampPercent(100 - item.usedPercent);
    return {
      key: item.key,
      label: item.label,
      remaining,
      total: item.usedPercent === null ? null : 100,
      percent: remaining,
      resetsAt: item.resetsAt,
      message: t(lang, "window.message.claudeSource")
    };
  });

  const { session, weekly } = selectPrimaryLimits(limits);

  // The usage API does not always return a reset time. Without one there is no
  // reset alarm to arm and no cooldown countdown to show, so fall back to what
  // the CLI recorded locally before giving up on it.
  const cliResets = settingsStore.get().claudeUseLocalSessionLogs
    ? await readCliResetTimes(!session?.resetsAt, !weekly?.resetsAt)
    : { session: null, weekly: null };

  const sessionResetsAt = session?.resetsAt ?? cliResets.session;
  const weeklyResetsAt = weekly?.resetsAt ?? cliResets.weekly;

  for (const window of windows) {
    if (window.resetsAt) {
      continue;
    }
    if (window.key === "session") {
      window.resetsAt = sessionResetsAt;
    } else if (window.key.startsWith("weekly")) {
      window.resetsAt = weeklyResetsAt;
    }
  }

  const sessionUsed = session?.usedPercent ?? null;
  const weeklyUsed = weekly?.usedPercent ?? null;
  // "Low quota" for Claude Code means the 5-hour session window specifically,
  // not whichever of session/weekly happens to be worse — weekly is only a
  // fallback for when the session window itself has no data.
  const primaryUsed = sessionUsed ?? weeklyUsed ?? 0;
  const hasPrimary = sessionUsed !== null || weeklyUsed !== null;
  const remaining = hasPrimary ? clampPercent(100 - primaryUsed) : null;
  const resetsAt = sessionResetsAt ?? weeklyResetsAt;

  const sessionText = sessionUsed === null ? "N/A" : `${Math.round(clampPercent(100 - sessionUsed))}%`;
  const weeklyText = weeklyUsed === null ? "N/A" : `${Math.round(clampPercent(100 - weeklyUsed))}%`;

  return {
    remaining,
    total: hasPrimary ? 100 : null,
    unit: "percent",
    resetsAt,
    weeklyResetAt: weeklyResetsAt,
    windows,
    message: t(lang, "message.claudeSummary", { session: sessionText, weekly: weeklyText }),
    source: cliResets.session || cliResets.weekly ? "cli-log" : "api"
  };
};
