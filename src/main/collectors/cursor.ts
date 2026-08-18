import axios from "axios";
import type { QuotaWindow, ScrapeResult } from "@shared/types";
import { t } from "@shared/i18n";
import { getCursorAccessToken } from "@main/credential-provider";
import { settingsStore } from "@main/store";

const CURSOR_API_BASE = "https://api2.cursor.sh";

interface CursorPlanUsage {
  remaining?: number | string;
  limit?: number | string;
  includedSpend?: number | string;
  totalPercentUsed?: number | string;
}

interface CursorCurrentPeriodUsage {
  billingCycleEnd?: string | number;
  planUsage?: CursorPlanUsage;
}

interface CursorPlanInfoResponse {
  planInfo?: {
    includedAmountCents?: number | string;
  };
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

const toIsoTime = (value: unknown): string | null => {
  const numeric = toNumber(value);
  if (numeric !== null) {
    const ms = numeric > 1e12 ? numeric : numeric * 1000;
    const iso = new Date(ms).toISOString();
    return Number.isNaN(Date.parse(iso)) ? null : iso;
  }
  if (typeof value === "string" && value.trim()) {
    const iso = new Date(value).toISOString();
    return Number.isNaN(Date.parse(iso)) ? null : iso;
  }
  return null;
};

const centsToUsd = (value: number | null): number | null => {
  if (value === null) {
    return null;
  }
  return Math.round((value / 100) * 100) / 100;
};

const getPercent = (remaining: number | null, total: number | null): number | null => {
  if (remaining === null || total === null || total <= 0) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round((remaining / total) * 100)));
};

const cursorRequest = async <T>(path: string, token: string): Promise<T> => {
  const response = await axios.post(`${CURSOR_API_BASE}${path}`, {}, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1"
    },
    timeout: 15_000
  });
  return response.data as T;
};

const extractUsagePayload = (raw: CursorCurrentPeriodUsage): CursorCurrentPeriodUsage => {
  const body = raw as Record<string, unknown>;
  if (body.planUsage) {
    return raw;
  }
  if (body.message && typeof body.message === "object") {
    return body.message as CursorCurrentPeriodUsage;
  }
  return raw;
};

export const collectCursorQuota = async (): Promise<ScrapeResult> => {
  const lang = settingsStore.get().language;
  const token = await getCursorAccessToken();

  let usage: CursorCurrentPeriodUsage;
  try {
    usage = extractUsagePayload(await cursorRequest<CursorCurrentPeriodUsage>("/aiserver.v1.DashboardService/GetCurrentPeriodUsage", token));
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 401) {
      throw new Error(t(lang, "error.cursorLoginExpired"));
    }
    throw new Error(t(lang, "error.cursorApiFailed"));
  }

  const planUsage = usage.planUsage || {};
  const includedSpend = toNumber(planUsage.includedSpend);
  let limit = toNumber(planUsage.limit);
  let remaining = toNumber(planUsage.remaining);

  if ((limit === null || limit <= 0) && remaining !== null && includedSpend !== null) {
    limit = remaining + includedSpend;
  }

  if (limit === null || limit <= 0) {
    try {
      const planInfoRaw = await cursorRequest<CursorPlanInfoResponse>("/aiserver.v1.DashboardService/GetPlanInfo", token);
      const planInfo = (planInfoRaw as Record<string, unknown>).message as CursorPlanInfoResponse | undefined;
      const includedAmount = toNumber(planInfo?.planInfo?.includedAmountCents ?? planInfoRaw.planInfo?.includedAmountCents);
      if (includedAmount !== null && includedAmount > 0) {
        limit = includedAmount;
      }
    } catch {
      // no-op: we can still return partial usage without plan info.
    }
  }

  if (remaining === null && limit !== null && includedSpend !== null) {
    remaining = Math.max(0, limit - includedSpend);
  }

  const remainingUsd = centsToUsd(remaining);
  const totalUsd = centsToUsd(limit);
  const percent = getPercent(remainingUsd, totalUsd);
  const resetsAt = toIsoTime(usage.billingCycleEnd);
  const windows: QuotaWindow[] = [
    {
      key: "billing_cycle",
      label: t(lang, "window.label.billingCycle"),
      remaining: remainingUsd,
      total: totalUsd,
      percent,
      resetsAt,
      message: t(lang, "window.message.cursorSource")
    }
  ];

  if (remainingUsd === null && totalUsd === null) {
    return {
      remaining: null,
      total: null,
      unit: "usd",
      resetsAt,
      windows,
      message: t(lang, "error.cursorMissingFields")
    };
  }

  const remainingText = remainingUsd === null ? "N/A" : `$${remainingUsd.toFixed(2)}`;
  const totalText = totalUsd === null ? "N/A" : `$${totalUsd.toFixed(2)}`;
  const percentUsed = toNumber(planUsage.totalPercentUsed);
  const suffix = percentUsed === null ? "" : t(lang, "message.cursorUsedSuffix", { percent: Math.round(percentUsed) });

  return {
    remaining: remainingUsd,
    total: totalUsd,
    unit: "usd",
    resetsAt,
    windows,
    message: t(lang, "message.cursorSummary", { remaining: remainingText, total: totalText, suffix })
  };
};
