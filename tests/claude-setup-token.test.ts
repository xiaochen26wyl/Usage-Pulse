import test from "node:test";
import assert from "node:assert/strict";
import {
  extractAuthUrlFromOutput,
  extractSetupTokenFromOutput
} from "../src/main/claude-setup-token";

const FULL_TOKEN =
  "sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

test("extractSetupTokenFromOutput reads a single-line token", () => {
  const text = [
    "✓ Long-lived authentication token created successfully!",
    "",
    "Your OAuth token (valid for 1 year):",
    "",
    FULL_TOKEN,
    "",
    "Store this token securely. You won't be able to see it again."
  ].join("\n");

  assert.equal(extractSetupTokenFromOutput(text), FULL_TOKEN);
});

test("extractSetupTokenFromOutput joins a token wrapped across two lines", () => {
  const head = FULL_TOKEN.slice(0, 79);
  const tail = FULL_TOKEN.slice(79);
  const text = `${head}\n${tail}\n\nStore this token securely.\n`;

  assert.equal(head.length, 79);
  assert.equal(extractSetupTokenFromOutput(text), FULL_TOKEN);
});

test("extractSetupTokenFromOutput ignores a truncated wrap stump", () => {
  assert.equal(extractSetupTokenFromOutput("sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n"), null);
});

test("extractSetupTokenFromOutput returns null when the prefix is missing", () => {
  assert.equal(extractSetupTokenFromOutput("no token in this output"), null);
});

test("extractAuthUrlFromOutput picks the official login URL", () => {
  const text = "Open this URL to continue:\nhttps://claude.ai/oauth/authorize?code=abc\n";
  assert.equal(extractAuthUrlFromOutput(text), "https://claude.ai/oauth/authorize?code=abc");
});

test("extractAuthUrlFromOutput ignores unrelated hosts", () => {
  assert.equal(extractAuthUrlFromOutput("see https://example.com/login"), null);
});
