import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import axios from "axios";
import { settingsStore } from "@main/store";

const LINE_TOKEN_URL = "https://api.line.me/oauth2/v2.1/token";
const LINE_BROADCAST_URL = "https://api.line.me/v2/bot/message/broadcast";

// LINE caps a single text message at 5000 characters.
const MAX_TEXT_LENGTH = 5000;

// The assertion JWT only has to survive the token exchange itself.
const ASSERTION_LIFETIME_SECONDS = 30 * 60;
// How long the channel access token we ask for should live (30 days, LINE's max).
const REQUESTED_TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
// Renew a little before expiry so an in-flight broadcast never races the clock.
const TOKEN_RENEW_MARGIN_MS = 5 * 60_000;

interface CachedToken {
  token: string;
  // Which assertion credentials minted it, so changing them in settings
  // invalidates the cache rather than silently reusing the old channel's token.
  credentialKey: string;
  expiresAtMs: number;
}

// Held in memory only. A minted token is a secret with a short life; persisting
// it would put a second copy of channel credentials on disk for no benefit.
let cachedToken: CachedToken | null = null;

const base64Url = (input: Buffer | string): string =>
  Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// LINE hands out the assertion signing key as a JWK document, but a user who
// converted it to PEM should not be punished for it — accept either.
const toPrivateKey = (raw: string): KeyObject => {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    return createPrivateKey({ key: JSON.parse(trimmed), format: "jwk" });
  }
  return createPrivateKey(trimmed);
};

const signAssertion = (channelId: string, kid: string, privateKeyPem: string, nowSeconds: number): string => {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const payload = base64Url(
    JSON.stringify({
      iss: channelId,
      sub: channelId,
      aud: "https://api.line.me/",
      exp: nowSeconds + ASSERTION_LIFETIME_SECONDS,
      token_exp: REQUESTED_TOKEN_LIFETIME_SECONDS
    })
  );

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = base64Url(signer.sign(toPrivateKey(privateKeyPem)));
  return `${header}.${payload}.${signature}`;
};

const mintChannelAccessToken = async (
  channelId: string,
  kid: string,
  privateKey: string
): Promise<string> => {
  const credentialKey = `${channelId}|${kid}`;
  const nowMs = Date.now();
  if (cachedToken && cachedToken.credentialKey === credentialKey && cachedToken.expiresAtMs - TOKEN_RENEW_MARGIN_MS > nowMs) {
    return cachedToken.token;
  }

  const assertion = signAssertion(channelId, kid, privateKey, Math.floor(nowMs / 1000));
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: assertion
  });

  const { data } = await axios.post<{ access_token: string; expires_in: number }>(LINE_TOKEN_URL, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15_000
  });

  cachedToken = {
    token: data.access_token,
    credentialKey,
    expiresAtMs: nowMs + (Number(data.expires_in) || 0) * 1000
  };
  return data.access_token;
};

const resolveAccessToken = async (): Promise<string | null> => {
  const settings = settingsStore.get();
  const channelId = settings.lineChannelId.trim();
  const kid = settings.lineAssertionKid.trim();
  const privateKey = settings.lineAssertionPrivateKey.trim();

  if (channelId && kid && privateKey) {
    return mintChannelAccessToken(channelId, kid, privateKey);
  }

  // No assertion key configured: fall back to a long-lived token pasted straight
  // into settings, which is what LINE's console hands out by default.
  return settings.lineChannelAccessToken.trim() || null;
};

/**
 * Broadcasts one text message to the user's own LINE official account.
 *
 * Never throws. LINE is a best-effort side channel — a misconfigured key or a
 * network blip must not take down the credential sweep or the quota monitor
 * that called this.
 */
export const sendLineBroadcast = async (text: string): Promise<boolean> => {
  try {
    const accessToken = await resolveAccessToken();
    if (!accessToken) {
      return false;
    }

    await axios.post(
      LINE_BROADCAST_URL,
      { messages: [{ type: "text", text: text.slice(0, MAX_TEXT_LENGTH) }] },
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
    console.warn("[line-notifier] broadcast failed:", error instanceof Error ? error.message : error);
    return false;
  }
};
