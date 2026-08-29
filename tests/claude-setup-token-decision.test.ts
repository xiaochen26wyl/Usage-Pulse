import test from "node:test";
import assert from "node:assert/strict";
import { decideSetupTokenAction } from "../src/main/claude-setup-token-decision";

test("empty Keychain opens login", () => {
  assert.equal(
    decideSetupTokenAction({ hasKeychainCredential: false, lastScrapeWasExpired: false }),
    "openLogin"
  );
});

test("Keychain present without a 401 refreshes quota instead of opening login", () => {
  assert.equal(
    decideSetupTokenAction({ hasKeychainCredential: true, lastScrapeWasExpired: false }),
    "refreshQuota"
  );
});

test("a 401 opens login even when Keychain still holds the rejected token", () => {
  assert.equal(
    decideSetupTokenAction({ hasKeychainCredential: true, lastScrapeWasExpired: true }),
    "openLogin"
  );
});

test("a 401 with empty Keychain still opens login", () => {
  assert.equal(
    decideSetupTokenAction({ hasKeychainCredential: false, lastScrapeWasExpired: true }),
    "openLogin"
  );
});
