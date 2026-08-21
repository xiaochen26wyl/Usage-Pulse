import test from "node:test";
import assert from "node:assert/strict";
import {
  MANUAL_PROMPT_REPEAT_MS,
  nextAutoFailureCount,
  shouldOfferManualEntry
} from "../src/shared/credential-utils";

const now = Date.parse("2026-08-20T12:00:00.000Z");

test("a failed attempt increments the streak and a good one clears it", () => {
  assert.equal(nextAutoFailureCount(undefined, true), 1);
  assert.equal(nextAutoFailureCount(1, true), 2);
  assert.equal(nextAutoFailureCount(4, false), 0);
  assert.equal(nextAutoFailureCount(undefined, false), 0);
});

test("one failure is not enough to interrupt the user", () => {
  // Automatic detection gets a genuine second attempt: a lone failure is
  // routinely a Keychain prompt that timed out or an IDE mid-rotation.
  assert.equal(shouldOfferManualEntry(0, null, now), false);
  assert.equal(shouldOfferManualEntry(1, null, now), false);
});

test("two consecutive failures open the manual path", () => {
  assert.ok(shouldOfferManualEntry(2, null, now));
  assert.ok(shouldOfferManualEntry(5, null, now));
});

test("a success between two failures resets the streak, so nothing is offered", () => {
  let streak = nextAutoFailureCount(undefined, true);
  streak = nextAutoFailureCount(streak, false);
  streak = nextAutoFailureCount(streak, true);
  assert.equal(streak, 1);
  assert.equal(shouldOfferManualEntry(streak, null, now), false);
});

test("a persistently broken credential does not reopen the window every sweep", () => {
  const justPrompted = new Date(now - 60_000).toISOString();
  assert.equal(shouldOfferManualEntry(9, justPrompted, now), false);
});

test("the offer comes back once the repeat window has elapsed", () => {
  const longAgo = new Date(now - MANUAL_PROMPT_REPEAT_MS - 1).toISOString();
  assert.ok(shouldOfferManualEntry(9, longAgo, now));
});

test("an unparseable prompt timestamp is treated as never prompted", () => {
  assert.ok(shouldOfferManualEntry(2, "not a date", now));
});
