import test from "node:test";
import assert from "node:assert/strict";
import type { QuotaSnapshot } from "../src/shared/types";
import {
  buildCodexScrapeResult,
  classifyCodexWindowKey,
  extractCodexWindows,
  formatCodexCreditsText,
  normalizeCodexSnapshot
} from "../src/shared/codex-usage";

const NOW = Date.parse("2026-08-29T02:00:00.000Z");

test("classifyCodexWindowKey uses duration, not slot names", () => {
  assert.equal(classifyCodexWindowKey(18_000, "primary", null), "session");
  assert.equal(classifyCodexWindowKey(null, "primary_window", null), "session");
  assert.equal(classifyCodexWindowKey(null, "primary_window", null, 604_500), "weekly");
  assert.equal(classifyCodexWindowKey(604_800, "secondary", null), "weekly");
  assert.equal(classifyCodexWindowKey(null, "secondary_window", null), "weekly");
  assert.equal(classifyCodexWindowKey(604_800, "something_else", null), "weekly");
  assert.equal(classifyCodexWindowKey(86_400, "code_review", null), "code_review");
});

test("extractCodexWindows normalizes backend primary_window and secondary_window keys", () => {
  const windows = extractCodexWindows(
    {
      rate_limit: {
        primary_window: {
          used_percent: 40,
          reset_after_seconds: 3_600
        },
        secondary_window: {
          used_percent: 12,
          reset_after_seconds: 86_400
        }
      }
    },
    "en",
    NOW
  );

  assert.deepEqual(
    windows.map((window) => window.key),
    ["session", "weekly"]
  );
  assert.deepEqual(
    windows.map((window) => window.label),
    ["5-hour window", "Weekly quota"]
  );
});

test("extractCodexWindows treats a long primary_window countdown as weekly", () => {
  const windows = extractCodexWindows(
    {
      rate_limit: {
        primary_window: {
          used_percent: 0,
          reset_after_seconds: 604_500
        }
      }
    },
    "en",
    NOW
  );

  assert.deepEqual(
    windows.map((window) => window.key),
    ["weekly"]
  );
  assert.equal(windows[0]?.label, "Weekly quota");
});

test("normalizeCodexSnapshot repairs cached primary_window snapshots", () => {
  const snapshot: QuotaSnapshot = {
    service: "codex",
    remaining: 100,
    total: 100,
    percent: 100,
    unit: "percent",
    resetsAt: new Date(NOW + 604_500 * 1000).toISOString(),
    weeklyResetAt: null,
    windows: [
      {
        key: "primary_window",
        label: "primary_window",
        remaining: 100,
        total: 100,
        percent: 100,
        resetsAt: new Date(NOW + 604_500 * 1000).toISOString()
      }
    ],
    status: "ok",
    message: "",
    fetchedAt: new Date(NOW).toISOString()
  };

  const normalized = normalizeCodexSnapshot(snapshot, "en", NOW);

  assert.equal(normalized.windows[0]?.key, "weekly");
  assert.equal(normalized.windows[0]?.label, "Weekly quota");
  assert.equal(normalized.resetsAt, null);
  assert.equal(normalized.weeklyResetAt, snapshot.windows[0]?.resetsAt);
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

test("extractCodexWindows drops a slot-named window that cannot claim a slot", () => {
  const windows = extractCodexWindows(
    {
      rate_limit: {
        primary_window: {
          used_percent: 40,
          limit_window_seconds: 18_000,
          reset_after_seconds: 3_600
        },
        secondary_window: {
          used_percent: 12,
          limit_window_seconds: 604_800,
          reset_after_seconds: 86_400
        }
      },
      additional_rate_limits: [
        {
          name: "primary_window",
          used_percent: 0,
          limit_window_seconds: 604_800,
          reset_after_seconds: 604_740
        }
      ]
    },
    "en",
    NOW
  );

  assert.deepEqual(
    windows.map((window) => window.key),
    ["session", "weekly"]
  );
});

test("normalizeCodexSnapshot drops a cached slot-named duplicate", () => {
  const resetsAt = new Date(NOW + 604_740 * 1000).toISOString();
  const snapshot: QuotaSnapshot = {
    service: "codex",
    remaining: 60,
    total: 100,
    percent: 60,
    unit: "percent",
    resetsAt: new Date(NOW + 3_600 * 1000).toISOString(),
    weeklyResetAt: resetsAt,
    windows: [
      {
        key: "session",
        label: "5-hour window",
        remaining: 60,
        total: 100,
        percent: 60,
        resetsAt: new Date(NOW + 3_600 * 1000).toISOString()
      },
      {
        key: "weekly",
        label: "Weekly quota",
        remaining: 88,
        total: 100,
        percent: 88,
        resetsAt
      },
      {
        key: "primary_window",
        label: "primary_window",
        remaining: 100,
        total: 100,
        percent: 100,
        resetsAt: new Date(NOW + 7_200 * 1000).toISOString()
      }
    ],
    status: "ok",
    message: "",
    fetchedAt: new Date(NOW).toISOString()
  };

  const normalized = normalizeCodexSnapshot(snapshot, "en", NOW);

  assert.deepEqual(
    normalized.windows.map((window) => window.key),
    ["session", "weekly"]
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
