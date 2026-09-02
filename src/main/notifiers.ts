import { Notification } from "electron";
import type { NotifyPayload, QuotaSnapshot } from "@shared/types";
import { ALARM_POPUP_AUTO_DISMISS_SECONDS } from "@shared/alarm-utils";
import { t } from "@shared/i18n";
import { settingsStore } from "@main/store";

const DESKTOP_NOTIFICATION_AUTO_DISMISS_MS = ALARM_POPUP_AUTO_DISMISS_SECONDS * 1000;

// Keep native notifications alive until we explicitly close them. Without a
// reference, V8 may collect the object before our 30-second dismissal runs.
const activeNotifications = new Set<Notification>();

const armDesktopNotificationDismissal = (notification: Notification): void => {
  activeNotifications.add(notification);

  const timer = setTimeout(() => {
    if (!activeNotifications.has(notification)) {
      return;
    }
    activeNotifications.delete(notification);
    notification.close();
  }, DESKTOP_NOTIFICATION_AUTO_DISMISS_MS);
  timer.unref?.();

  notification.once("close", () => {
    clearTimeout(timer);
    activeNotifications.delete(notification);
  });
};

const formatValue = (value: number | null, unit: QuotaSnapshot["unit"]): string => {
  if (value === null) {
    return "N/A";
  }
  if (unit === "usd") {
    return `$${value.toFixed(2)}`;
  }
  if (unit === "percent") {
    return `${Math.round(value)}%`;
  }
  return `${value}`;
};

const formatQuota = (snapshot: QuotaSnapshot): string => {
  const remaining = formatValue(snapshot.remaining, snapshot.unit);
  const total = formatValue(snapshot.total, snapshot.unit);
  return `${remaining} / ${total}`;
};

/**
 * The single exit point for desktop notifications.
 *
 * Callers that have no quota snapshot to summarise (the credential sweep, for
 * one) use this directly rather than fabricating a snapshot to satisfy
 * sendDesktopNotification.
 */
export const sendPlainDesktopNotification = (title: string, body: string): void => {
  if (!Notification.isSupported()) {
    return;
  }

  const notification = new Notification({ title, body, timeoutType: "default" });
  notification.show();
  armDesktopNotificationDismissal(notification);
};

export const sendDesktopNotification = (payload: NotifyPayload): void => {
  const lang = settingsStore.get().language;
  sendPlainDesktopNotification(
    t(lang, "notification.title"),
    `${payload.reason}\nCursor: ${formatQuota(payload.snapshot.cursor)} | Claude Code: ${formatQuota(
      payload.snapshot.claude
    )}`
  );
};
