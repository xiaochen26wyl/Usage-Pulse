import test from "node:test";
import assert from "node:assert/strict";
import {
  CLAUDE_SESSION_WINDOW_MS,
  ESTIMATED_CYCLE_KEY,
  UNKNOWN_CYCLE_KEY,
  cycleKeyFor,
  isSilencedUntilRestore,
  resolveRestoreAt,
  type AlertSilenceRecord
} from "../src/shared/alert-silence";

const NOW = Date.parse("2026-08-23T01:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const record = (patch: Partial<AlertSilenceRecord> = {}): AlertSilenceRecord => ({
  key: "2026-08-23T06:00:00.000Z",
  at: at(0),
  restoreAt: "2026-08-23T06:00:00.000Z",
  ...patch
});

test("resolveRestoreAt uses the official reset time when present", () => {
  const official = at(2 * 60 * 60_000);
  assert.equal(resolveRestoreAt({ kind: "billing", officialResetAt: official, nowMs: NOW }), official);
  assert.equal(resolveRestoreAt({ kind: "session", officialResetAt: official, nowMs: NOW }), official);
  assert.equal(resolveRestoreAt({ kind: "weekly", officialResetAt: official, nowMs: NOW }), official);
});

test("resolveRestoreAt estimates five hours only for the Claude session window", () => {
  const estimated = new Date(NOW + CLAUDE_SESSION_WINDOW_MS).toISOString();
  assert.equal(resolveRestoreAt({ kind: "session", officialResetAt: null, nowMs: NOW }), estimated);
  assert.equal(resolveRestoreAt({ kind: "billing", officialResetAt: null, nowMs: NOW }), null);
  assert.equal(resolveRestoreAt({ kind: "weekly", officialResetAt: undefined, nowMs: NOW }), null);
});

test("cycleKeyFor prefers the official reset, then estimated, then unknown", () => {
  const official = at(3_600_000);
  const estimated = at(CLAUDE_SESSION_WINDOW_MS);
  assert.equal(cycleKeyFor(official, estimated), official);
  assert.equal(cycleKeyFor(null, estimated), ESTIMATED_CYCLE_KEY);
  assert.equal(cycleKeyFor(null, null), UNKNOWN_CYCLE_KEY);
});

test("same official resetsAt stays silenced", () => {
  const cycle = "2026-08-23T06:00:00.000Z";
  const last = record({ key: cycle, restoreAt: cycle });
  assert.equal(isSilencedUntilRestore(last, cycle, NOW + 15 * 60_000), true);
  assert.equal(isSilencedUntilRestore(last, cycle, NOW + 4 * 60 * 60_000), true);
});

test("a new official resetsAt allows another alert", () => {
  const last = record({
    key: "2026-08-23T06:00:00.000Z",
    restoreAt: "2026-08-23T06:00:00.000Z"
  });
  assert.equal(isSilencedUntilRestore(last, "2026-08-23T12:00:00.000Z", NOW), false);
});

test("clearing the record after remaining recovers allows another alert", () => {
  assert.equal(isSilencedUntilRestore({ key: "", at: "", restoreAt: null }, "2026-08-23T06:00:00.000Z", NOW), false);
  assert.equal(isSilencedUntilRestore(null, "2026-08-23T06:00:00.000Z", NOW), false);
});

test("Claude session without resetsAt is silent for five hours, then may fire again", () => {
  const restoreAt = new Date(NOW + CLAUDE_SESSION_WINDOW_MS).toISOString();
  const last = record({ key: ESTIMATED_CYCLE_KEY, restoreAt });
  assert.equal(isSilencedUntilRestore(last, ESTIMATED_CYCLE_KEY, NOW + 60_000), true);
  assert.equal(isSilencedUntilRestore(last, ESTIMATED_CYCLE_KEY, NOW + CLAUDE_SESSION_WINDOW_MS - 1), true);
  assert.equal(isSilencedUntilRestore(last, ESTIMATED_CYCLE_KEY, NOW + CLAUDE_SESSION_WINDOW_MS), false);
});

test("an official session cycle unlocks an estimated silence early", () => {
  const last = record({
    key: ESTIMATED_CYCLE_KEY,
    restoreAt: new Date(NOW + CLAUDE_SESSION_WINDOW_MS).toISOString()
  });
  assert.equal(isSilencedUntilRestore(last, "2026-08-23T08:00:00.000Z", NOW + 60_000), false);
});

test("Cursor and weekly without an official time stay silent until recovery", () => {
  const last = record({ key: UNKNOWN_CYCLE_KEY, restoreAt: null });
  assert.equal(isSilencedUntilRestore(last, UNKNOWN_CYCLE_KEY, NOW + CLAUDE_SESSION_WINDOW_MS), true);
  assert.equal(isSilencedUntilRestore(last, UNKNOWN_CYCLE_KEY, NOW + 7 * 24 * 60 * 60_000), true);
  assert.equal(isSilencedUntilRestore(last, "2026-09-01T00:00:00.000Z", NOW), false);
});
