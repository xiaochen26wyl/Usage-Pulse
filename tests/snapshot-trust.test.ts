import test from "node:test";
import assert from "node:assert/strict";
import type { QuotaSnapshot, QuotaStatus, QuotaWindow } from "../src/shared/types";
import { isColdReading, isTrusted, trustOf } from "../src/shared/snapshot-trust";

const windows: QuotaWindow[] = [
  { key: "session", label: "5h", remaining: 40, total: 100, percent: 40, resetsAt: null }
];

const snapshot = (status: QuotaStatus, withWindows = true): QuotaSnapshot => ({
  service: "claude",
  remaining: 40,
  total: 100,
  percent: 40,
  unit: "percent",
  resetsAt: null,
  weeklyResetAt: null,
  windows: withWindows ? windows : [],
  status,
  message: "",
  fetchedAt: new Date().toISOString()
});

test("trustOf reports a missing snapshot as absent", () => {
  assert.equal(trustOf(null), "absent");
  assert.equal(trustOf(undefined), "absent");
});

test("trustOf reports a failed fetch and an unparseable payload as degraded", () => {
  assert.equal(trustOf(snapshot("error", false)), "degraded");
  assert.equal(trustOf(snapshot("unknown", false)), "degraded");
});

test("trustOf reports a windowless snapshot as degraded even when it claims to be ok", () => {
  assert.equal(trustOf(snapshot("ok", false)), "degraded");
});

test("trustOf trusts a snapshot carrying real windows", () => {
  assert.equal(trustOf(snapshot("ok")), "trusted");
  assert.equal(trustOf(snapshot("low")), "trusted");
  assert.ok(isTrusted(snapshot("low")));
});

test("isColdReading holds the first reading after no data at all", () => {
  assert.ok(isColdReading(null, snapshot("low")));
});

test("isColdReading holds the first reading after a credential outage", () => {
  assert.ok(isColdReading(snapshot("error", false), snapshot("low")));
  assert.ok(isColdReading(snapshot("unknown", false), snapshot("low")));
});

test("isColdReading holds a reading that is itself untrustworthy", () => {
  assert.ok(isColdReading(snapshot("ok"), snapshot("error", false)));
});

test("isColdReading lets two consecutive trustworthy readings through", () => {
  assert.equal(isColdReading(snapshot("ok"), snapshot("low")), false);
});
