import test from "node:test";
import assert from "node:assert/strict";
import {
  hasRecentRejection,
  latestFutureReset,
  parseQuotaLine,
  type ClaudeCliQuotaEvent
} from "../src/main/collectors/claude-cli-log";

// Shaped after a real line from ~/.claude/projects/<slug>/<uuid>.jsonl.
const rejectedLine = JSON.stringify({
  type: "assistant",
  timestamp: "2026-08-20T07:41:13.318Z",
  sessionId: "6e935551-c3c6-40ae-ae0f-abd71838996b",
  message: { content: "a private conversation nobody else should read" },
  quotaLimits: {
    status: "rejected",
    resetsAt: 1787221800,
    unifiedRateLimitFallbackAvailable: false,
    rateLimitType: "five_hour",
    overageStatus: "rejected",
    isUsingOverage: false
  }
});

test("a quota line yields only the four fields we care about", () => {
  const event = parseQuotaLine(rejectedLine);
  assert.deepEqual(event, {
    at: "2026-08-20T07:41:13.318Z",
    status: "rejected",
    rateLimitType: "five_hour",
    resetsAt: "2026-08-20T10:30:00.000Z"
  });
});

test("nothing from the message body survives parsing", () => {
  const event = parseQuotaLine(rejectedLine);
  assert.equal(JSON.stringify(event).includes("private conversation"), false);
  assert.equal(JSON.stringify(event).includes("sessionId"), false);
});

test("ordinary conversation lines and truncated lines are ignored", () => {
  assert.equal(parseQuotaLine(JSON.stringify({ type: "user", message: { content: "hello" } })), null);
  assert.equal(parseQuotaLine('{"type":"assistant","mess'), null);
  assert.equal(parseQuotaLine(""), null);
  assert.equal(parseQuotaLine(JSON.stringify({ quotaLimits: { resetsAt: 1 } })), null);
});

const event = (over: Partial<ClaudeCliQuotaEvent> = {}): ClaudeCliQuotaEvent => ({
  at: "2026-08-20T07:41:13.318Z",
  status: "rejected",
  rateLimitType: "five_hour",
  resetsAt: "2026-08-20T10:30:00.000Z",
  ...over
});

test("a rejection for this very window corroborates the lockout", () => {
  assert.ok(hasRecentRejection([event()], ["five_hour", "session"], "2026-08-20T10:30:00.000Z"));
});

test("a rejection from a previous cycle does not corroborate the current one", () => {
  assert.equal(hasRecentRejection([event()], ["five_hour"], "2026-08-21T10:30:00.000Z"), false);
});

test("a rejection for a different window does not corroborate", () => {
  assert.equal(
    hasRecentRejection([event({ rateLimitType: "seven_day" })], ["five_hour", "session"], "2026-08-20T10:30:00.000Z"),
    false
  );
});

test("a non-rejection status never corroborates", () => {
  assert.equal(hasRecentRejection([event({ status: "allowed" })], ["five_hour"], "2026-08-20T10:30:00.000Z"), false);
});

test("minor rounding between the CLI and the API still matches", () => {
  assert.ok(hasRecentRejection([event()], ["five_hour"], "2026-08-20T10:32:00.000Z"));
});

const nowMs = Date.parse("2026-08-20T09:00:00.000Z");

test("the newest still-future reset time is recovered for the window asked for", () => {
  const events = [
    event({ resetsAt: "2026-08-20T10:30:00.000Z" }),
    event({ resetsAt: "2026-08-20T11:30:00.000Z" })
  ];
  assert.equal(latestFutureReset(events, ["five_hour"], nowMs), "2026-08-20T11:30:00.000Z");
});

test("a reset time that has already passed is not recovered", () => {
  // A rejection from a spent cycle says nothing about the current one, and
  // arming an alarm for it would ring the moment it was seen.
  const events = [event({ resetsAt: "2026-08-20T08:00:00.000Z" })];
  assert.equal(latestFutureReset(events, ["five_hour"], nowMs), null);
});

test("another window's reset time is not borrowed", () => {
  const events = [event({ rateLimitType: "seven_day", resetsAt: "2026-08-25T00:00:00.000Z" })];
  assert.equal(latestFutureReset(events, ["five_hour", "session"], nowMs), null);
  assert.equal(latestFutureReset(events, ["seven_day"], nowMs), "2026-08-25T00:00:00.000Z");
});

test("no usable events yields no reset time", () => {
  assert.equal(latestFutureReset([], ["five_hour"], nowMs), null);
  assert.equal(latestFutureReset([event({ resetsAt: null })], ["five_hour"], nowMs), null);
});
