import axios, { type AxiosError } from "axios";
import type { CredentialSource, ScrapeResult } from "@shared/types";
import { t } from "@shared/i18n";
import { buildCodexScrapeResult } from "@shared/codex-usage";
import { getCodexAuthContext } from "@main/credential-provider";
import { settingsStore } from "@main/store";

const USAGE_URLS = [
  "https://chatgpt.com/backend-api/wham/usage",
  "https://chatgpt.com/backend-api/codex/usage"
] as const;

export class CodexLoginExpiredError extends Error {
  readonly source: CredentialSource;

  constructor(source: CredentialSource, message: string) {
    super(message);
    this.name = "CodexLoginExpiredError";
    this.source = source;
  }
}

const isAxiosError = (error: unknown): error is AxiosError =>
  Boolean(error) && typeof error === "object" && (error as AxiosError).isAxiosError === true;

const statusOf = (error: unknown): number | null => {
  if (!isAxiosError(error)) {
    return null;
  }
  const status = error.response?.status;
  return typeof status === "number" ? status : null;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const usageHeaders = (token: string, accountId: string | null): Record<string, string> => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    originator: "Codex Desktop",
    "OAI-Product-Sku": "CODEX"
  };
  if (accountId) {
    headers["ChatGPT-Account-Id"] = accountId;
    headers["chatgpt-account-id"] = accountId;
  }
  return headers;
};

const fetchUsagePayload = async (token: string, accountId: string | null): Promise<Record<string, unknown>> => {
  let lastError: unknown = null;
  for (const url of USAGE_URLS) {
    try {
      const response = await axios.get(url, {
        headers: usageHeaders(token, accountId),
        timeout: 15_000
      });
      const payload = asRecord(response.data);
      if (payload) {
        return payload;
      }
    } catch (error) {
      lastError = error;
      const status = statusOf(error);
      if (status === 401 || status === 403) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Codex usage API request failed");
};

export const collectCodexQuota = async (): Promise<ScrapeResult> => {
  const lang = settingsStore.get().language;
  const auth = await getCodexAuthContext();
  try {
    const payload = await fetchUsagePayload(auth.token, auth.accountId);
    return buildCodexScrapeResult(payload, lang);
  } catch (error) {
    const status = statusOf(error);
    if (status === 401 || status === 403) {
      throw new CodexLoginExpiredError(auth.source, t(lang, "error.codexLoginExpired"));
    }
    const detail = error instanceof Error ? error.message : t(lang, "scrape.unknownError");
    throw new Error(t(lang, "error.codexApiFailed") + ` (${detail})`);
  }
};
