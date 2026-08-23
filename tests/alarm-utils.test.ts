import test from "node:test";
import assert from "node:assert/strict";
import {
  DUE_GRACE_MS,
  MAX_TIMEOUT_MS,
  clampTimeoutMs,
  classifyFire,
  collectAlarmTargets,
  nextTarget
} from "../src/shared/alarm-utils";
import type { AppSettings, CombinedSnapshot, QuotaSnapshot } from "../src/shared/types";

const NOW = Date.parse("2026-08-20T12:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const settings = (patch: Partial<AppSettings> = {}): AppSettings =>
  ({
    cursorIntervalMinutes: 10,
    claudeIntervalMinutes: 10,
    cursorAdvancedModelsLowThresholdPercent: 20,
    enableCursorAdvancedModelsLowAlert: true,
    cursorModelsLowThresholdPercent: 20,
    enableCursorModelsLowAlert: true,
    claudeSessionLowThresholdPercent: 20,
    enableClaudeSessionLowAlert: true,
    claudeWeeklyLowThresholdPercent: 20,
    enableClaudeWeeklyLowAlert: true,
    enableClaudeCooldownAlert: true,
    launchWithIde: false,
    notifyCooldownMinutes: 15,
    enableCursorResetAlarm: true,
    enableClaudeResetAlarm: true,
    enableClaudeWeeklyResetAlarm: true,
    enableClaudeBillingAlarm: true,
    claudeBillingCadence: "monthly",
    language: "zh",
    trayValueColorMode: "system",
    enableAlarmPopup: true,
    enableLineNotification: true,
    lineChannelAccessToken: "",
    ...patch
  }) as AppSettings;

const quota = (patch: Partial<QuotaSnapshot> = {}): QuotaSnapshot =>
  ({
    service: "cursor",
    remaining: 10,
    total: 20,
    percent: 50,
    unit: "usd",
    resetsAt: null,
    windows: [],
    status: "ok",
    message: "",
    fetchedAt: at(0),
    ...patch
  }) as QuotaSnapshot;

const snapshot = (cursor: Partial<QuotaSnapshot>, claude: Partial<QuotaSnapshot>): CombinedSnapshot => ({
  cursor: quota({ service: "cursor", ...cursor }),
  claude: quota({ service: "claude", ...claude }),
  fetchedAt: at(0)
});

test("classifyFire treats a future firing as pending", () => {
  assert.equal(classifyFire(at(60_000), NOW), "pending");
});

test("classifyFire treats a slightly late firing as on time", () => {
  assert.equal(classifyFire(at(-1_000), NOW), "due");
  assert.equal(classifyFire(at(-DUE_GRACE_MS), NOW), "due");
});

test("classifyFire drops a firing past the grace window as expired (no catch-up)", () => {
  assert.equal(classifyFire(at(-DUE_GRACE_MS - 1), NOW), "expired");
  assert.equal(classifyFire(at(-30 * 60_000), NOW), "expired");
  assert.equal(classifyFire(at(-24 * 60 * 60_000), NOW), "expired");
});

test("classifyFire drops an unparseable timestamp", () => {
  assert.equal(classifyFire("not-a-date", NOW), "expired");
});

test("collectAlarmTargets gathers every enabled reset window", () => {
  const targets = collectAlarmTargets(
    snapshot(
      { resetsAt: at(3_600_000), resetLabel: "Billing" },
      { resetsAt: at(600_000), resetLabel: "Session", weeklyResetAt: at(7_200_000), weeklyResetLabel: "Weekly" }
    ),
    settings(),
    "zh"
  );

  assert.deepEqual(
    targets.map((target) => target.id),
    ["cursor-billing", "claude-session", "claude-weekly"]
  );
});

test("collectAlarmTargets honours the per-service reset toggles", () => {
  const targets = collectAlarmTargets(
    snapshot({ resetsAt: at(3_600_000) }, { resetsAt: at(600_000), weeklyResetAt: at(7_200_000) }),
    settings({
      enableClaudeResetAlarm: false,
      enableClaudeWeeklyResetAlarm: false,
      enableClaudeBillingAlarm: false
    }),
    "zh"
  );

  assert.deepEqual(
    targets.map((target) => target.id),
    ["cursor-billing"]
  );
});

test("collectAlarmTargets treats Claude session, weekly, and billing as independent toggles", () => {
  const combined = snapshot(
    { resetsAt: null },
    {
      resetsAt: at(600_000),
      weeklyResetAt: at(7_200_000),
      billingAnchorAt: "2026-07-20T12:00:00.000Z"
    }
  );

  const weeklyOnly = collectAlarmTargets(
    combined,
    settings({ enableClaudeResetAlarm: false, enableClaudeBillingAlarm: false }),
    "zh",
    {},
    NOW
  );
  assert.deepEqual(
    weeklyOnly.map((target) => target.id),
    ["claude-weekly"]
  );

  const billingOnly = collectAlarmTargets(
    combined,
    settings({ enableClaudeResetAlarm: false, enableClaudeWeeklyResetAlarm: false }),
    "zh",
    {},
    NOW
  );
  assert.deepEqual(
    billingOnly.map((target) => target.id),
    ["claude-billing"]
  );
  assert.equal(billingOnly[0]?.fireAt, "2026-08-20T12:00:00.000Z");
});

test("collectAlarmTargets skips missing and unparseable reset times", () => {
  const targets = collectAlarmTargets(
    snapshot({ resetsAt: null }, { resetsAt: "nonsense", weeklyResetAt: at(60_000) }),
    settings(),
    "zh"
  );

  assert.deepEqual(
    targets.map((target) => target.id),
    ["claude-weekly"]
  );
});

test("nextTarget picks the soonest future firing and ignores past ones", () => {
  const targets = collectAlarmTargets(
    snapshot(
      { resetsAt: at(-60_000) },
      { resetsAt: at(900_000), weeklyResetAt: at(300_000) }
    ),
    settings(),
    "zh"
  );

  assert.equal(nextTarget(targets, NOW)?.id, "claude-weekly");
});

test("nextTarget returns null when nothing is in the future", () => {
  const targets = collectAlarmTargets(snapshot({ resetsAt: at(-60_000) }, {}), settings(), "zh");
  assert.equal(nextTarget(targets, NOW), null);
});

test("clampTimeoutMs keeps delays inside the setTimeout ceiling", () => {
  assert.equal(clampTimeoutMs(-5), 0);
  assert.equal(clampTimeoutMs(1_000), 1_000);
  assert.equal(clampTimeoutMs(MAX_TIMEOUT_MS + 10_000), MAX_TIMEOUT_MS);
  assert.equal(clampTimeoutMs(Number.NaN), 0);
});
