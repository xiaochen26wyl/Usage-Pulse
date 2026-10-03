import { SERVICE_LABELS } from "@main/config";
import { redact } from "@main/log-redaction";
import { sendLineBroadcast } from "@main/line-notifier";
import { settingsStore, snapshotStore } from "@main/store";
import { buildQuitStatusMessages } from "@shared/quit-status";

/**
 * Sends the "final status" LINE message — one swipeable message holding a card
 * per window (Cursor, Claude session and weekly, Codex session and weekly) —
 * built from the already-cached snapshot, never triggering a fresh quota fetch.
 * Used on every quit path, for each service whose LINE checkbox is on
 * (intentionally not deduped against previous quits), and by the Settings
 * panel's manual "send current status" button. Never throws: LINE is a
 * best-effort side channel and must not delay or block the app from actually
 * exiting. Returns whether the message was broadcast successfully, so the
 * manual button can report success/failure; the quit path ignores it.
 */
export const sendQuitStatusBroadcast = async (): Promise<boolean> => {
  try {
    const settings = settingsStore.get();
    const snapshot = snapshotStore.get();
    // The builder already skips services whose LINE checkbox is off, so the
    // broadcast itself must not re-check a single global switch.
    const messages = buildQuitStatusMessages({ settings, snapshot, serviceLabels: SERVICE_LABELS });
    if (messages.length === 0) {
      return false;
    }

    const results = await Promise.allSettled(
      messages.map((message) => sendLineBroadcast(message, { force: true }))
    );
    return results.some((result) => result.status === "fulfilled" && result.value);
  } catch (error) {
    console.warn("[quit-notifier] failed to send quit status broadcast:", redact(error));
    return false;
  }
};
