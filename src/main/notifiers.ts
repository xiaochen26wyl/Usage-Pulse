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

export const sendDesktopNotification = (payload: NotifyPayload): void => {
  if (!Notification.isSupported()) {
    return;
  }

  const lang = settingsStore.get().language;
  const notification = new Notification({
    title: t(lang, "notification.title"),
    body: `${payload.reason}\nCursor: ${formatQuota(payload.snapshot.cursor)} | Claude Code: ${formatQuota(
      payload.snapshot.claude
    )}`
  });

  notification.show();
};
