import type { CombinedSnapshot, QuotaWindow, ServiceType } from "./types";

export const getLowQuotaServices = (snapshot: CombinedSnapshot): ServiceType[] =>
  (["cursor", "claude", "codex"] as ServiceType[]).filter((service) => snapshot[service].status === "low");

/**
 * Whether a service's next poll is overdue, given the wall-clock time its
 * last snapshot was actually fetched.
 *
 * MonitorEngine's poll timers are `setTimeout`s that re-arm themselves after
 * each tick, and — like any Chromium/Node timer — do not advance while the
 * machine sleeps. A timer armed shortly before a long sleep comes back to
 * life having made almost no progress, so the wake handlers in index.ts
 * consult this against the persisted `fetchedAt` instead of trusting the
 * timer to have ticked on schedule. A missing or unparseable timestamp means
 * "never fetched" and is always due. Mirrors isCredentialCheckDue in
 * credential-utils.ts, which solves the identical problem for the
 * credential sweep.
 */
export const isPollDue = (fetchedAt: string | null, nowMs: number, intervalMs: number): boolean => {
  const lastMs = fetchedAt ? Date.parse(fetchedAt) : NaN;
  if (Number.isNaN(lastMs)) {
    return true;
  }
  return nowMs - lastMs >= intervalMs;
};

export const isDuplicateInCooldown = (
  last: { key: string; at: string },
  key: string,
  cooldownMs: number,
  nowMs: number
): boolean => {
  const lastAtMs = last.at ? Date.parse(last.at) : 0;
  return last.key === key && lastAtMs > 0 && nowMs - lastAtMs < cooldownMs;
};

/**
 * Whether a low-quota latch should be cleared given a reading that's no
 * longer "low". A reading of unknown percent is inconclusive, not a
 * recovery. Otherwise the reading must clear the threshold by more than
 * `hysteresisPercent` — a value bouncing right at the threshold (rounding, a
 * borderline API payload) must not repeatedly clear and re-arm the same
 * alert.
 */
export const shouldClearLowQuotaLatch = (
  remainingPercent: number | null,
  threshold: number,
  hysteresisPercent: number
): boolean => remainingPercent !== null && remainingPercent > threshold + hysteresisPercent;

// Real recompute jitter (Codex's now+secondsLeft, the Claude CLI log rescan)
// is documented as "a second or two" per poll. 60s is generous headroom for
// a slower tick or a couple of stacked polls, but far short of any
// legitimate reset-time change (minutes to hours), so a candidate that
// differs by more than this can't be mistaken for jitter.
const RESET_DRIFT_TOLERANCE_MS = 60_000;

/**
 * Keeps a re-derived fallback reset time stable across repeated
 * recomputation: the cached value is kept for as long as it's still in the
 * future (proof the cycle it names hasn't ended yet) AND the fresh candidate
 * is within jitter tolerance of it; once the cached value elapses, or the
 * candidate diverges from it by more than that tolerance, the newest
 * candidate (even null) becomes the new baseline. Without the "still in the
 * future" half, a source that rescans noisy logs on every call — like the
 * Claude CLI's local quota-rejection log — can return a slightly different
 * "latest" reset time from one poll to the next even though the real window
 * hasn't rolled over, which would look like a fresh occurrence to anything
 * keying off the value. Without the tolerance half, a window that genuinely
 * resets earlier than the app's own prior prediction (e.g. a 5-hour session
 * rolling over server-side sooner than expected) would have that real reset
 * ignored until the stale predicted time itself elapses, silently blocking
 * the next low-quota occurrence from re-arming.
 */
export const stabilizeResetTime = (
  cached: string | null,
  candidate: string | null,
  nowMs: number
): string | null => {
  if (cached === null) {
    return candidate;
  }
  const cachedMs = Date.parse(cached);
  const cachedStillFuture = !Number.isNaN(cachedMs) && cachedMs > nowMs;
  if (!cachedStillFuture) {
    return candidate;
  }
  if (candidate === null) {
    return cached;
  }
  const candidateMs = Date.parse(candidate);
  const materiallyDifferent =
    !Number.isNaN(candidateMs) && Math.abs(candidateMs - cachedMs) > RESET_DRIFT_TOLERANCE_MS;
  return materiallyDifferent ? candidate : cached;
};

/**
 * Applies stabilizeResetTime to every window in a fresh scrape, matched by
 * `key` against the previous poll's windows. Sources like Codex's
 * reset_after_seconds field are recomputed as `now + secondsLeft` on every
 * call, so the resulting resetsAt can drift by a second or two between polls
 * of the very same underlying reset — without this, that drift becomes a
 * different dedupeKey each poll and defeats the one-shot alert gate
 * (shouldNotifyOnce), so a low-quota or exhausted alert never stops re-firing
 * for as long as the window stays low.
 */
export const stabilizeWindowResets = (
  previousWindows: QuotaWindow[] | null | undefined,
  nextWindows: QuotaWindow[],
  nowMs: number
): QuotaWindow[] => {
  if (!previousWindows || previousWindows.length === 0) {
    return nextWindows;
  }
  const previousResetsAtByKey = new Map(previousWindows.map((window) => [window.key, window.resetsAt]));
  return nextWindows.map((window) => {
    const cached = previousResetsAtByKey.get(window.key) ?? null;
    const resetsAt = stabilizeResetTime(cached, window.resetsAt, nowMs);
    return resetsAt === window.resetsAt ? window : { ...window, resetsAt };
  });
};

/**
 * Converts Cursor's `autoPercentUsed`/`apiPercentUsed` usage figure to a
 * 0-100 percent, clamped. Cursor's API is documented to return this as a 0-1
 * ratio, but has been observed in practice to come back already as a 0-100
 * percentage instead (e.g. 49 meaning "49% used", not "4900% used") —
 * unconditionally multiplying by 100 saturates every such reading at the 100
 * clamp, which is indistinguishable from genuine exhaustion. A value at or
 * below 1 is treated as a true ratio and scaled up; anything above 1 is
 * assumed to already be a percentage and used as-is. Either way the result is
 * clamped to [0, 100] so a single anomalous reading can't surface as an "over
 * 1000%" notification or progress bar.
 */
export const clampPercentFromRatio = (value: number): number => {
  const percent = value > 1 ? value : value * 100;
  return Math.max(0, Math.min(100, Math.round(percent)));
};
