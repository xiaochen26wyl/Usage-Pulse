import type { CombinedSnapshot, ServiceType } from "./types";

export const getLowQuotaServices = (snapshot: CombinedSnapshot): ServiceType[] =>
  (["cursor", "claude", "codex"] as ServiceType[]).filter((service) => snapshot[service].status === "low");

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

/**
 * Keeps a re-derived fallback reset time stable across repeated
 * recomputation: the cached value is kept for as long as it's still in the
 * future (proof the cycle it names hasn't ended yet); once it elapses, the
 * newest candidate (even null) becomes the new baseline. Without this, a
 * source that rescans noisy logs on every call — like the Claude CLI's local
 * quota-rejection log — can return a slightly different "latest" reset time
 * from one poll to the next even though the real window hasn't rolled over,
 * which would look like a fresh occurrence to anything keying off the value.
 */
export const stabilizeResetTime = (
  cached: string | null,
  candidate: string | null,
  nowMs: number
): string | null => (cached !== null && Date.parse(cached) > nowMs ? cached : candidate);

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
