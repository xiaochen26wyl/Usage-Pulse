import type { AppSettings, CombinedSnapshot, ServiceType } from "./types";
import { buildQuitStatusFlex, type LineFlexMessage } from "./line-templates";
import { claudeTrayValueText, claudeWeeklyTrayValueText, cursorTrayValueText, findClaudeWeeklyWindow } from "./tray-display";
import { t } from "./i18n";

export interface QuitStatusOptions {
  settings: Pick<AppSettings, "enableCursorMonitoring" | "enableClaudeMonitoring" | "language">;
  snapshot: CombinedSnapshot | null;
  // Passed in rather than imported: SERVICE_LABELS lives in the main process
  // (see line-templates.ts's own note on why shared/ never reaches into it).
  serviceLabels: Record<ServiceType, string>;
  now?: Date;
}

/**
 * Builds the up-to-3 "final status" Flex bubbles sent on quit — Cursor,
 * Claude's 5-hour session, Claude's weekly window — from the already-cached
 * snapshot only (never fetches). Reuses the same tray display helpers the
 * menu bar itself uses, so the numbers (and the countdown fallback once a
 * window is spent) match exactly what the user already saw. A window whose
 * display value is "?" (monitoring off, or never successfully polled) is
 * skipped rather than sending noise. No dedupe/cooldown: every quit is its
 * own occurrence, unlike the recurring low-quota alerts elsewhere.
 */
export const buildQuitStatusMessages = (options: QuitStatusOptions): LineFlexMessage[] => {
  const { settings, snapshot, serviceLabels, now = new Date() } = options;
  if (!snapshot) {
    return [];
  }
  const lang = settings.language;
  const nowMs = now.getTime();
  const messages: LineFlexMessage[] = [];

  if (settings.enableCursorMonitoring) {
    const valueText = cursorTrayValueText(snapshot.cursor, nowMs);
    if (valueText !== "?") {
      messages.push(
        buildQuitStatusFlex({
          service: "cursor",
          serviceLabel: serviceLabels.cursor,
          windowLabel: t(lang, "window.label.cursorOverall"),
          valueText,
          resetAt: snapshot.cursor.resetsAt,
          lang,
          now
        })
      );
    }
  }

  if (settings.enableClaudeMonitoring) {
    // Gated on the window actually existing (not on the tray helper's "?"
    // output): both claudeTrayValueText and claudeWeeklyTrayValueText fall
    // back to the same generic top-level snapshotValueText when their own
    // window is missing, so checking "?" here could let one window's number
    // leak into the other's message when only one of the two exists.
    const session = snapshot.claude.windows.find((window) => window.key === "session") ?? null;
    if (session && session.remaining !== null) {
      messages.push(
        buildQuitStatusFlex({
          service: "claude",
          serviceLabel: serviceLabels.claude,
          windowLabel: session.label || t(lang, "window.label.session"),
          valueText: claudeTrayValueText(snapshot.claude, nowMs),
          resetAt: session.resetsAt,
          lang,
          now
        })
      );
    }

    const weekly = findClaudeWeeklyWindow(snapshot.claude);
    if (weekly && weekly.remaining !== null) {
      messages.push(
        buildQuitStatusFlex({
          service: "claude",
          serviceLabel: serviceLabels.claude,
          windowLabel: weekly.label || t(lang, "window.label.weekly"),
          valueText: claudeWeeklyTrayValueText(snapshot.claude, nowMs),
          resetAt: weekly.resetsAt,
          lang,
          now
        })
      );
    }
  }

  return messages;
};
