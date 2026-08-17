import test from "node:test";
import assert from "node:assert/strict";
import type { CombinedSnapshot } from "../src/shared/types";
import { getLowQuotaServices, isDuplicateInCooldown } from "../src/shared/monitor-utils";

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
  fetchedAt: new Date().toISOString()
});

test("getLowQuotaServices returns both low services", () => {
  const snapshot = baseSnapshot();
  snapshot.cursor.status = "low";
  snapshot.claude.status = "low";
  assert.deepEqual(getLowQuotaServices(snapshot), ["cursor", "claude"]);
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
