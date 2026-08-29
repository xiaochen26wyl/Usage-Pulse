import test from "node:test";
import assert from "node:assert/strict";
import type { CombinedSnapshot } from "../src/shared/types";
import {
  getLowQuotaServices,
  isDuplicateInCooldown,
  shouldClearLowQuotaLatch,
  stabilizeResetTime
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
  const drifted = "2026-08-26T15:03:00.000Z";
  assert.equal(stabilizeResetTime(cached, drifted, nowMs), cached);
  assert.equal(stabilizeResetTime(cached, null, nowMs), cached);
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
