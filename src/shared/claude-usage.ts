import type { Language } from "./types";
import { t } from "./i18n";

// The payload has used both camelCase and snake_case for the same field over
// time, and the window keys it ships (`five_hour`, `seven_day_all`) show the
// snake_case form is the live one — so `resets_at` has to be in this list, not
// just its camelCase spelling.
const RESET_FIELDS = ["resetsAt", "resets_at", "resetAt", "reset_at", "resetTime", "reset_time"] as const;

const pickReset = (source: Record<string, unknown>): string | null => {
  for (const field of RESET_FIELDS) {
    const parsed = toIsoTime(source[field]);
    if (parsed) {
      return parsed;
    }
  }
  return null;
};

/**
 * Parsing for the Claude Code usage payload.
 *
 * Pure and free of any I/O so it can be unit-tested directly; the collector in
 * src/main owns the HTTP call and the credential, and nothing else.
 */
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

export const clampPercent = (value: number): number => Math.max(0, Math.min(100, value));

/**
 * A field that already counts in percent (0-100).
 *
 * This used to guess the scale with `num <= 1 ? num * 100 : num`, which read a
 * genuine 1 % as 100 % and manufactured a "quota used up" alarm out of a window
 * that had barely been touched — exactly the state a window is in just after a
 * reset, or just after a credential is first read. Percent-named fields are now
 * taken at face value and only the explicitly fractional field is scaled.
 */
export const toPercentField = (value: unknown): number | null => {
  const num = toNumber(value);
  return num === null ? null : clampPercent(num);
};

/** A field that counts in 0-1 (`ratio`), scaled up to percent. */
export const toRatioField = (value: unknown): number | null => {
  const num = toNumber(value);
  return num === null ? null : clampPercent(num * 100);
};

export interface NormalizedLimit {
  key: string;
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
}

export const toIsoTime = (value: unknown): string | null => {
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

export const detectLimitKey = (raw: string): string => {
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

export const parseLimitObject = (rawLimit: Record<string, unknown>, lang: Language): NormalizedLimit | null => {
  const rawKey =
    `${rawLimit.name ?? rawLimit.id ?? rawLimit.type ?? rawLimit.window ?? rawLimit.limit ?? rawLimit.key ?? ""}`.trim();
  const key = detectLimitKey(rawKey);
  const usedPercent =
    toPercentField(rawLimit.utilization) ??
    toPercentField(rawLimit.percentUsed) ??
    toPercentField(rawLimit.usedPercent) ??
    toPercentField(rawLimit.utilisation) ??
    toRatioField(rawLimit.ratio);

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
    resetsAt: pickReset(rawLimit)
  };
};

const parseLegacyLimit = (key: string, rawValue: unknown, lang: Language): NormalizedLimit | null => {
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }

  const item = rawValue as Record<string, unknown>;
  const usedPercent =
    toPercentField(item.utilization) ?? toPercentField(item.percentUsed) ?? toPercentField(item.usedPercent);
  if (usedPercent === null) {
    return null;
  }

  return {
    key,
    label: labelForKey(key, lang),
    usedPercent,
    resetsAt: pickReset(item)
  };
};

export const extractLimits = (payload: Record<string, unknown>, lang: Language): NormalizedLimit[] => {
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

export const selectPrimaryLimits = (limits: NormalizedLimit[]): { session: NormalizedLimit | null; weekly: NormalizedLimit | null } => {
  const session = limits.find((item) => item.key === "session") || null;
  const weekly =
    limits.find((item) => item.key === "weekly_all") ||
    limits.find((item) => item.key === "weekly_scoped") ||
    limits.find((item) => item.key === "weekly") ||
    null;
  return { session, weekly };
};
