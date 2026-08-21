import test from "node:test";
import assert from "node:assert/strict";
import { detectLimitKey, parseLimitObject, toIsoTime, toPercentField, toRatioField } from "../src/shared/claude-usage";

test("a percent-scale field is taken at face value, not rescaled", () => {
  // The regression this guards: 1 % used used to be read as 100 % used, which
  // turned a barely-touched window into a "quota used up" popup.
  assert.equal(toPercentField(1), 1);
  assert.equal(toPercentField(0), 0);
  assert.equal(toPercentField(37), 37);
  assert.equal(toPercentField(100), 100);
});

test("a percent-scale field is clamped to 0-100", () => {
  assert.equal(toPercentField(-5), 0);
  assert.equal(toPercentField(140), 100);
});

test("a percent-scale field accepts numeric strings and rejects everything else", () => {
  assert.equal(toPercentField("42"), 42);
  assert.equal(toPercentField(""), null);
  assert.equal(toPercentField(null), null);
  assert.equal(toPercentField({}), null);
});

test("the ratio field is the only one scaled up to percent", () => {
  assert.equal(toRatioField(0.01), 1);
  assert.equal(toRatioField(1), 100);
  assert.equal(toRatioField(0), 0);
});

test("toIsoTime distinguishes epoch seconds from milliseconds", () => {
  assert.equal(toIsoTime(1787221800), "2026-08-20T10:30:00.000Z");
  assert.equal(toIsoTime(1787221800000), "2026-08-20T10:30:00.000Z");
  assert.equal(toIsoTime("2026-08-20T10:30:00.000Z"), "2026-08-20T10:30:00.000Z");
  assert.equal(toIsoTime("not a date"), null);
});

test("detectLimitKey normalizes the window names the API has used", () => {
  assert.equal(detectLimitKey("five_hour"), "session");
  assert.equal(detectLimitKey("SESSION"), "session");
  assert.equal(detectLimitKey("seven_day_all"), "weekly_all");
  assert.equal(detectLimitKey("weekly_scoped"), "weekly_scoped");
  assert.equal(detectLimitKey("seven_day"), "weekly");
  assert.equal(detectLimitKey(""), "unknown");
});

test("a reset time is picked up whichever spelling the payload uses", () => {
  // The payload ships snake_case window keys (five_hour, seven_day_all), so
  // resets_at has to be understood too — only accepting resetsAt/reset_at left
  // every window with a null reset time, and with it no reset alarm at all.
  const lang = "en" as const;
  const spellings = ["resetsAt", "resets_at", "resetAt", "reset_at", "resetTime", "reset_time"];
  for (const field of spellings) {
    const parsed = parseLimitObject({ name: "five_hour", utilization: 40, [field]: 1787221800 }, lang);
    assert.equal(parsed?.resetsAt, "2026-08-20T10:30:00.000Z", `failed for ${field}`);
  }
});

test("a limit with no reset time at all parses without one", () => {
  const parsed = parseLimitObject({ name: "five_hour", utilization: 40 }, "en");
  assert.equal(parsed?.resetsAt, null);
  assert.equal(parsed?.usedPercent, 40);
});
