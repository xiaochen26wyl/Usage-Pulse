import test from "node:test";
import assert from "node:assert/strict";
import { decideSetupTokenAction } from "../src/main/claude-setup-token-decision";

test("empty Keychain opens login", () => {
  assert.equal(
    decideSetupTokenAction({ hasKeychainCredential: false, lastScrapeNeedsReauth: false }),
    "openLogin"
  );
});

test("Keychain present without a reauth signal refreshes quota instead of opening login", () => {
  assert.equal(
    decideSetupTokenAction({ hasKeychainCredential: true, lastScrapeNeedsReauth: false }),
    "refreshQuota"
  );
});

test("a 401 opens login even when Keychain still holds the rejected token", () => {
  assert.equal(
    decideSetupTokenAction({ hasKeychainCredential: true, lastScrapeNeedsReauth: true }),
    "openLogin"
  );
});

test("a 401 with empty Keychain still opens login", () => {
  assert.equal(
    decideSetupTokenAction({ hasKeychainCredential: false, lastScrapeNeedsReauth: true }),
    "openLogin"
  );
});
