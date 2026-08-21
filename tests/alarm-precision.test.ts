import test from "node:test";
import assert from "node:assert/strict";
import type { AppSettings, CombinedSnapshot, QuotaSnapshot, QuotaStatus } from "../src/shared/types";
import { collectAlarmTargets, mayFire } from "../src/shared/alarm-utils";
import { DEFAULT_SETTINGS } from "../src/main/config";

const serviceSnapshot = (
  service: QuotaSnapshot["service"],
  status: QuotaStatus,
  resetsAt: string | null,
  withWindows: boolean
): QuotaSnapshot => ({
  service,
  remaining: withWindows ? 40 : null,
  total: withWindows ? 100 : null,
  percent: withWindows ? 40 : null,
  unit: service === "cursor" ? "usd" : "percent",
  resetsAt,
  weeklyResetAt: null,
  windows: withWindows ? [{ key: "session", label: "5h", remaining: 40, total: 100, percent: 40, resetsAt }] : [],
  status,
  message: "",
  fetchedAt: new Date().toISOString()
});

const combined = (claude: QuotaSnapshot): CombinedSnapshot => ({
  cursor: serviceSnapshot("cursor", "ok", null, true),
  claude,
  fetchedAt: new Date().toISOString()
});

const settings: AppSettings = { ...DEFAULT_SETTINGS };

test("a healthy snapshot arms from its own reset time", () => {
  const targets = collectAlarmTargets(combined(serviceSnapshot("claude", "ok", "2026-09-01T00:00:00.000Z", true)), settings, "zh");
  const session = targets.find((target) => target.id === "claude-session");
  assert.equal(session?.fireAt, "2026-09-01T00:00:00.000Z");
});

test("a credential outage falls back to the last trustworthy reset time", () => {
  // Without the fallback, the blanked resetsAt would silently disarm a real
  // pending alarm and the reset would pass with nothing to show for it.
  const outage = combined(serviceSnapshot("claude", "error", null, false));
  const targets = collectAlarmTargets(outage, settings, "zh", {
    "claude-session": "2026-09-01T00:00:00.000Z"
  });
  const session = targets.find((target) => target.id === "claude-session");
  assert.equal(session?.fireAt, "2026-09-01T00:00:00.000Z");
});

test("a healthy snapshot with no reset time does not resurrect a stale one", () => {
  const targets = collectAlarmTargets(combined(serviceSnapshot("claude", "ok", null, true)), settings, "zh", {
    "claude-session": "2026-09-01T00:00:00.000Z"
  });
  assert.equal(
    targets.find((target) => target.id === "claude-session"),
    undefined
  );
});

test("the service toggle still wins over the fallback", () => {
  const targets = collectAlarmTargets(
    combined(serviceSnapshot("claude", "error", null, false)),
    { ...settings, enableClaudeResetAlarm: false },
    "zh",
    { "claude-session": "2026-09-01T00:00:00.000Z" }
  );
  assert.equal(targets.some((target) => target.service === "claude"), false);
});

test("mayFire refuses a fireAt that was never observed pending", () => {
  assert.equal(mayFire("2026-09-01T00:00:00.000Z", null), false);
  assert.equal(mayFire("2026-09-01T00:00:00.000Z", undefined), false);
});

test("mayFire refuses a fireAt observed for a different cycle", () => {
  assert.equal(mayFire("2026-09-01T00:00:00.000Z", "2026-08-25T00:00:00.000Z"), false);
});

test("mayFire allows a fireAt we watched go from pending to due", () => {
  assert.ok(mayFire("2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z"));
});
