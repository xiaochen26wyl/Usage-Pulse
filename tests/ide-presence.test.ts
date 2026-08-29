import test from "node:test";
import assert from "node:assert/strict";
import {
  IDLE_POLLS_BEFORE_PROMPT,
  commandLineLooksLikeClaudeCode,
  commandLineLooksLikeCodex,
  initialIdeQuitPromptState,
  isClaudeCodeProcessName,
  isCodexProcessName,
  isCursorProcessName,
  migrateLaunchWithIde,
  processLooksLikeIde,
  reduceIdeQuitPrompt,
  type IdeQuitPromptState
} from "../src/main/ide-presence";

const poll = (state: IdeQuitPromptState, running: boolean) =>
  reduceIdeQuitPrompt(state, { type: "poll", running });

test("isCursorProcessName matches the platform binary and ignores helpers", () => {
  assert.equal(isCursorProcessName("Cursor", "darwin"), true);
  assert.equal(isCursorProcessName("Cursor Helper", "darwin"), false);
  assert.equal(isCursorProcessName("Cursor.exe", "win32"), true);
  assert.equal(isCursorProcessName("cursor.exe", "win32"), true);
  assert.equal(isCursorProcessName("Cursor.exe", "darwin"), false);
});

test("isClaudeCodeProcessName matches the CLI and excludes Claude Desktop", () => {
  assert.equal(isClaudeCodeProcessName("claude", "darwin"), true);
  assert.equal(isClaudeCodeProcessName("Claude", "darwin"), false);
  assert.equal(isClaudeCodeProcessName("claude.exe", "win32"), true);
  assert.equal(isClaudeCodeProcessName("claude", "win32"), true);
  assert.equal(isClaudeCodeProcessName("Claude.exe", "win32"), false);
});

test("commandLineLooksLikeClaudeCode finds the npm package, not Claude Desktop", () => {
  assert.equal(commandLineLooksLikeClaudeCode("node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"), true);
  assert.equal(commandLineLooksLikeClaudeCode("node ./claude-code/dist/cli.js"), true);
  assert.equal(commandLineLooksLikeClaudeCode("/Applications/Claude.app/Contents/MacOS/Claude"), false);
  assert.equal(commandLineLooksLikeClaudeCode("Usage-Pulse"), false);
});

test("processLooksLikeIde combines name and command-line rules", () => {
  assert.equal(processLooksLikeIde({ name: "Cursor", platform: "darwin" }), true);
  assert.equal(processLooksLikeIde({ name: "node", commandLine: "npx claude-code", platform: "darwin" }), true);
  assert.equal(processLooksLikeIde({ name: "Claude", platform: "darwin" }), false);
  assert.equal(processLooksLikeIde({ name: "node", commandLine: "vite", platform: "darwin" }), false);
});

test("isCodexProcessName matches the CLI binary", () => {
  assert.equal(isCodexProcessName("codex", "darwin"), true);
  assert.equal(isCodexProcessName("Codex", "darwin"), false);
  assert.equal(isCodexProcessName("codex.exe", "win32"), true);
  assert.equal(isCodexProcessName("codex", "win32"), true);
});

test("commandLineLooksLikeCodex finds the npm package", () => {
  assert.equal(commandLineLooksLikeCodex("node /usr/lib/node_modules/@openai/codex/bin.js"), true);
  assert.equal(commandLineLooksLikeCodex("npx openai-codex"), true);
  assert.equal(commandLineLooksLikeCodex("Usage-Pulse"), false);
});

test("migrateLaunchWithIde prefers the new field and falls back to launchAtLogin", () => {
  assert.equal(migrateLaunchWithIde({ launchWithIde: true, launchAtLogin: false }), true);
  assert.equal(migrateLaunchWithIde({ launchWithIde: false, launchAtLogin: true }), false);
  assert.equal(migrateLaunchWithIde({ launchAtLogin: true }), true);
  assert.equal(migrateLaunchWithIde({ launchAtLogin: false }), false);
  assert.equal(migrateLaunchWithIde({}), false);
});

test("quit prompt stays quiet until an IDE has been seen", () => {
  let step = poll(initialIdeQuitPromptState(), false);
  assert.equal(step.action, "none");
  step = poll(step.state, false);
  assert.equal(step.action, "none");
  assert.equal(step.state.seenIde, false);
});

test("quit prompt waits for consecutive idle polls after an IDE was running", () => {
  let step = poll(initialIdeQuitPromptState(), true);
  assert.equal(step.action, "none");
  assert.equal(step.state.seenIde, true);

  step = poll(step.state, false);
  assert.equal(step.action, "none");
  assert.equal(step.state.idleStreak, 1);

  for (let i = 1; i < IDLE_POLLS_BEFORE_PROMPT; i += 1) {
    step = poll(step.state, false);
  }
  assert.equal(step.action, "showPrompt");
  assert.equal(step.state.promptOpen, true);
});

test("a brief restart does not prompt", () => {
  let step = poll(initialIdeQuitPromptState(), true);
  step = poll(step.state, false);
  assert.equal(step.action, "none");
  step = poll(step.state, true);
  assert.equal(step.action, "none");
  assert.equal(step.state.idleStreak, 0);
});

test("an IDE returning while the prompt is open cancels it", () => {
  let step = poll(initialIdeQuitPromptState(), true);
  for (let i = 0; i < IDLE_POLLS_BEFORE_PROMPT; i += 1) {
    step = poll(step.state, false);
  }
  assert.equal(step.action, "showPrompt");

  step = poll(step.state, true);
  assert.equal(step.action, "cancelPrompt");
  assert.equal(step.state.promptOpen, false);
});

test("choosing stay requires another presence edge before prompting again", () => {
  let step = poll(initialIdeQuitPromptState(), true);
  for (let i = 0; i < IDLE_POLLS_BEFORE_PROMPT; i += 1) {
    step = poll(step.state, false);
  }
  step = reduceIdeQuitPrompt(step.state, { type: "choseStay" });
  assert.equal(step.state.holdUntilIdeReturns, true);
  assert.equal(step.state.promptOpen, false);

  step = poll(step.state, false);
  assert.equal(step.action, "none");
  step = poll(step.state, false);
  assert.equal(step.action, "none");

  step = poll(step.state, true);
  assert.equal(step.state.holdUntilIdeReturns, false);
  for (let i = 0; i < IDLE_POLLS_BEFORE_PROMPT; i += 1) {
    step = poll(step.state, false);
  }
  assert.equal(step.action, "showPrompt");
});
