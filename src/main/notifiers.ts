import { Notification } from "electron";
import axios from "axios";
import type { AppSettings, NotifyPayload, QuotaSnapshot } from "@shared/types";

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

const buildLineFlexPayload = ({ snapshot, reason }: NotifyPayload) => {
  const cursorValue = formatQuota(snapshot.cursor);
  const claudeValue = formatQuota(snapshot.claude);

  return {
    messages: [
      {
        type: "flex",
        altText: `Usage-Pulse 通知: ${reason}`,
        contents: {
          type: "bubble",
          body: {
            type: "box",
            layout: "vertical",
            spacing: "md",
            contents: [
              {
                type: "text",
                text: "Usage-Pulse",
                weight: "bold",
                size: "lg"
              },
              {
                type: "text",
                text: reason,
                wrap: true,
                size: "sm",
                color: "#666666"
              },
              {
                type: "separator"
              },
              {
                type: "box",
                layout: "baseline",
                contents: [
                  { type: "text", text: "Cursor", size: "sm", color: "#555555", flex: 3 },
                  { type: "text", text: cursorValue, size: "sm", flex: 5, align: "end" }
                ]
              },
              {
                type: "box",
                layout: "baseline",
                contents: [
                  { type: "text", text: "Claude Code", size: "sm", color: "#555555", flex: 3 },
                  { type: "text", text: claudeValue, size: "sm", flex: 5, align: "end" }
                ]
              }
            ]
          }
        }
      }
    ]
  };
};

export const sendDesktopNotification = (payload: NotifyPayload): void => {
  if (!Notification.isSupported()) {
    return;
  }

  const notification = new Notification({
    title: "Usage-Pulse 配額通知",
    body: `${payload.reason}\nCursor: ${formatQuota(payload.snapshot.cursor)} | Claude Code: ${formatQuota(
      payload.snapshot.claude
    )}`
  });

  notification.show();
};

export const sendLineFlexMessage = async (
  settings: AppSettings,
  payload: NotifyPayload
): Promise<boolean> => {
  if (!settings.enableLineNotify || !settings.lineChannelToken) {
    return false;
  }

  await axios.post("https://api.line.me/v2/bot/message/broadcast", buildLineFlexPayload(payload), {
    headers: {
      Authorization: `Bearer ${settings.lineChannelToken}`,
      "Content-Type": "application/json"
    },
    timeout: 15_000
  });

  return true;
};
