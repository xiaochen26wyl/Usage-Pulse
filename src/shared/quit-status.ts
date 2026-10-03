import type { AppSettings, CombinedSnapshot, ServiceType } from "./types";
import { buildCarouselFlex, buildQuitStatusFlex, type LineFlexMessage } from "./line-templates";
import {
  UNKNOWN_TRAY_VALUE,
  claudeTrayValueText,
  claudeWeeklyTrayValueText,
  codexTrayValueText,
  codexWeeklyTrayValueText,
  cursorTrayValueText,
  findClaudeWeeklyWindow,
  findCodexWeeklyWindow
} from "./tray-display";
import { t } from "./i18n";
import { isLineEnabled } from "./notify-channels";

export interface QuitStatusOptions {
  settings: Pick<
    AppSettings,
    | "enableCursorMonitoring"
    | "enableClaudeMonitoring"
    | "enableCodexMonitoring"
    | "enableCursorLineNotification"
    | "enableClaudeLineNotification"
    | "enableCodexLineNotification"
    | "language"
  >;
  snapshot: CombinedSnapshot | null;
  // Passed in rather than imported: SERVICE_LABELS lives in the main process
  // (see line-templates.ts's own note on why shared/ never reaches into it).
  serviceLabels: Record<ServiceType, string>;
  now?: Date;
}

/**
 * Builds the "final status" Flex message sent on quit — one card each for
 * Cursor, Claude's 5-hour session and weekly windows, and Codex's 5-hour
 * session and weekly windows — from the already-cached snapshot only (never
 * fetches). The cards travel as a single swipeable message, so quitting is one
 * LINE notification however many windows are monitored. Reuses the same tray
 * display helpers the menu bar itself uses, so the numbers (and the countdown
 * fallback once a window is spent) match exactly what the user already saw. A
 * window whose internal display value is unknown (monitoring off, or never
 * successfully polled) is skipped rather than sending noise, and so is every
 * window of a service whose LINE checkbox is off; when nothing is left the
 * result is empty. No dedupe/cooldown: every quit is its own occurrence,
 * unlike the recurring low-quota alerts elsewhere.
 */
export const buildQuitStatusMessages = (options: QuitStatusOptions): LineFlexMessage[] => {
  const { settings, snapshot, serviceLabels, now = new Date() } = options;
  if (!snapshot) {
    return [];
  }
  const lang = settings.language;
  const nowMs = now.getTime();
  const cards: LineFlexMessage[] = [];

  if (settings.enableCursorMonitoring && isLineEnabled(settings, "cursor")) {
    const valueText = cursorTrayValueText(snapshot.cursor, nowMs);
    if (valueText !== UNKNOWN_TRAY_VALUE) {
      cards.push(
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

  if (settings.enableClaudeMonitoring && isLineEnabled(settings, "claude")) {
    // Gated on the window actually existing (not on the tray helper's unknown
    // output): both claudeTrayValueText and claudeWeeklyTrayValueText fall
    // back to the same generic top-level snapshotValueText when their own
    // window is missing, so checking "?" here could let one window's number
    // leak into the other's message when only one of the two exists.
    const session = snapshot.claude.windows.find((window) => window.key === "session") ?? null;
    if (session && session.remaining !== null) {
      cards.push(
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
      cards.push(
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

  if (settings.enableCodexMonitoring && isLineEnabled(settings, "codex")) {
    const session = snapshot.codex.windows.find((window) => window.key === "session") ?? null;
    if (session && session.remaining !== null) {
      cards.push(
        buildQuitStatusFlex({
          service: "codex",
          serviceLabel: serviceLabels.codex,
          windowLabel: session.label || t(lang, "window.label.session"),
          valueText: codexTrayValueText(snapshot.codex, nowMs),
          resetAt: session.resetsAt,
          lang,
          now
        })
      );
    }

    const weekly = findCodexWeeklyWindow(snapshot.codex);
    if (weekly && weekly.remaining !== null) {
      cards.push(
        buildQuitStatusFlex({
          service: "codex",
          serviceLabel: serviceLabels.codex,
          windowLabel: weekly.label || t(lang, "window.label.weekly"),
          valueText: codexWeeklyTrayValueText(snapshot.codex, nowMs),
          resetAt: weekly.resetsAt,
          lang,
          now
        })
      );
    }
  }

  return cards.length > 0 ? [buildCarouselFlex(cards)] : [];
};
