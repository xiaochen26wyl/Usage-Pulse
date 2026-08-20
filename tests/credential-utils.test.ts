import test from "node:test";
import assert from "node:assert/strict";
import {
  CREDENTIAL_CHECK_INTERVAL_MS,
  EXPIRING_SOON_MS,
  classifyCredentialState,
  isCredentialCheckDue,
  isCredentialUnusable
} from "../src/shared/credential-utils";

const NOW = Date.parse("2026-08-20T12:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

test("classifyCredentialState treats a credential without an expiry as ok", () => {
  assert.equal(classifyCredentialState(null, NOW), "ok");
  assert.equal(classifyCredentialState("not-a-date", NOW), "ok");
});

test("classifyCredentialState flags a credential that is already past its expiry", () => {
  assert.equal(classifyCredentialState(at(-1), NOW), "expired");
  // Exactly at the expiry instant counts as expired, not expiring.
  assert.equal(classifyCredentialState(at(0), NOW), "expired");
});

test("classifyCredentialState flags the expiring window but not a moment before it", () => {
  assert.equal(classifyCredentialState(at(EXPIRING_SOON_MS), NOW), "expiring");
  assert.equal(classifyCredentialState(at(EXPIRING_SOON_MS + 1), NOW), "ok");
  assert.equal(classifyCredentialState(at(EXPIRING_SOON_MS - 1), NOW), "expiring");
});

test("classifyCredentialState honours a custom expiring window", () => {
  assert.equal(classifyCredentialState(at(2 * 60_000), NOW, 60_000), "ok");
  assert.equal(classifyCredentialState(at(2 * 60_000), NOW, 5 * 60_000), "expiring");
});

test("isCredentialCheckDue treats a never-checked credential as due", () => {
  assert.equal(isCredentialCheckDue(null, NOW), true);
  assert.equal(isCredentialCheckDue("", NOW), true);
});

test("isCredentialCheckDue only fires once the full interval has elapsed", () => {
  assert.equal(isCredentialCheckDue(at(-CREDENTIAL_CHECK_INTERVAL_MS + 1), NOW), false);
  assert.equal(isCredentialCheckDue(at(-CREDENTIAL_CHECK_INTERVAL_MS), NOW), true);
});

test("isCredentialCheckDue catches sweeps skipped while the machine slept", () => {
  // Timers do not advance during sleep, so a check stamped eight hours ago is
  // how a wake-up learns it missed a cycle.
  assert.equal(isCredentialCheckDue(at(-8 * 60 * 60_000), NOW), true);
});

test("isCredentialUnusable separates broken credentials from healthy ones", () => {
  assert.equal(isCredentialUnusable("expired"), true);
  assert.equal(isCredentialUnusable("missing"), true);
  assert.equal(isCredentialUnusable("error"), true);
  assert.equal(isCredentialUnusable("expiring"), false);
  assert.equal(isCredentialUnusable("ok"), false);
});
