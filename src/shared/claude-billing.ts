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
