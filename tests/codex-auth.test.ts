import test from "node:test";
import assert from "node:assert/strict";
import { jwtExpiryMs, jwtSubscriptionActiveUntil, parseCodexAuthJson, parseCodexCredentialsStore } from "../src/shared/codex-auth";

const jwtOf = (payload: Record<string, unknown>): string => {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
};

test("parseCodexAuthJson reads nested tokens and JWT expiry", () => {
  const access = jwtOf({ exp: 1_800_000_000, sub: "user" });
  const parsed = parseCodexAuthJson(
    JSON.stringify({
      tokens: {
        access_token: access,
        refresh_token: "refresh-token-value",
        id_token: jwtOf({
          "https://api.openai.com/auth.chatgpt_account_id": "acct-123"
        })
      },
      account_id: "acct-file"
    }),
    "codexAuthFile"
  );

  assert.ok(parsed);
  assert.equal(parsed?.accessToken, access);
  assert.equal(parsed?.refreshToken, "refresh-token-value");
  assert.equal(parsed?.accountId, "acct-file");
  assert.equal(parsed?.source, "codexAuthFile");
  assert.equal(parsed?.expiresAtMs, 1_800_000_000_000);
});

test("parseCodexAuthJson takes chatgpt account id from the id token when the file omits it", () => {
  const parsed = parseCodexAuthJson(
    JSON.stringify({
      tokens: {
        access_token: "plain-access",
        id_token: jwtOf({
          "https://api.openai.com/auth.chatgpt_account_id": "acct-jwt"
        })
      }
    }),
    "codexKeyring"
  );

  assert.equal(parsed?.accountId, "acct-jwt");
  assert.equal(parsed?.source, "codexKeyring");
  assert.equal(parsed?.expiresAtMs, null);
});

test("parseCodexAuthJson rejects empty or token-less blobs", () => {
  assert.equal(parseCodexAuthJson("", "codexAuthFile"), null);
  assert.equal(parseCodexAuthJson("{", "codexAuthFile"), null);
  assert.equal(parseCodexAuthJson(JSON.stringify({ tokens: {} }), "codexAuthFile"), null);
});

test("jwtExpiryMs reads exp from a compact JWT", () => {
  assert.equal(jwtExpiryMs(jwtOf({ exp: 1_700_000_000 })), 1_700_000_000_000);
  assert.equal(jwtExpiryMs("not-a-jwt"), null);
});

test("parseCodexCredentialsStore reads the CLI config key", () => {
  assert.equal(parseCodexCredentialsStore('cli_auth_credentials_store = "keyring"\n'), "keyring");
  assert.equal(parseCodexCredentialsStore("cli_auth_credentials_store = 'file'"), "file");
  assert.equal(parseCodexCredentialsStore("model = \"gpt\""), null);
});

test("jwtSubscriptionActiveUntil reads the ChatGPT period end and ignores an empty claim", () => {
  const withEnd = (value: unknown) => jwtOf({ "https://api.openai.com/auth": { chatgpt_subscription_active_until: value } });
  assert.equal(jwtSubscriptionActiveUntil(withEnd("2026-12-01T00:00:00+00:00")), "2026-12-01T00:00:00.000Z");
  assert.equal(jwtSubscriptionActiveUntil(withEnd(1_796_083_200)), "2026-12-01T00:00:00.000Z");
  assert.equal(jwtSubscriptionActiveUntil(withEnd(null)), null);
  assert.equal(jwtSubscriptionActiveUntil(withEnd("not-a-date")), null);
  assert.equal(jwtSubscriptionActiveUntil(jwtOf({ sub: "user" })), null);
  assert.equal(jwtSubscriptionActiveUntil(null), null);
});

test("parseCodexAuthJson carries the period end from the id token", () => {
  const parsed = parseCodexAuthJson(
    JSON.stringify({
      tokens: {
        access_token: jwtOf({ exp: 1_800_000_000 }),
        id_token: jwtOf({ "https://api.openai.com/auth": { chatgpt_subscription_active_until: "2026-12-01T00:00:00Z" } })
      }
    }),
    "codexAuthFile"
  );
  assert.equal(parsed?.subscriptionActiveUntil, "2026-12-01T00:00:00.000Z");
});
