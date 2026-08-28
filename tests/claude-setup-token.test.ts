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

// The real `claude setup-token` (v2.1.245) prints a claude.com URL, not
// claude.ai — caught by driving the actual CLI inside a node-pty session.
test("extractAuthUrlFromOutput accepts the current claude.com OAuth host", () => {
  const url =
    "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback";
  assert.equal(extractAuthUrlFromOutput(`Browser didn't open? Use the url below to sign in:\n${url}\n`), url);
});

// Also caught live: node-pty hands back the raw byte stream, so a terminal
// hyperlink's OSC-8 wrapper (`\x1B]8;;<url>\x07`) sits directly against the
// URL with no whitespace — without excluding control bytes, the match used
// to swallow the escape sequence (and the link's repeated display text)
// straight into the "URL" handed to shell.openExternal.
test("extractAuthUrlFromOutput stops at an OSC-8 hyperlink terminator, not just whitespace", () => {
  const url = "https://claude.com/cai/oauth/authorize?code=true&state=abc";
  const text = `\x1B]8;;${url}\x07${url}\x1B]8;;\x07\n`;
  assert.equal(extractAuthUrlFromOutput(text), url);
});
