const UNITS = ["B", "KB", "MB", "GB"] as const;

/**
 * "640 MB" / "1.2 GB" — binary multiples, one decimal only where it matters.
 */
export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = value >= 100 || unit === 0 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, "");
  return `${text} ${UNITS[unit]}`;
};

export type HistoryFailureKey = "history.status.outdatedMain" | "history.status.failed";

interface HistoryApiLike {
  getHistoryStats?: unknown;
  cleanHistory?: unknown;
}

export const hasHistoryApi = (api: HistoryApiLike | null | undefined): boolean =>
  typeof api?.getHistoryStats === "function" && typeof api?.cleanHistory === "function";

/**
 * Why a stats call failed, named from what was actually observed.
 *
 * A dev session that has been running since before this feature existed keeps
 * the old main and preload while the renderer hot-reloads to the new screen: the
 * bridge method is missing, or main answers "no handler". That is a restart, not
 * a read error, and the two must not read as the same thing.
 */
export const classifyHistoryFailure = (
  api: HistoryApiLike | null | undefined,
  error: unknown
): { key: HistoryFailureKey; detail: string } => {
  const detail = error instanceof Error ? error.message : error === undefined ? "" : String(error);
  if (!hasHistoryApi(api) || /No handler registered/i.test(detail)) {
    return { key: "history.status.outdatedMain", detail: "" };
  }
  return { key: "history.status.failed", detail };
};
