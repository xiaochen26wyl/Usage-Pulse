import axios from "axios";
import type { CredentialSource, Language, ScrapeResult } from "@shared/types";
import { t } from "@shared/i18n";
import { nextBillingAt, parseSubscriptionCreatedAt } from "@shared/claude-billing";
import { buildClaudeScrapeResult, extractLimits, selectPrimaryLimits } from "@shared/claude-usage";
import { stabilizeResetTime } from "@shared/monitor-utils";
import { latestFutureReset, readClaudeCliQuotaEvents } from "@main/collectors/claude-cli-log";
import { readClaudeCredential } from "@main/credential-provider";
import { settingsStore } from "@main/store";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const PROFILE_CACHE_MS = 24 * 60 * 60 * 1000;

const oauthHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "anthropic-beta": "oauth-2025-04-20",
  "User-Agent": "claude-code/"
});

interface ProfileCache {
  fetchedAt: number;
  subscriptionCreatedAt: string | null;
}

let profileCache: ProfileCache | null = null;

// Wider than the 5-hour window, so a rejection recorded at its start is still
// in scope when we go looking for the reset time it carried.
const CLI_LOG_LOOKBACK_MS = 8 * 60 * 60_000;

const SESSION_LIMIT_TYPES = ["five_hour", "session"];
const WEEKLY_LIMIT_TYPES = ["seven_day", "seven_day_all", "weekly"];

interface CliResetTimes {
  session: string | null;
  weekly: string | null;
}

// latestFutureReset rescans a sliding log window on every call, so its
// "newest future candidate" can drift poll-to-poll (a new log line appears)
// even though the real window hasn't rolled over. Re-notification dedupe
// keys off this value downstream, so a stable value here — held until it
// actually elapses, only then replaced — is what keeps one real low-quota
// occurrence from firing more than once.
let stableFallbackResets: CliResetTimes = { session: null, weekly: null };

const applyStabilization = (key: keyof CliResetTimes, candidate: string | null, nowMs: number): string | null => {
  const next = stabilizeResetTime(stableFallbackResets[key], candidate, nowMs);
  stableFallbackResets[key] = next;
  return next;
};

/**
 * Reset times recovered from the CLI's own logs, for the windows the API left
 * blank. Best effort in every sense: a failure here just means we carry on
 * without a reset time, exactly as before — except we prefer a still-live
 * cached value over a hard null, so a transient log-read hiccup doesn't
 * itself look like a state change.
 */
const readCliResetTimes = async (needSession: boolean, needWeekly: boolean): Promise<CliResetTimes> => {
  if (!needSession && !needWeekly) {
    return { session: null, weekly: null };
  }
  try {
    const nowMs = Date.now();
    const events = await readClaudeCliQuotaEvents(nowMs - CLI_LOG_LOOKBACK_MS);
    return {
      session: needSession ? applyStabilization("session", latestFutureReset(events, SESSION_LIMIT_TYPES, nowMs), nowMs) : null,
      weekly: needWeekly ? applyStabilization("weekly", latestFutureReset(events, WEEKLY_LIMIT_TYPES, nowMs), nowMs) : null
    };
  } catch {
    return {
      session: needSession ? stableFallbackResets.session : null,
      weekly: needWeekly ? stableFallbackResets.weekly : null
    };
  }
};

export class ClaudeLoginExpiredError extends Error {
  constructor(
    message: string,
    readonly source: CredentialSource
  ) {
    super(message);
  }
}

const fetchUsagePayload = async (
  token: string,
  lang: Language,
  source: CredentialSource
): Promise<Record<string, unknown>> => {
  try {
    const response = await axios.get(CLAUDE_USAGE_URL, {
      headers: oauthHeaders(token),
      timeout: 15_000
    });
    return response.data as Record<string, unknown>;
  } catch (error) {
    // #region agent log
    {
      const axiosErr = axios.isAxiosError(error);
      const rawData = axiosErr ? error.response?.data : undefined;
      const dataPreview = (typeof rawData === "string"
        ? rawData
        : rawData && typeof rawData === "object"
          ? JSON.stringify(rawData)
          : "")
        .slice(0, 300)
        .replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-[redacted]");
      fetch("http://127.0.0.1:7281/ingest/bbb5ca65-8181-454e-a9ef-2fe1fab4b231", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "5b3081" },
        body: JSON.stringify({
          sessionId: "5b3081",
          hypothesisId: "H1",
          location: "claude-code.ts:fetchUsagePayload",
          message: "usage API request failed",
          data: {
            isAxios: axiosErr,
            status: axiosErr ? error.response?.status ?? null : null,
            code: axiosErr ? error.code ?? null : null,
            dataPreview,
            tokenLen: token.length,
            tokenPrefixOk: token.startsWith("sk-ant-oat01-"),
            source
          },
          timestamp: Date.now()
        })
      }).catch(() => {});
    }
    // #endregion
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 401) {
        throw new ClaudeLoginExpiredError(t(lang, "error.claudeLoginExpired"), source);
      }
      if (error.response?.status === 429) {
        throw new Error(t(lang, "error.claudeRateLimited"));
      }
    }
    throw new Error(t(lang, "error.claudeApiFailed"));
  }
};

/**
 * Fetches usage for a known token. Shared by the scheduled collector and by
 * the setup-token / paste-token path so validation is the same scrape.
 */
export const collectClaudeCodeQuotaFromToken = async (
  token: string,
  source: CredentialSource = "keychain"
): Promise<ScrapeResult> => {
  const lang = settingsStore.get().language;
  const payload = await fetchUsagePayload(token, lang, source);
  const limits = extractLimits(payload, lang);
  if (limits.length === 0) {
    return buildClaudeScrapeResult(limits, lang);
  }

  const { session, weekly } = selectPrimaryLimits(limits);
  // The usage API does not always return a reset time. Without one there is no
  // reset alarm to arm and no cooldown countdown to show, so fall back to what
  // the CLI recorded locally before giving up on it. Profile is independent of
  // quota windows; a failure there must not drop a successful usage scrape.
  const [cliResets, billingAnchorAt] = await Promise.all([
    readCliResetTimes(!session?.resetsAt, !weekly?.resetsAt),
    readSubscriptionCreatedAt(token)
  ]);
  const result = buildClaudeScrapeResult(limits, lang, cliResets);
  const cadence = settingsStore.get().claudeBillingCadence;
  const billingResetAt = billingAnchorAt ? nextBillingAt(billingAnchorAt, cadence, Date.now()) : null;
  return {
    ...result,
    billingAnchorAt,
    billingResetAt,
    billingResetLabel: billingResetAt ? t(lang, "fallback.claudeBilling") : null
  };
};

/**
 * Cached profile read. The subscription anchor changes at most when the user
 * switches plan; 24h is plenty, and a miss just means no billing alarm.
 */
const readSubscriptionCreatedAt = async (token: string): Promise<string | null> => {
  if (profileCache && Date.now() - profileCache.fetchedAt < PROFILE_CACHE_MS) {
    return profileCache.subscriptionCreatedAt;
  }
  try {
    const response = await axios.get(CLAUDE_PROFILE_URL, {
      headers: oauthHeaders(token),
      timeout: 15_000
    });
    const payload = response.data && typeof response.data === "object" ? (response.data as Record<string, unknown>) : {};
    const subscriptionCreatedAt = parseSubscriptionCreatedAt(payload);
    profileCache = { fetchedAt: Date.now(), subscriptionCreatedAt };
    return subscriptionCreatedAt;
  } catch {
    return profileCache?.subscriptionCreatedAt ?? null;
  }
};

/**
 * Proves a hand-pasted token actually works before it is stored, and returns
 * the usage already fetched so the monitor can apply it without a second request.
 *
 * A token that fails here is never written anywhere, so a typo cannot quietly
 * outrank the automatic sources and make the situation worse than it was.
 */
export const validateClaudeOAuthToken = async (token: string): Promise<ScrapeResult> => {
  const result = await collectClaudeCodeQuotaFromToken(token);
  if (result.windows.length === 0) {
    throw new Error(t(settingsStore.get().language, "error.claudeMissingFields"));
  }
  return result;
};

export const collectClaudeCodeQuota = async (): Promise<ScrapeResult> => {
  // Read the whole credential, not just the token, so a 401 below can still
  // tell the renderer which stored credential needs replacing.
  const { token, source } = await readClaudeCredential();
  return collectClaudeCodeQuotaFromToken(token, source);
};
