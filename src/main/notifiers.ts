import { Notification } from "electron";
import type { NotifyPayload, QuotaSnapshot } from "@shared/types";
import { t } from "@shared/i18n";
import { settingsStore } from "@main/store";

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

  new Notification({ title, body }).show();
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
