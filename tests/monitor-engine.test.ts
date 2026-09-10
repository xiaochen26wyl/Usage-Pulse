import test from "node:test";
import assert from "node:assert/strict";
import type { CombinedSnapshot, QuotaWindow } from "../src/shared/types";
import {
  getLowQuotaServices,
  isDuplicateInCooldown,
  shouldClearLowQuotaLatch,
  stabilizeResetTime,
  stabilizeWindowResets
} from "../src/shared/monitor-utils";

const baseSnapshot = (): CombinedSnapshot => ({
  cursor: {
    service: "cursor",
    remaining: 10,
    total: 100,
    percent: 10,
    unit: "usd",
    resetsAt: null,
    weeklyResetAt: null,
    windows: [],
    status: "ok",
    message: "",
    fetchedAt: new Date().toISOString()
  },
  claude: {
    service: "claude",
    remaining: 80,
    total: 100,
    percent: 80,
    unit: "percent",
    resetsAt: null,
    weeklyResetAt: null,
    windows: [],
    status: "ok",
    message: "",
    fetchedAt: new Date().toISOString()
  },
  codex: {
    service: "codex",
    remaining: 80,
    total: 100,
    percent: 80,
    unit: "percent",
    resetsAt: null,
    weeklyResetAt: null,
    windows: [],
    status: "ok",
    message: "",
    fetchedAt: new Date().toISOString()
  },
  fetchedAt: new Date().toISOString()
});

test("getLowQuotaServices returns both low services", () => {
  const snapshot = baseSnapshot();
  snapshot.cursor.status = "low";
  snapshot.claude.status = "low";
  assert.deepEqual(getLowQuotaServices(snapshot), ["cursor", "claude"]);
});

test("getLowQuotaServices includes Codex when it is low", () => {
  const snapshot = baseSnapshot();
  snapshot.codex.status = "low";
  assert.deepEqual(getLowQuotaServices(snapshot), ["codex"]);
});

test("isDuplicateInCooldown checks key and cooldown window", () => {
  const nowMs = Date.now();
  const last = {
    key: "low:cursor|10",
    at: new Date(nowMs - 2 * 60_000).toISOString()
  };

  assert.equal(isDuplicateInCooldown(last, "low:cursor|10", 5 * 60_000, nowMs), true);
  assert.equal(isDuplicateInCooldown(last, "low:claude|10", 5 * 60_000, nowMs), false);
  assert.equal(isDuplicateInCooldown(last, "low:cursor|10", 60_000, nowMs), false);
});

test("shouldClearLowQuotaLatch stays closed on an unknown reading", () => {
  assert.equal(shouldClearLowQuotaLatch(null, 20, 5), false);
});

test("shouldClearLowQuotaLatch stays closed while inside the hysteresis band", () => {
  assert.equal(shouldClearLowQuotaLatch(20, 20, 5), false);
  assert.equal(shouldClearLowQuotaLatch(24, 20, 5), false);
  assert.equal(shouldClearLowQuotaLatch(25, 20, 5), false);
});

test("shouldClearLowQuotaLatch clears once the reading is past the hysteresis margin", () => {
  assert.equal(shouldClearLowQuotaLatch(26, 20, 5), true);
  assert.equal(shouldClearLowQuotaLatch(100, 20, 5), true);
});

test("stabilizeResetTime holds a still-future cached value instead of taking a drifted candidate", () => {
  const nowMs = Date.parse("2026-08-26T10:00:00.000Z");
  const cached = "2026-08-26T15:00:00.000Z";
  const drifted = "2026-08-26T15:00:03.000Z"; // 3s: realistic recompute jitter
  assert.equal(stabilizeResetTime(cached, drifted, nowMs), cached);
  assert.equal(stabilizeResetTime(cached, null, nowMs), cached);
});

test("stabilizeResetTime holds a candidate exactly at the jitter tolerance boundary", () => {
  const nowMs = Date.parse("2026-08-26T10:00:00.000Z");
  const cached = "2026-08-26T15:00:00.000Z";
  const atBoundary = "2026-08-26T15:01:00.000Z"; // exactly 60_000ms
  assert.equal(stabilizeResetTime(cached, atBoundary, nowMs), cached);
});

test("stabilizeResetTime trusts a materially different candidate even though cached hasn't elapsed by the app's clock (genuine early reset)", () => {
  const nowMs = Date.parse("2026-08-26T10:00:00.000Z");
  const cached = "2026-08-26T15:00:00.000Z";
  const genuinelyEarlier = "2026-08-26T14:50:00.000Z"; // 10 min earlier, well past jitter tolerance
  assert.equal(stabilizeResetTime(cached, genuinelyEarlier, nowMs), genuinelyEarlier);
});

test("stabilizeResetTime accepts a new candidate once the cached value has elapsed", () => {
  const nowMs = Date.parse("2026-08-26T10:00:00.000Z");
  const elapsedCache = "2026-08-26T09:59:00.000Z";
  const nextCycle = "2026-08-26T15:00:00.000Z";
  assert.equal(stabilizeResetTime(elapsedCache, nextCycle, nowMs), nextCycle);
  assert.equal(stabilizeResetTime(elapsedCache, null, nowMs), null);
});

test("stabilizeResetTime accepts the first candidate when there is no cache yet", () => {
  const nowMs = Date.parse("2026-08-26T10:00:00.000Z");
  assert.equal(stabilizeResetTime(null, "2026-08-26T15:00:00.000Z", nowMs), "2026-08-26T15:00:00.000Z");
  assert.equal(stabilizeResetTime(null, null, nowMs), null);
});

const window = (key: string, resetsAt: string | null): QuotaWindow => ({
  key,
  label: key,
  remaining: 10,
  total: 100,
  percent: 10,
  resetsAt
});

test("stabilizeWindowResets pins a window's resetsAt to the previous poll's value while it's still in the future", () => {
  // Simulates Codex's reset_after_seconds being recomputed as `now + secondsLeft`
  // on every poll: the same underlying reset drifts by a couple of seconds
  // between two polls a moment apart.
  const nowMs = Date.parse("2026-08-26T10:00:00.000Z");
  const previous = [window("session", "2026-08-26T15:00:00.000Z")];
  const next = [window("session", "2026-08-26T15:00:02.000Z")];

  const stabilized = stabilizeWindowResets(previous, next, nowMs);

  assert.equal(stabilized[0].resetsAt, "2026-08-26T15:00:00.000Z");
});

test("stabilizeWindowResets matches windows by key, not array position", () => {
  const nowMs = Date.parse("2026-08-26T10:00:00.000Z");
  const previous = [window("weekly", "2026-08-27T00:00:00.000Z"), window("session", "2026-08-26T15:00:00.000Z")];
  const next = [window("session", "2026-08-26T15:00:03.000Z"), window("weekly", "2026-08-27T00:00:04.000Z")];

  const stabilized = stabilizeWindowResets(previous, next, nowMs);

  assert.equal(stabilized.find((w) => w.key === "session")?.resetsAt, "2026-08-26T15:00:00.000Z");
  assert.equal(stabilized.find((w) => w.key === "weekly")?.resetsAt, "2026-08-27T00:00:00.000Z");
});

test("stabilizeWindowResets lets a genuinely new cycle through once the cached reset has elapsed", () => {
  const nowMs = Date.parse("2026-08-26T16:00:00.000Z");
  const previous = [window("session", "2026-08-26T15:00:00.000Z")];
  const next = [window("session", "2026-08-26T21:00:00.000Z")];

  const stabilized = stabilizeWindowResets(previous, next, nowMs);

  assert.equal(stabilized[0].resetsAt, "2026-08-26T21:00:00.000Z");
});

test("stabilizeWindowResets lets a genuinely early reset through even while the cached value is still in the app's future", () => {
  const nowMs = Date.parse("2026-08-26T10:00:00.000Z");
  const previous = [window("session", "2026-08-26T15:00:00.000Z")];
  const next = [window("session", "2026-08-26T12:00:00.000Z")]; // real server-side reset landed earlier

  const stabilized = stabilizeWindowResets(previous, next, nowMs);

  assert.equal(stabilized[0].resetsAt, "2026-08-26T12:00:00.000Z");
});

test("stabilizeWindowResets passes windows through untouched when there is no previous poll", () => {
  const nowMs = Date.parse("2026-08-26T10:00:00.000Z");
  const next = [window("session", "2026-08-26T15:00:00.000Z")];

  assert.equal(stabilizeWindowResets(null, next, nowMs), next);
});
