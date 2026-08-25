import test from "node:test";
import assert from "node:assert/strict";
import { redact, redactSecrets } from "../src/main/log-redaction";

const FAKE_TOKEN = `sk-ant-oat01-${"a".repeat(100)}`;

test("redactSecrets removes an Anthropic token wherever it appears", () => {
  const line = `Command failed: security add-generic-password -w {"claudeAiOauth":{"accessToken":"${FAKE_TOKEN}"}} -U`;
  const redacted = redactSecrets(line);
  assert.ok(!redacted.includes(FAKE_TOKEN), "the token must not survive redaction");
  assert.ok(!redacted.includes("aaaa"), "no fragment of the token body may survive");
  assert.ok(redacted.includes("[redacted]"));
});

test("redactSecrets removes a bearer credential from a header dump", () => {
  const redacted = redactSecrets(`{ Authorization: 'Bearer ${FAKE_TOKEN}' }`);
  assert.ok(!redacted.includes(FAKE_TOKEN));
  assert.match(redacted, /Bearer \[redacted\]/);
});

test("redactSecrets removes an accessToken field even with an unfamiliar prefix", () => {
  const opaque = "ZmFrZS1saW5lLXRva2Vu".repeat(4);
  const redacted = redactSecrets(`{"accessToken":"${opaque}"}`);
  assert.ok(!redacted.includes(opaque));
  assert.equal(redacted, '{"accessToken":"[redacted]"}');
});

test("redact collapses an Error to name and message, dropping carrier properties", () => {
  // This is the shape Node gives an execFile failure: the full command, secret
  // included, is hung off the error rather than being in the message alone.
  const error = new Error(`Command failed: security -w ${FAKE_TOKEN}`);
  (error as Error & { cmd?: string }).cmd = `security -w ${FAKE_TOKEN}`;

  const line = redact(error);
  assert.ok(!line.includes(FAKE_TOKEN));
  assert.ok(line.startsWith("Error: "));
  assert.ok(!line.includes("cmd"), "carrier properties must not be printed at all");
});

test("redact handles non-Error values without throwing", () => {
  assert.equal(redact(null), "null");
  assert.equal(redact(42), "42");
  assert.equal(redact(undefined), "undefined");
  assert.ok(!redact({ token: FAKE_TOKEN }).includes(FAKE_TOKEN.slice(20)));
});
