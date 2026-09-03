import test from "node:test";
import assert from "node:assert/strict";
import { classifyClaudeTokenProbe, preflightClaudeToken } from "../src/main/claude-manual-token";
import { t } from "../src/shared/i18n";
import type { ScrapeResult } from "../src/shared/types";

const VALID_SHAPE = "sk-ant-oat01-abc123";

const scrapeResult = (windowCount: number): ScrapeResult => ({
  remaining: null,
  total: null,
  unit: "percent",
  resetsAt: null,
  windows: Array.from({ length: windowCount }, (_unused, index) => ({
    key: `w${index}`,
    label: `w${index}`,
    remaining: null,
    total: null,
    percent: 10,
    resetsAt: null
  })),
  message: ""
});

const named = (name: string): Error => {
  const error = new Error("boom");
  error.name = name;
  return error;
};

test("preflight refuses an empty token without spending an API request", () => {
  for (const value of ["", "   ", undefined, null, 42]) {
    const result = preflightClaudeToken(value, "zh");
    assert.ok(result, `${String(value)} should have been refused`);
    assert.equal(result?.ok, false);
    assert.equal(result?.code, "empty");
  }
});

test("preflight refuses a token that is not a Claude OAuth token", () => {
  const result = preflightClaudeToken("sk-ant-api03-nope", "en");
  assert.equal(result?.ok, false);
  assert.equal(result?.code, "formatInvalid");
});

test("preflight lets a plausible token through to real verification", () => {
  assert.equal(preflightClaudeToken(VALID_SHAPE, "zh"), null);
  // Surrounding whitespace is a paste artefact, not a malformed token.
  assert.equal(preflightClaudeToken(`  ${VALID_SHAPE}  `, "zh"), null);
});

test("a token that returned quota windows is stored", () => {
  const result = classifyClaudeTokenProbe({ ok: true, result: scrapeResult(2) }, "zh");
  assert.equal(result.ok, true);
  assert.equal(result.code, undefined);
  assert.equal(result.message, t("zh", "claudeToken.saved"));
});

test("a 200 with no windows still counts as a working token", () => {
  // The token answered the usage API, which is the only thing being tested.
  // Refusing it here would send the user back to a login they do not need.
  const result = classifyClaudeTokenProbe({ ok: true, result: scrapeResult(0) }, "zh");
  assert.equal(result.ok, true);
  assert.equal(result.message, t("zh", "claudeToken.savedNoUsage"));
});

test("each failure is refused with the reason that actually occurred", () => {
  const cases: Array<[string, string]> = [
    ["ClaudeUsageScopeError", "scopeInsufficient"],
    ["ClaudeLoginExpiredError", "loginExpired"],
    ["ClaudeRateLimitedError", "rateLimited"],
    ["TypeError", "apiFailed"]
  ];
  for (const [errorName, expectedCode] of cases) {
    const result = classifyClaudeTokenProbe({ ok: false, error: named(errorName) }, "en");
    assert.equal(result.ok, false, `${errorName} must not be stored`);
    assert.equal(result.code, expectedCode);
    assert.ok(result.message.length > 0);
    assert.notEqual(result.message, `claudeToken.${expectedCode}`, "message must be localized");
  }
});

test("a non-Error rejection is still refused rather than stored", () => {
  const result = classifyClaudeTokenProbe({ ok: false, error: "network down" }, "ja");
  assert.equal(result.ok, false);
  assert.equal(result.code, "apiFailed");
});

test("every claudeToken key resolves in all four languages", () => {
  const keys = [
    "claudeToken.title",
    "claudeToken.hint",
    "claudeToken.placeholder",
    "claudeToken.save",
    "claudeToken.saving",
    "claudeToken.saved",
    "claudeToken.savedNoUsage",
    "claudeToken.stored",
    "claudeToken.clear",
    "claudeToken.cleared",
    "claudeToken.empty",
    "claudeToken.formatInvalid",
    "claudeToken.scopeInsufficient",
    "claudeToken.loginExpired",
    "claudeToken.rateLimited",
    "claudeToken.apiFailed"
  ] as const;
  for (const key of keys) {
    for (const lang of ["zh", "en", "ja", "ko"] as const) {
      const value = t(lang, key);
      assert.ok(value.length > 0, `${key} is empty in ${lang}`);
      assert.notEqual(value, key, `${key} did not resolve in ${lang}`);
    }
  }
});

test("the expired-credential message no longer points at a button that is not there", () => {
  // The old copy told users to click "Get Credentials" on a card that never
  // rendered one. It must name something the user can actually do.
  assert.match(t("zh", "error.claudeLoginExpired"), /claude auth login/);
  assert.match(t("en", "error.claudeLoginExpired"), /claude auth login/);
  assert.match(t("ja", "error.claudeLoginExpired"), /claude auth login/);
  assert.match(t("ko", "error.claudeLoginExpired"), /claude auth login/);
});
