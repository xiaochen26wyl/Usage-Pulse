import type { ClaudeBillingCadence } from "./types";
import { toIsoTime } from "./claude-usage";

const pickString = (source: Record<string, unknown>, keys: string[]): string | null => {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return null;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * Pulls subscription_created_at from the OAuth profile (or account) payload.
 *
 * The live field is snake_case on organization; camelCase and a memberships[]
 * walk are accepted so a shape change does not silently drop the billing alarm.
 */
export const parseSubscriptionCreatedAt = (payload: Record<string, unknown>): string | null => {
  const candidates: Array<Record<string, unknown> | null> = [asRecord(payload.organization), payload];

  const memberships = payload.memberships;
  if (Array.isArray(memberships)) {
    for (const entry of memberships) {
      const membership = asRecord(entry);
      if (!membership) {
        continue;
      }
      candidates.push(asRecord(membership.organization), membership);
    }
  }

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const raw = pickString(candidate, ["subscription_created_at", "subscriptionCreatedAt"]);
    const parsed = raw ? toIsoTime(raw) : null;
    if (parsed) {
      return parsed;
    }
  }

  return null;
};

const daysInUtcMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

const setUtcDayClamped = (year: number, month: number, day: number, source: Date): Date => {
  const clampedDay = Math.min(day, daysInUtcMonth(year, month));
  return new Date(
    Date.UTC(
      year,
      month,
      clampedDay,
      source.getUTCHours(),
      source.getUTCMinutes(),
      source.getUTCSeconds(),
      source.getUTCMilliseconds()
    )
  );
};

const addUtcMonths = (anchor: Date, months: number): Date => {
  const monthIndex = anchor.getUTCMonth() + months;
  const year = anchor.getUTCFullYear() + Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12;
  return setUtcDayClamped(year, month, anchor.getUTCDate(), anchor);
};

const addUtcYears = (anchor: Date, years: number): Date =>
  setUtcDayClamped(anchor.getUTCFullYear() + years, anchor.getUTCMonth(), anchor.getUTCDate(), anchor);

const advanceFromAnchor = (anchor: Date, steps: number, cadence: ClaudeBillingCadence): Date =>
  cadence === "annual" ? addUtcYears(anchor, steps) : addUtcMonths(anchor, steps);

/**
 * Next subscription charge after `nowMs`, from the profile anchor date.
 *
 * Monthly and annual are anniversary math on that date — Anthropic does not
 * expose Stripe's current_period_end on the OAuth surface. An exact match on
 * now is returned so a firing due this instant can still ring.
 */
export const nextBillingAt = (
  createdAt: string,
  cadence: ClaudeBillingCadence,
  nowMs: number
): string | null => {
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime()) || !Number.isFinite(nowMs)) {
    return null;
  }

  let candidate = created;
  const limit = cadence === "annual" ? 40 : 240;
  for (let steps = 1; steps <= limit && candidate.getTime() < nowMs; steps += 1) {
    const next = advanceFromAnchor(created, steps, cadence);
    if (next.getTime() <= candidate.getTime()) {
      return null;
    }
    candidate = next;
  }

  return candidate.getTime() < nowMs ? null : candidate.toISOString();
};

export const resolveClaudeBillingAt = (
  anchorAt: string | null | undefined,
  fallbackResetAt: string | null | undefined,
  cadence: ClaudeBillingCadence,
  nowMs: number
): string | null => {
  if (anchorAt) {
    return nextBillingAt(anchorAt, cadence, nowMs);
  }
  if (fallbackResetAt && !Number.isNaN(Date.parse(fallbackResetAt))) {
    return fallbackResetAt;
  }
  return null;
};
