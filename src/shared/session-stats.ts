import type {
  CombinedSnapshot,
  QuotaWindow,
  SessionMetricDelta,
  SessionUsageDeltas,
  WaterCupSizeMl
} from "@shared/types";
import { isWaterCupSizeMl } from "@shared/water";

const RESET_EPS_USD = 0.005;
const RESET_EPS_PERCENT = 0.5;

const findWindow = (windows: QuotaWindow[] | undefined, key: string): QuotaWindow | undefined =>
  windows?.find((window) => window.key === key);

const findWeeklyWindow = (windows: QuotaWindow[] | undefined): QuotaWindow | undefined =>
  windows?.find((window) => window.key === "weekly" || window.key.startsWith("weekly"));

const remainingDrop = (
  key: SessionMetricDelta["key"],
  unit: SessionMetricDelta["unit"],
  baseline: number | null | undefined,
  current: number | null | undefined,
  eps: number
): SessionMetricDelta => {
  if (baseline == null || current == null || !Number.isFinite(baseline) || !Number.isFinite(current)) {
    return { key, kind: "unknown", used: null, unit };
  }
  if (current > baseline + eps) {
    return { key, kind: "reset", used: null, unit };
  }
  return { key, kind: "consumed", used: Math.max(0, baseline - current), unit };
};

const usedPercentRise = (
  key: SessionMetricDelta["key"],
  baseline: number | null | undefined,
  current: number | null | undefined
): SessionMetricDelta => {
  if (baseline == null || current == null || !Number.isFinite(baseline) || !Number.isFinite(current)) {
    return { key, kind: "unknown", used: null, unit: "percent" };
  }
  if (current < baseline - RESET_EPS_PERCENT) {
    return { key, kind: "reset", used: null, unit: "percent" };
  }
  return { key, kind: "consumed", used: Math.max(0, current - baseline), unit: "percent" };
};

export const computeSessionUsage = (
  baseline: CombinedSnapshot | null | undefined,
  current: CombinedSnapshot | null | undefined
): SessionUsageDeltas => {
  const baseCursor = baseline?.cursor;
  const curCursor = current?.cursor;
  const baseClaude = baseline?.claude;
  const curClaude = current?.claude;
  const baseCodex = baseline?.codex;
  const curCodex = current?.codex;

  const baseBilling = findWindow(baseCursor?.windows, "billing_cycle");
  const curBilling = findWindow(curCursor?.windows, "billing_cycle");
  const billingRemainingBase = baseBilling?.remaining ?? baseCursor?.remaining ?? null;
  const billingRemainingCur = curBilling?.remaining ?? curCursor?.remaining ?? null;

  const baseWeekly = findWeeklyWindow(baseClaude?.windows);
  const curWeekly = findWeeklyWindow(curClaude?.windows);
  const sessionBase = findWindow(baseClaude?.windows, "session");
  const sessionCur = findWindow(curClaude?.windows, "session");
  const baseCodexWeekly = findWeeklyWindow(baseCodex?.windows);
  const curCodexWeekly = findWeeklyWindow(curCodex?.windows);
  const codexSessionBase = findWindow(baseCodex?.windows, "session");
  const codexSessionCur = findWindow(curCodex?.windows, "session");

  return {
    billing: remainingDrop(
      "billing",
      "usd",
      billingRemainingBase,
      billingRemainingCur,
      RESET_EPS_USD
    ),
    cursorModels: usedPercentRise(
      "cursorModels",
      findWindow(baseCursor?.windows, "cursor_models")?.percent,
      findWindow(curCursor?.windows, "cursor_models")?.percent
    ),
    advancedModels: usedPercentRise(
      "advancedModels",
      findWindow(baseCursor?.windows, "other_models")?.percent,
      findWindow(curCursor?.windows, "other_models")?.percent
    ),
    claudeSession: remainingDrop(
      "claudeSession",
      "percent",
      sessionBase?.remaining ?? baseClaude?.remaining ?? null,
      sessionCur?.remaining ?? curClaude?.remaining ?? null,
      RESET_EPS_PERCENT
    ),
    claudeWeekly: remainingDrop(
      "claudeWeekly",
      "percent",
      baseWeekly?.remaining ?? null,
      curWeekly?.remaining ?? null,
      RESET_EPS_PERCENT
    ),
    codexSession: remainingDrop(
      "codexSession",
      "percent",
      codexSessionBase?.remaining ?? baseCodex?.remaining ?? null,
      codexSessionCur?.remaining ?? curCodex?.remaining ?? null,
      RESET_EPS_PERCENT
    ),
    codexWeekly: remainingDrop(
      "codexWeekly",
      "percent",
      baseCodexWeekly?.remaining ?? null,
      curCodexWeekly?.remaining ?? null,
      RESET_EPS_PERCENT
    )
  };
};

export const addWaterCup = (
  state: { waterMl: number; waterCups: number },
  sizeMl: unknown
): { waterMl: number; waterCups: number } => {
  if (!isWaterCupSizeMl(sizeMl)) {
    return state;
  }
  return {
    waterMl: state.waterMl + sizeMl,
    waterCups: state.waterCups + 1
  };
};

export const formatWaterCup = (sizeMl: WaterCupSizeMl): string =>
  sizeMl === 1000 ? "1 L" : `${sizeMl} ml`;
