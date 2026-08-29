import test from "node:test";
import assert from "node:assert/strict";
import { buildCodexScrapeResult, classifyCodexWindowKey, extractCodexWindows, formatCodexCreditsText } from "../src/shared/codex-usage";

const NOW = Date.parse("2026-08-29T02:00:00.000Z");

test("classifyCodexWindowKey uses duration, not slot names", () => {
  assert.equal(classifyCodexWindowKey(18_000, "primary", null), "session");
  assert.equal(classifyCodexWindowKey(604_800, "secondary", null), "weekly");
  assert.equal(classifyCodexWindowKey(604_800, "something_else", null), "weekly");
  assert.equal(classifyCodexWindowKey(86_400, "code_review", null), "code_review");
});

test("extractCodexWindows keeps extra windows after session and weekly are taken", () => {
  const windows = extractCodexWindows(
    {
      rate_limit: {
        primary: {
          used_percent: 40,
          limit_window_seconds: 18_000,
          reset_after_seconds: 3_600
        },
        secondary: {
          used_percent: 12,
          limit_window_seconds: 604_800,
          reset_after_seconds: 86_400
        }
      },
      additional_rate_limits: [
        {
          name: "gpt-5.1",
          used_percent: 8,
          limit_window_seconds: 18_000
        }
      ],
      code_review_rate_limit: {
        used_percent: 3,
        limit_window_seconds: 86_400
      }
    },
    "en",
    NOW
  );

  assert.deepEqual(
    windows.map((window) => window.key),
    ["session", "weekly", "gpt_5_1", "code_review"]
  );
});

test("buildCodexScrapeResult stores remaining percent and exposes credits", () => {
  const result = buildCodexScrapeResult(
    {
      rate_limit: {
        primary: { used_percent: 40, limit_window_seconds: 18_000 },
        secondary: { used_percent: 12, limit_window_seconds: 604_800 }
      },
      credits: { balance: 12.5 }
    },
    "en",
    NOW
  );

  const session = result.windows.find((window) => window.key === "session");
  const weekly = result.windows.find((window) => window.key === "weekly");
  assert.equal(session?.percent, 60);
  assert.equal(session?.remaining, 60);
  assert.equal(session?.total, 100);
  assert.equal(weekly?.percent, 88);
  assert.equal(result.creditsText, "Credits: 12.5");
});

test("formatCodexCreditsText reports unlimited credits", () => {
  assert.equal(formatCodexCreditsText({ credits: { unlimited: true } }, "en"), "Credits: unlimited");
});

test("buildCodexScrapeResult still returns credits when there are no windows", () => {
  const result = buildCodexScrapeResult({ credits: { balance: 0 } }, "zh", NOW);
  assert.equal(result.windows.length, 0);
  assert.equal(result.creditsText, "Credits：0");
});
