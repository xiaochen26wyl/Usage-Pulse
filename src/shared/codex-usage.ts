import type { Language, QuotaWindow, ScrapeResult } from "./types";
import { t } from "./i18n";
import { clampPercent, toIsoTime, toPercentField } from "./claude-usage";

/**
 * Parsing for the Codex / ChatGPT usage payload.
 *
 * Pure and free of any I/O so it can be unit-tested directly. Window identity
 * is decided by duration (5h / 7d), not by primary/secondary slot names —
 * those slots are not a stable mapping across plans.
 */

const SESSION_WINDOW_SECONDS = 5 * 60 * 60;
const WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60;
const DURATION_TOLERANCE = 0.12;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

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

const nearSeconds = (seconds: number, target: number): boolean =>
  Math.abs(seconds - target) / target <= DURATION_TOLERANCE;

const windowSeconds = (raw: Record<string, unknown>): number | null => {
  const seconds =
    toNumber(raw.limit_window_seconds) ??
    toNumber(raw.limitWindowSeconds) ??
    toNumber(raw.window_seconds) ??
    toNumber(raw.windowSeconds);
  if (seconds !== null && seconds > 0) {
    return seconds;
  }
  const minutes =
    toNumber(raw.limit_window_minutes) ??
    toNumber(raw.limitWindowMinutes) ??
    toNumber(raw.window_duration_mins) ??
    toNumber(raw.windowDurationMins);
  if (minutes !== null && minutes > 0) {
    return minutes * 60;
  }
  return null;
};

const usedPercentOf = (raw: Record<string, unknown>): number | null =>
  toPercentField(raw.used_percent) ??
  toPercentField(raw.usedPercent) ??
  toPercentField(raw.utilization) ??
  toPercentField(raw.percentUsed);

const resetsAtOf = (raw: Record<string, unknown>, nowMs: number): string | null => {
  const direct =
    toIsoTime(raw.reset_at) ??
    toIsoTime(raw.resetAt) ??
    toIsoTime(raw.resets_at) ??
    toIsoTime(raw.resetsAt);
  if (direct) {
    return direct;
  }
  const afterSeconds =
    toNumber(raw.reset_after_seconds) ?? toNumber(raw.resetAfterSeconds) ?? toNumber(raw.reset_after);
  if (afterSeconds !== null && afterSeconds >= 0) {
    return new Date(nowMs + afterSeconds * 1000).toISOString();
  }
  return null;
};

const rawNameOf = (raw: Record<string, unknown>): string =>
  `${raw.name ?? raw.id ?? raw.type ?? raw.model ?? raw.window ?? raw.limit ?? raw.key ?? ""}`.trim();

export const classifyCodexWindowKey = (seconds: number | null, rawName: string, usedSlot: "session" | "weekly" | null): string => {
  if (seconds !== null) {
    if (nearSeconds(seconds, SESSION_WINDOW_SECONDS) && usedSlot !== "session") {
      return "session";
    }
    if (nearSeconds(seconds, WEEKLY_WINDOW_SECONDS) && usedSlot !== "weekly") {
      return "weekly";
    }
  }
  const lower = rawName.toLowerCase();
  if (usedSlot !== "session") {
    if (lower.includes("five_hour") || lower.includes("five-hour") || lower.includes("5h") || lower === "primary") {
      if (seconds === null || nearSeconds(seconds, SESSION_WINDOW_SECONDS)) {
        return "session";
      }
    }
  }
  if (usedSlot !== "weekly") {
    if (lower.includes("seven_day") || lower.includes("weekly") || lower.includes("7d") || lower === "secondary") {
      if (seconds === null || nearSeconds(seconds, WEEKLY_WINDOW_SECONDS)) {
        return "weekly";
      }
    }
  }
  return slugFromName(rawName);
};

const slugFromName = (rawName: string): string => {
  const slug = rawName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "unknown";
};

const labelForKey = (key: string, rawName: string, lang: Language): string => {
  if (key === "session") {
    return t(lang, "window.label.session");
  }
  if (key === "weekly") {
    return t(lang, "window.label.weekly");
  }
  if (key === "code_review" || key.includes("code_review")) {
    return t(lang, "window.label.codexCodeReview");
  }
  return rawName.trim() || key;
};

export interface CodexNormalizedWindow {
  key: string;
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
  windowSeconds: number | null;
}

const parseWindowObject = (
  raw: Record<string, unknown>,
  lang: Language,
  nowMs: number,
  usedSlot: { session: boolean; weekly: boolean }
): CodexNormalizedWindow | null => {
  const usedPercent = usedPercentOf(raw);
  const seconds = windowSeconds(raw);
  const rawName = rawNameOf(raw);
  if (usedPercent === null && seconds === null && !rawName) {
    return null;
  }

  const reserved: "session" | "weekly" | null = usedSlot.session ? "session" : usedSlot.weekly ? "weekly" : null;
  let key = classifyCodexWindowKey(seconds, rawName, reserved);
  if (key === "session" && usedSlot.session) {
    key = slugFromName(rawName || `window_${seconds ?? "x"}`);
  }
  if (key === "weekly" && usedSlot.weekly) {
    key = slugFromName(rawName || `window_${seconds ?? "x"}`);
  }

  if (key === "session") {
    usedSlot.session = true;
  } else if (key === "weekly") {
    usedSlot.weekly = true;
  }

  return {
    key,
    label: labelForKey(key, rawName, lang),
    usedPercent,
    resetsAt: resetsAtOf(raw, nowMs),
    windowSeconds: seconds
  };
};

const looksLikeWindow = (raw: Record<string, unknown>): boolean =>
  usedPercentOf(raw) !== null || windowSeconds(raw) !== null || Boolean(raw.reset_at || raw.resetAt || raw.reset_after_seconds);

const collectFromValue = (
  value: unknown,
  lang: Language,
  nowMs: number,
  usedSlot: { session: boolean; weekly: boolean },
  into: CodexNormalizedWindow[],
  parentKey = ""
): void => {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectFromValue(entry, lang, nowMs, usedSlot, into, parentKey);
    }
    return;
  }
  const raw = asRecord(value);
  if (!raw) {
    return;
  }
  if (looksLikeWindow(raw)) {
    const named = parentKey && !rawNameOf(raw) ? { ...raw, name: parentKey } : raw;
    const parsed = parseWindowObject(named, lang, nowMs, usedSlot);
    if (parsed) {
      into.push(parsed);
    }
    return;
  }
  for (const [key, nested] of Object.entries(raw)) {
    if (key === "credits" || key === "spend_control" || key === "plan_type") {
      continue;
    }
    collectFromValue(nested, lang, nowMs, usedSlot, into, key);
  }
};

export const extractCodexWindows = (
  payload: Record<string, unknown>,
  lang: Language,
  nowMs = Date.now()
): CodexNormalizedWindow[] => {
  const windows: CodexNormalizedWindow[] = [];
  const usedSlot = { session: false, weekly: false };
  const rateLimit = asRecord(payload.rate_limit) ?? asRecord(payload.rateLimit) ?? asRecord(payload.rate_limits);
  if (rateLimit) {
    collectFromValue(rateLimit, lang, nowMs, usedSlot, windows);
  }
  collectFromValue(payload.additional_rate_limits ?? payload.additionalRateLimits, lang, nowMs, usedSlot, windows, "additional");
  collectFromValue(payload.code_review_rate_limit ?? payload.codeReviewRateLimit, lang, nowMs, usedSlot, windows, "code_review");
  // Some payloads nest everything at the top level without a rate_limit wrapper.
  if (windows.length === 0) {
    collectFromValue(payload, lang, nowMs, usedSlot, windows);
  }
  return windows;
};

export const formatCodexCreditsText = (payload: Record<string, unknown>, lang: Language): string | null => {
  const credits = asRecord(payload.credits);
  if (!credits) {
    return null;
  }
  if (credits.unlimited === true) {
    return t(lang, "window.codexCredits.unlimited");
  }
  const balance = credits.balance;
  const balanceText =
    typeof balance === "number" && Number.isFinite(balance)
      ? String(balance)
      : typeof balance === "string" && balance.trim()
        ? balance.trim()
        : credits.has_credits === true
          ? t(lang, "app.unknown")
          : "0";
  return t(lang, "window.codexCredits.balance", { balance: balanceText });
};

export const buildCodexScrapeResult = (
  payload: Record<string, unknown>,
  lang: Language,
  nowMs = Date.now()
): ScrapeResult => {
  const limits = extractCodexWindows(payload, lang, nowMs);
  const creditsText = formatCodexCreditsText(payload, lang);

  if (limits.length === 0 && !creditsText) {
    return {
      remaining: null,
      total: null,
      unit: "percent",
      resetsAt: null,
      windows: [],
      message: t(lang, "error.codexMissingFields"),
      source: "api",
      creditsText: null
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
      message: t(lang, "window.message.codexSource")
    };
  });

  const session = windows.find((window) => window.key === "session") ?? null;
  const weekly = windows.find((window) => window.key === "weekly") ?? null;
  const sessionRemaining = session?.remaining ?? null;
  const weeklyRemaining = weekly?.remaining ?? null;
  const remaining = sessionRemaining ?? weeklyRemaining;
  const sessionText = sessionRemaining === null ? "N/A" : `${Math.round(sessionRemaining)}%`;
  const weeklyText = weeklyRemaining === null ? "N/A" : `${Math.round(weeklyRemaining)}%`;

  return {
    remaining,
    total: remaining === null ? null : 100,
    unit: "percent",
    resetsAt: session?.resetsAt ?? null,
    weeklyResetAt: weekly?.resetsAt ?? null,
    windows,
    message: t(lang, "message.codexSummary", { session: sessionText, weekly: weeklyText }),
    source: "api",
    creditsText
  };
};
