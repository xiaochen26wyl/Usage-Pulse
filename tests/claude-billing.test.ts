import test from "node:test";
import assert from "node:assert/strict";
import { nextBillingAt, parseSubscriptionCreatedAt } from "../src/shared/claude-billing";

const NOW = Date.parse("2026-08-20T12:00:00.000Z");

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

test("nextBillingAt returns the current monthly anniversary when it is still due", () => {
  assert.equal(nextBillingAt("2026-08-20T12:00:00.000Z", "monthly", NOW), "2026-08-20T12:00:00.000Z");
});

test("nextBillingAt advances a past monthly anniversary to the next month", () => {
  assert.equal(
    nextBillingAt("2026-07-20T12:00:00.000Z", "monthly", NOW),
    "2026-08-20T12:00:00.000Z"
  );
  assert.equal(
    nextBillingAt("2026-08-20T11:59:59.000Z", "monthly", NOW),
    "2026-09-20T11:59:59.000Z"
  );
});

test("nextBillingAt clamps a 31st into shorter months", () => {
  assert.equal(
    nextBillingAt("2026-01-31T15:00:00.000Z", "monthly", Date.parse("2026-02-15T00:00:00.000Z")),
    "2026-02-28T15:00:00.000Z"
  );
  assert.equal(
    nextBillingAt("2026-01-31T15:00:00.000Z", "monthly", Date.parse("2026-03-01T00:00:00.000Z")),
    "2026-03-31T15:00:00.000Z"
  );
});

test("nextBillingAt advances an annual anniversary by a year", () => {
  assert.equal(
    nextBillingAt("2025-08-20T12:00:00.000Z", "annual", NOW),
    "2026-08-20T12:00:00.000Z"
  );
  assert.equal(
    nextBillingAt("2024-08-20T12:00:00.000Z", "annual", NOW),
    "2026-08-20T12:00:00.000Z"
  );
});

test("nextBillingAt clamps Feb 29 on a non-leap year", () => {
  assert.equal(
    nextBillingAt("2024-02-29T10:00:00.000Z", "annual", Date.parse("2025-01-01T00:00:00.000Z")),
    "2025-02-28T10:00:00.000Z"
  );
});

test("nextBillingAt rejects an unparseable anchor", () => {
  assert.equal(nextBillingAt("not-a-date", "monthly", NOW), null);
});
