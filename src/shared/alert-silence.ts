// Silence a usage alert until its quota window restores. Official reset times
// come from Cursor's billing cycle or Claude Code's session / weekly windows.
// The 5-hour fallback is only for Claude Code's session window (it starts at
// the first message and lasts five hours); Cursor and weekly must not guess.

export const CLAUDE_SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;

export type RestoreKind = "billing" | "session" | "weekly";

export interface AlertSilenceRecord {
  key: string;
  at: string;
  restoreAt?: string | null;
}

export const UNKNOWN_CYCLE_KEY = "unknown";
export const ESTIMATED_CYCLE_KEY = "estimated";

export const resolveRestoreAt = (options: {
  kind: RestoreKind;
  officialResetAt: string | null | undefined;
  nowMs: number;
}): string | null => {
  if (options.officialResetAt) {
    return options.officialResetAt;
  }
  if (options.kind === "session") {
    return new Date(options.nowMs + CLAUDE_SESSION_WINDOW_MS).toISOString();
  }
  return null;
};

export const cycleKeyFor = (
  officialResetAt: string | null | undefined,
  restoreAt: string | null
): string => {
  if (officialResetAt) {
    return officialResetAt;
  }
  if (restoreAt) {
    return ESTIMATED_CYCLE_KEY;
  }
  return UNKNOWN_CYCLE_KEY;
};

const isOfficialCycleKey = (key: string): boolean =>
  key !== UNKNOWN_CYCLE_KEY && key !== ESTIMATED_CYCLE_KEY;

export const isSilencedUntilRestore = (
  last: AlertSilenceRecord | null | undefined,
  currentCycleKey: string | null | undefined,
  nowMs: number
): boolean => {
  if (!last?.key) {
    return false;
  }

  if (currentCycleKey && isOfficialCycleKey(currentCycleKey) && currentCycleKey !== last.key) {
    return false;
  }

  if (currentCycleKey && currentCycleKey === last.key && isOfficialCycleKey(currentCycleKey)) {
    return true;
  }

  if (last.restoreAt) {
    const restoreAtMs = Date.parse(last.restoreAt);
    if (Number.isFinite(restoreAtMs)) {
      if (nowMs < restoreAtMs) {
        return true;
      }
      if (!currentCycleKey || !isOfficialCycleKey(currentCycleKey)) {
        return false;
      }
      return currentCycleKey === last.key;
    }
  }

  return true;
};
