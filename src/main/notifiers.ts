import { Notification } from "electron";
import axios from "axios";
import type { AppSettings, CombinedSnapshot, NotifyPayload } from "@shared/types";

const toDisplay = (value: number | null): string => (value === null ? "N/A" : `${value}`);

const buildLineFlexPayload = ({ snapshot, reason }: NotifyPayload) => {
  const cursorValue = `${toDisplay(snapshot.cursor.remaining)} / ${toDisplay(snapshot.cursor.total)}`;
  const claudeValue = `${toDisplay(snapshot.claude.remaining)} / ${toDisplay(snapshot.claude.total)}`;

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
                  { type: "text", text: "Claude", size: "sm", color: "#555555", flex: 3 },
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
    body: `${payload.reason}\nCursor: ${toDisplay(payload.snapshot.cursor.remaining)} | Claude: ${toDisplay(
      payload.snapshot.claude.remaining
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
