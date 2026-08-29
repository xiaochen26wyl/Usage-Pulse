import test from "node:test";
import assert from "node:assert/strict";
import { isClaudeAuthCodePrompt, isClaudeOAuthToken } from "../src/shared/claude-auth";

test("detects the Claude CLI prompt for the browser authentication code", () => {
  assert.equal(isClaudeAuthCodePrompt("Paste code here if prompted >"), true);
  assert.equal(isClaudeAuthCodePrompt("Your long-lived token is ready"), false);
});

test("distinguishes the browser code from a Claude OAuth token", () => {
  assert.equal(isClaudeOAuthToken("code#state"), false);
  assert.equal(isClaudeOAuthToken(`sk-ant-oat01-${"a".repeat(20)}`), true);
});
