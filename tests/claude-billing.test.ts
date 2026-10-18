import test from "node:test";
import assert from "node:assert/strict";
import { parseSubscriptionCreatedAt } from "../src/shared/claude-billing";

test("parseSubscriptionCreatedAt reads organization.subscription_created_at", () => {
  assert.equal(
    parseSubscriptionCreatedAt({
      organization: { subscription_created_at: "2025-10-22T09:44:02.049Z" }
    }),
    "2025-10-22T09:44:02.049Z"
  );
});

test("parseSubscriptionCreatedAt accepts camelCase and a memberships walk", () => {
  assert.equal(
    parseSubscriptionCreatedAt({
      organization: { subscriptionCreatedAt: "2026-01-31T15:00:00.000Z" }
    }),
    "2026-01-31T15:00:00.000Z"
  );
  assert.equal(
    parseSubscriptionCreatedAt({
      memberships: [{ organization: { subscription_created_at: "2026-03-01T00:00:00.000Z" } }]
    }),
    "2026-03-01T00:00:00.000Z"
  );
});

test("parseSubscriptionCreatedAt returns null when nothing parseable is present", () => {
  assert.equal(parseSubscriptionCreatedAt({}), null);
  assert.equal(parseSubscriptionCreatedAt({ organization: { subscription_created_at: "not-a-date" } }), null);
});
