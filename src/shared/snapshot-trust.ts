import type { QuotaSnapshot } from "./types";

/**
 * How much a single service's snapshot can be believed.
 *
 * The alarm paths used to treat every reading alike, so a credential outage or
 * the very first reading after one were fed into the same conditionals as a
 * steady-state poll. That is what produced "quota used up" popups when nothing
 * had actually run out. Classifying the reading first gives those paths
 * something to gate on.
 */
export type SnapshotTrust = "trusted" | "degraded" | "absent";

/**
 * `absent` is "we have never had a reading"; `degraded` is "we have one but it
 * carries no usable numbers" — a fetch/credential failure (`error`), an
 * unparseable payload (`unknown`), or a payload that produced no windows at
 * all. Only a reading with real windows is `trusted`.
 */
export const trustOf = (snapshot: QuotaSnapshot | null | undefined): SnapshotTrust => {
  if (!snapshot) {
    return "absent";
  }
  if (snapshot.status === "error" || snapshot.status === "unknown") {
    return "degraded";
  }
  if (!Array.isArray(snapshot.windows) || snapshot.windows.length === 0) {
    return "degraded";
  }
  return "trusted";
};

export const isTrusted = (snapshot: QuotaSnapshot | null | undefined): boolean =>
  trustOf(snapshot) === "trusted";

/**
 * A reading we must not raise a quota alarm from.
 *
 * True when either side of the comparison is untrustworthy: the new reading
 * itself is degraded (nothing to alarm about), or the previous one was absent
 * or degraded, which makes this the first believable data point after a gap.
 * "0 % remaining" on such a reading is indistinguishable from "we simply had
 * not been able to look" and must be confirmed before it interrupts anyone.
 */
export const isColdReading = (
  previous: QuotaSnapshot | null | undefined,
  next: QuotaSnapshot | null | undefined
): boolean => trustOf(next) !== "trusted" || trustOf(previous) !== "trusted";
