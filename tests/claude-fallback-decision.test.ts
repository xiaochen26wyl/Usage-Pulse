import test from "node:test";
import assert from "node:assert/strict";
import { decideClaudeFallbackClear } from "../src/main/claude-fallback-decision";

const STORED = "sk-ant-oat01-stored";
const OTHER = "sk-ant-oat01-different";

test("a 401 against the stored fallback clears it when a different credential sits beneath", () => {
  assert.equal(decideClaudeFallbackClear("manual", STORED, OTHER), "clear");
});

test("a 401 against any source that outranks the fallback leaves it alone", () => {
  // The env credential is what the API rejected; the stored token was never
  // even read, so deleting it would destroy a working fallback for no reason.
  assert.equal(decideClaudeFallbackClear("env", STORED, OTHER), "keepNotOurToken");
});

test("a 401 from a source below the fallback leaves it alone", () => {
  for (const source of ["keychain", "file"] as const) {
    assert.equal(decideClaudeFallbackClear(source, STORED, OTHER), "keepNotOurToken");
  }
});

test("an unattributed 401 leaves the fallback alone", () => {
  // No source means the failure was never confirmed as a 401 against a known
  // credential — not grounds for deleting anything.
  assert.equal(decideClaudeFallbackClear(undefined, STORED, OTHER), "keepNotOurToken");
});

test("the fallback is kept when the Keychain holds the same token", () => {
  // Dropping it would change which source answers but not the answer, so the
  // next fetch 401s identically — and the user loses their pasted fallback.
  assert.equal(decideClaudeFallbackClear("manual", STORED, STORED), "keepNoFallbackBeneath");
});

test("the fallback is kept when nothing sits beneath it", () => {
  // Windows and Linux have no Keychain, so clearing here would turn a dead
  // credential into no credential at all.
  assert.equal(decideClaudeFallbackClear("manual", STORED, null), "keepNoFallbackBeneath");
});

test("nothing to clear when no fallback is stored", () => {
  assert.equal(decideClaudeFallbackClear("manual", "", OTHER), "keepNotOurToken");
});
