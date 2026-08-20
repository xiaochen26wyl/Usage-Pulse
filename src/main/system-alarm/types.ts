import type { AlarmTarget, SystemAlarmKind, SystemAlarmStatus } from "@shared/types";

/**
 * Bridges an alarm target to whatever the host OS uses for scheduling.
 *
 * `probe` must always ask the OS — never return a value the app cached when it
 * armed the alarm. The whole point of the status light in the UI is to answer
 * "is a clock actually running right now?", and a cached flag cannot answer it
 * after a reboot, a manual deletion, or a revoked permission.
 */
export interface SystemAlarmAdapter {
  isSupported(kind: SystemAlarmKind): boolean;
  probe(kind: SystemAlarmKind): Promise<SystemAlarmStatus>;
  arm(kind: SystemAlarmKind, target: AlarmTarget): Promise<void>;
  clear(kind: SystemAlarmKind): Promise<void>;
}

export const SYSTEM_ALARM_KINDS: SystemAlarmKind[] = ["wake-app", "native"];

export const nowIso = (): string => new Date().toISOString();

export const statusOf = (
  kind: SystemAlarmKind,
  state: SystemAlarmStatus["state"],
  fireAt: string | null = null,
  message?: string
): SystemAlarmStatus => ({ kind, state, fireAt, verifiedAt: nowIso(), message });
