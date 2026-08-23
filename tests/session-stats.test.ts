import test from "node:test";
import assert from "node:assert/strict";
import { addWaterCup, computeSessionUsage } from "../src/shared/session-stats";
import type { CombinedSnapshot, QuotaSnapshot, QuotaWindow } from "../src/shared/types";

const windowOf = (partial: Partial<QuotaWindow> & Pick<QuotaWindow, "key">): QuotaWindow => ({
  label: partial.key,
  remaining: null,
  total: null,
  percent: null,
  resetsAt: null,
  ...partial
});

const snapshotOf = (service: "cursor" | "claude", windows: QuotaWindow[], remaining: number | null = null): QuotaSnapshot => ({
  service,
  remaining,
  total: service === "cursor" ? 20 : 100,
  percent: remaining,
  unit: service === "cursor" ? "usd" : "percent",
  resetsAt: null,
  windows,
  status: "ok",
  message: "",
  fetchedAt: "2026-01-01T00:00:00.000Z"
});

const combined = (cursor: QuotaSnapshot, claude: QuotaSnapshot): CombinedSnapshot => ({
  cursor,
  claude,
  fetchedAt: "2026-01-01T00:00:00.000Z"
});

test("computeSessionUsage reports remaining drop as consumed", () => {
  const baseline = combined(
    snapshotOf(
      "cursor",
      [
        windowOf({ key: "billing_cycle", remaining: 15, total: 20, percent: 75 }),
        windowOf({ key: "cursor_models", percent: 10 }),
        windowOf({ key: "other_models", percent: 20 })
      ],
      15
    ),
    snapshotOf(
      "claude",
      [windowOf({ key: "session", remaining: 80, percent: 80 }), windowOf({ key: "weekly", remaining: 90, percent: 90 })],
      80
    )
  );
  const current = combined(
    snapshotOf(
      "cursor",
      [
        windowOf({ key: "billing_cycle", remaining: 12.5, total: 20, percent: 62 }),
        windowOf({ key: "cursor_models", percent: 18 }),
        windowOf({ key: "other_models", percent: 25 })
      ],
      12.5
    ),
    snapshotOf(
      "claude",
      [windowOf({ key: "session", remaining: 70, percent: 70 }), windowOf({ key: "weekly", remaining: 85, percent: 85 })],
      70
    )
  );

  const usage = computeSessionUsage(baseline, current);
  assert.equal(usage.billing.kind, "consumed");
  assert.equal(usage.billing.used, 2.5);
  assert.equal(usage.cursorModels.kind, "consumed");
  assert.equal(usage.cursorModels.used, 8);
  assert.equal(usage.advancedModels.kind, "consumed");
  assert.equal(usage.advancedModels.used, 5);
  assert.equal(usage.claudeSession.kind, "consumed");
  assert.equal(usage.claudeSession.used, 10);
  assert.equal(usage.claudeWeekly.kind, "consumed");
  assert.equal(usage.claudeWeekly.used, 5);
});

test("computeSessionUsage marks a remaining rise as reset", () => {
  const baseline = combined(
    snapshotOf("cursor", [windowOf({ key: "billing_cycle", remaining: 2, total: 20 })], 2),
    snapshotOf("claude", [windowOf({ key: "session", remaining: 5 }), windowOf({ key: "weekly_all", remaining: 10 })], 5)
  );
  const current = combined(
    snapshotOf("cursor", [windowOf({ key: "billing_cycle", remaining: 20, total: 20 })], 20),
    snapshotOf("claude", [windowOf({ key: "session", remaining: 100 }), windowOf({ key: "weekly_all", remaining: 100 })], 100)
  );

  const usage = computeSessionUsage(baseline, current);
  assert.equal(usage.billing.kind, "reset");
  assert.equal(usage.billing.used, null);
  assert.equal(usage.claudeSession.kind, "reset");
  assert.equal(usage.claudeWeekly.kind, "reset");
});

test("computeSessionUsage treats a used-percent drop as reset", () => {
  const baseline = combined(
    snapshotOf("cursor", [windowOf({ key: "cursor_models", percent: 90 })]),
    snapshotOf("claude", [])
  );
  const current = combined(
    snapshotOf("cursor", [windowOf({ key: "cursor_models", percent: 5 })]),
    snapshotOf("claude", [])
  );

  const usage = computeSessionUsage(baseline, current);
  assert.equal(usage.cursorModels.kind, "reset");
});

test("computeSessionUsage is unknown without snapshots", () => {
  const usage = computeSessionUsage(null, null);
  assert.equal(usage.billing.kind, "unknown");
  assert.equal(usage.claudeSession.kind, "unknown");
  assert.equal(usage.claudeWeekly.kind, "unknown");
});

test("addWaterCup only accepts the three cup sizes", () => {
  const empty = { waterMl: 0, waterCups: 0 };
  assert.deepEqual(addWaterCup(empty, 250), { waterMl: 250, waterCups: 1 });
  assert.deepEqual(addWaterCup({ waterMl: 250, waterCups: 1 }, 500), { waterMl: 750, waterCups: 2 });
  assert.deepEqual(addWaterCup({ waterMl: 750, waterCups: 2 }, 1000), { waterMl: 1750, waterCups: 3 });
  assert.deepEqual(addWaterCup(empty, 300), empty);
  assert.deepEqual(addWaterCup(empty, "500"), empty);
});
