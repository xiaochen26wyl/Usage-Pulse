import type { AlarmTarget, AppSettings, SystemAlarmKind, SystemAlarmStatus } from "@shared/types";
import { SYSTEM_ALARM_KINDS, type SystemAlarmAdapter, statusOf } from "./types";
import { macosAdapter } from "./macos";
import { windowsAdapter } from "./windows";

const unsupportedAdapter: SystemAlarmAdapter = {
  isSupported: () => false,
  probe: async (kind) => statusOf(kind, "unsupported"),
  arm: async () => undefined,
  clear: async () => undefined
};

const adapter: SystemAlarmAdapter =
  process.platform === "darwin" ? macosAdapter : process.platform === "win32" ? windowsAdapter : unsupportedAdapter;

const toggleFor = (kind: SystemAlarmKind): keyof AppSettings =>
  kind === "wake-app" ? "enableSystemAlarmWakeApp" : "enableSystemAlarmNative";

export const isKindEnabled = (settings: AppSettings, kind: SystemAlarmKind): boolean =>
  Boolean(settings[toggleFor(kind)]);

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Reports what the OS actually holds for each kind, right now.
 *
 * Disabled kinds short-circuit to "disabled"; everything else shells out. The
 * UI shows the `verifiedAt` timestamp that comes back so the user can tell a
 * fresh answer from a stale screen.
 */
export const probeSystemAlarms = async (settings: AppSettings): Promise<SystemAlarmStatus[]> =>
  Promise.all(
    SYSTEM_ALARM_KINDS.map(async (kind) => {
      if (!adapter.isSupported(kind)) {
        return statusOf(kind, "unsupported");
      }
      if (!isKindEnabled(settings, kind)) {
        return statusOf(kind, "disabled");
      }
      try {
        return await adapter.probe(kind);
      } catch (error) {
        return statusOf(kind, "error", null, errorMessage(error));
      }
    })
  );

/**
 * Brings the OS schedule in line with the next alarm target: arms the kinds the
 * user enabled, tears down the ones they turned off, then re-probes so the
 * caller reports verified state rather than what it just attempted.
 */
export const syncSystemAlarms = async (
  settings: AppSettings,
  target: AlarmTarget | null
): Promise<SystemAlarmStatus[]> =>
  Promise.all(
    SYSTEM_ALARM_KINDS.map(async (kind) => {
      if (!adapter.isSupported(kind)) {
        return statusOf(kind, "unsupported");
      }

      try {
        if (!isKindEnabled(settings, kind)) {
          await adapter.clear(kind);
          return statusOf(kind, "disabled");
        }
        if (!target) {
          await adapter.clear(kind);
          return statusOf(kind, "stale", null, "No alarm target scheduled");
        }

        await adapter.arm(kind, target);
        return await adapter.probe(kind);
      } catch (error) {
        return statusOf(kind, "error", target?.fireAt ?? null, errorMessage(error));
      }
    })
  );

export const clearSystemAlarms = async (): Promise<void> => {
  for (const kind of SYSTEM_ALARM_KINDS) {
    if (adapter.isSupported(kind)) {
      await adapter.clear(kind).catch(() => undefined);
    }
  }
};
