import type { CombinedSnapshot, ServiceType } from "./types";

export const getLowQuotaServices = (snapshot: CombinedSnapshot): ServiceType[] =>
  (["cursor", "claude"] as ServiceType[]).filter((service) => snapshot[service].status === "low");

export const isDuplicateInCooldown = (
  last: { key: string; at: string },
  key: string,
  cooldownMs: number,
  nowMs: number
): boolean => {
  const lastAtMs = last.at ? Date.parse(last.at) : 0;
  return last.key === key && lastAtMs > 0 && nowMs - lastAtMs < cooldownMs;
};
