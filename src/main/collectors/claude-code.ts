import axios from "axios";
import type { Language, QuotaWindow, ScrapeResult } from "@shared/types";
import { t } from "@shared/i18n";
import { getClaudeCodeOAuthToken } from "@main/credential-provider";
import { settingsStore } from "@main/store";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export class ClaudeLoginExpiredError extends Error {}

interface NormalizedLimit {
  key: string;
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
}

const toNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
};

const clampPercent = (value: number): number => Math.max(0, Math.min(100, value));

const toUsedPercent = (value: unknown): number | null => {
  const num = toNumber(value);
  if (num === null) {
    return null;
  }
  if (num <= 1) {
    return clampPercent(num * 100);
  }
  return clampPercent(num);
};

const toIsoTime = (value: unknown): string | null => {
  const numeric = toNumber(value);
  if (numeric !== null) {
    const ms = numeric > 1e12 ? numeric : numeric * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
};

const detectLimitKey = (raw: string): string => {
  const key = raw.toLowerCase();
  if (key.includes("session") || key.includes("five")) {
    return "session";
  }
  if (key.includes("weekly_all") || key.includes("seven_day_all")) {
    return "weekly_all";
  }
  if (key.includes("weekly_scoped")) {
    return "weekly_scoped";
  }
  if (key.includes("weekly") || key.includes("seven_day")) {
    return "weekly";
  }
  return key || "unknown";
};

const labelForKey = (key: string, lang: Language): string => {
  if (key === "session") {
    return t(lang, "window.label.session");
  }
  if (key === "weekly_all") {
    return t(lang, "window.label.weeklyAll");
  }
  if (key === "weekly_scoped") {
    return t(lang, "window.label.weeklyScoped");
  }
  if (key === "weekly") {
    return t(lang, "window.label.weekly");
  }
  return key;
};

const parseLimitObject = (rawLimit: Record<string, unknown>, lang: Language): NormalizedLimit | null => {
  const rawKey =
    `${rawLimit.name ?? rawLimit.id ?? rawLimit.type ?? rawLimit.window ?? rawLimit.limit ?? rawLimit.key ?? ""}`.trim();
  const key = detectLimitKey(rawKey);
  const usedPercent =
    toUsedPercent(rawLimit.utilization) ??
    toUsedPercent(rawLimit.percentUsed) ??
    toUsedPercent(rawLimit.usedPercent) ??
    toUsedPercent(rawLimit.utilisation) ??
    toUsedPercent(rawLimit.ratio);

  let finalUsed = usedPercent;
  if (finalUsed === null) {
    const remaining = toNumber(rawLimit.remaining);
    const total = toNumber(rawLimit.total);
    if (remaining !== null && total !== null && total > 0) {
      finalUsed = clampPercent(((total - remaining) / total) * 100);
    }
  }

  if (finalUsed === null && key === "unknown") {
    return null;
  }

  return {
    key,
    label: labelForKey(key, lang),
    usedPercent: finalUsed,
    resetsAt: toIsoTime(rawLimit.resetsAt ?? rawLimit.resetAt ?? rawLimit.reset_at)
  };
};

const parseLegacyLimit = (key: string, rawValue: unknown, lang: Language): NormalizedLimit | null => {
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }

  const item = rawValue as Record<string, unknown>;
  const usedPercent =
    toUsedPercent(item.utilization) ?? toUsedPercent(item.percentUsed) ?? toUsedPercent(item.usedPercent);
  if (usedPercent === null) {
    return null;
  }

  return {
    key,
    label: labelForKey(key, lang),
    usedPercent,
    resetsAt: toIsoTime(item.resetsAt ?? item.resetAt ?? item.reset_at)
  };
};

const extractLimits = (payload: Record<string, unknown>, lang: Language): NormalizedLimit[] => {
  const limits: NormalizedLimit[] = [];
  const limitsRaw = payload.limits;
  if (Array.isArray(limitsRaw)) {
    for (const entry of limitsRaw) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const parsed = parseLimitObject(entry as Record<string, unknown>, lang);
      if (parsed) {
        limits.push(parsed);
      }
    }
  }

  if (limits.length > 0) {
    return limits;
  }

  const legacyCandidates: Array<[string, unknown]> = [
    ["session", payload.five_hour ?? payload.fiveHour ?? payload.session],
    ["weekly_all", payload.weekly_all ?? payload.seven_day_all ?? payload.sevenDayAll],
    ["weekly", payload.weekly ?? payload.seven_day ?? payload.sevenDay]
  ];

  for (const [key, raw] of legacyCandidates) {
    const parsed = parseLegacyLimit(key, raw, lang);
    if (parsed) {
      limits.push(parsed);
    }
  }

  return limits;
};

const selectPrimaryLimits = (limits: NormalizedLimit[]): { session: NormalizedLimit | null; weekly: NormalizedLimit | null } => {
  const session = limits.find((item) => item.key === "session") || null;
  const weekly =
    limits.find((item) => item.key === "weekly_all") ||
    limits.find((item) => item.key === "weekly_scoped") ||
    limits.find((item) => item.key === "weekly") ||
    null;
  return { session, weekly };
};

export const collectClaudeCodeQuota = async (): Promise<ScrapeResult> => {
  const lang = settingsStore.get().language;
  const token = await getClaudeCodeOAuthToken();

  let payload: Record<string, unknown>;
  try {
    const response = await axios.get(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-code/"
      },
      timeout: 15_000
    });
    payload = response.data as Record<string, unknown>;
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

  const limits = extractLimits(payload, lang);
  if (limits.length === 0) {
    return {
      remaining: null,
      total: null,
      unit: "percent",
      resetsAt: null,
      windows: [],
      message: t(lang, "error.claudeMissingFields")
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
  const sessionUsed = session?.usedPercent ?? null;
  const weeklyUsed = weekly?.usedPercent ?? null;
  // "Low quota" for Claude Code means the 5-hour session window specifically,
  // not whichever of session/weekly happens to be worse — weekly is only a
  // fallback for when the session window itself has no data.
  const primaryUsed = sessionUsed ?? weeklyUsed ?? 0;
  const hasPrimary = sessionUsed !== null || weeklyUsed !== null;
  const remaining = hasPrimary ? clampPercent(100 - primaryUsed) : null;
  const resetsAt = session?.resetsAt ?? weekly?.resetsAt ?? null;

  const sessionText = sessionUsed === null ? "N/A" : `${Math.round(clampPercent(100 - sessionUsed))}%`;
  const weeklyText = weeklyUsed === null ? "N/A" : `${Math.round(clampPercent(100 - weeklyUsed))}%`;

  return {
    remaining,
    total: hasPrimary ? 100 : null,
    unit: "percent",
    resetsAt,
    weeklyResetAt: weekly?.resetsAt ?? null,
    windows,
    message: t(lang, "message.claudeSummary", { session: sessionText, weekly: weeklyText })
  };
};
