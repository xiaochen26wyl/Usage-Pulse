import test from "node:test";
import assert from "node:assert/strict";
import { jwtExpiryMs, parseCodexAuthJson, parseCodexCredentialsStore } from "../src/shared/codex-auth";

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
