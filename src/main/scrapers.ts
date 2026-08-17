import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import type { ScrapeResult, ServiceType } from "@shared/types";
import { CLAUDE_REMAINING_REGEXES, CURSOR_FAST_REQUEST_REGEXES, SERVICE_LABELS } from "@main/config";
import { getAuthFilePath } from "@main/auth-service";

const ensureAuthReadable = async (service: ServiceType): Promise<string> => {
  const path = await getAuthFilePath(service);
  await readFile(path, "utf-8");
  return path;
};

const parseCursorFastRequests = (text: string): ScrapeResult => {
  for (const regex of CURSOR_FAST_REQUEST_REGEXES) {
    const match = text.match(regex);
    if (!match) {
      continue;
    }
    if (match.length >= 3) {
      const remaining = Number(match[1]);
      const total = Number(match[2]);
      if (!Number.isNaN(remaining) && !Number.isNaN(total)) {
        return {
          remaining,
          total,
          message: `Cursor Fast Requests ${remaining}/${total}`
        };
      }
    }
    if (match.length >= 2) {
      const remaining = Number(match[1]);
      if (!Number.isNaN(remaining)) {
        return {
          remaining,
          total: null,
          message: `Cursor Fast Requests remaining ${remaining}`
        };
      }
    }
  }
  return {
    remaining: null,
    total: null,
    message: "找不到 Cursor Fast Requests 數值"
  };
};

const parseClaudeRemaining = (text: string): ScrapeResult => {
  for (const regex of CLAUDE_REMAINING_REGEXES) {
    const match = text.match(regex);
    if (!match) {
      continue;
    }
    const remaining = Number(match[1]);
    if (!Number.isNaN(remaining)) {
      return {
        remaining,
        total: null,
        message: `Claude Remaining messages ${remaining}`
      };
    }
  }

  if (/message limit reached|too many requests|try again later/i.test(text)) {
    return {
      remaining: 0,
      total: null,
      message: "Claude 已觸發訊息額度限制"
    };
  }

  return {
    remaining: null,
    total: null,
    message: "找不到 Claude Remaining messages 提示"
  };
};

const runScraper = async (service: ServiceType): Promise<ScrapeResult> => {
  const storageState = await ensureAuthReadable(service);
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();
    await page.goto(
      service === "cursor" ? "https://www.cursor.com/settings" : "https://claude.ai",
      {
        waitUntil: "domcontentloaded",
        timeout: 60_000
      }
    );

    await page.waitForTimeout(2500);
    const bodyText = await page.evaluate(() => document.body?.innerText ?? "");

    if (service === "cursor") {
      return parseCursorFastRequests(bodyText);
    }
    return parseClaudeRemaining(bodyText);
  } finally {
    await browser.close();
  }
};

export const scrapeQuota = async (service: ServiceType): Promise<ScrapeResult> => {
  try {
    return await runScraper(service);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return {
      remaining: null,
      total: null,
      message: `${SERVICE_LABELS[service]} 抓取失敗: ${message}`
    };
  }
};
