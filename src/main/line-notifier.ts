import axios from "axios";
import type { LineMessage } from "@shared/line-templates";
import { redact } from "@main/log-redaction";
import { settingsStore } from "@main/store";

const LINE_BROADCAST_URL = "https://api.line.me/v2/bot/message/broadcast";

// LINE caps a single text message at 5000 characters.
const MAX_TEXT_LENGTH = 5000;

const clampMessage = (message: LineMessage): LineMessage =>
  message.type === "text" ? { ...message, text: message.text.slice(0, MAX_TEXT_LENGTH) } : message;

/**
 * Broadcasts one message — a Flex bubble from shared/line-templates.ts, or
 * plain text — to the user's own LINE official account.
 *
 * Authentication is the simple path: a long-lived channel access token issued
 * from the LINE Developers console and pasted into settings. We deliberately do
 * not support the JWT-assertion flow (channel ID + kid + private key) — it buys
 * auto-rotating short-lived tokens that a single-user desktop app has no need
 * for, at the cost of asking the user to register a key pair.
 *
 * Never throws. LINE is a best-effort side channel — a stale token or a network
 * blip must not take down the credential sweep or the quota monitor that called
 * this.
 *
 * `force` skips the enableLineNotification check — used by the settings
 * panel's "send test message" button, where a disabled toggle must not mask
 * whether the pasted token itself actually works.
 */
export const sendLineBroadcast = async (
  message: LineMessage,
  options?: { force?: boolean }
): Promise<boolean> => {
  try {
    const settings = settingsStore.get();
    if (!settings.enableLineNotification && !options?.force) {
      return false;
    }
    const accessToken = settings.lineChannelAccessToken.trim();
    if (!accessToken) {
      return false;
    }

    await axios.post(
      LINE_BROADCAST_URL,
      { messages: [clampMessage(message)] },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        timeout: 15_000
      }
    );
    return true;
  } catch (error) {
    // Deliberately not surfaced to the renderer: the message body may echo
    // parts of the request, and callers have nothing useful to do with it.
    console.warn("[line-notifier] broadcast failed:", redact(error));
    return false;
  }
};
