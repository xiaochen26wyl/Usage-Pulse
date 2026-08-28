import test from "node:test";
import assert from "node:assert/strict";
import {
  asClaudeManualToken,
  asClipboardText,
  asServiceType,
  asSettingsPatch,
  asWaterCupSize
} from "../src/main/ipc-validation";
import { isSupportLink, THREADS_URL } from "../src/shared/support-links";

test("asServiceType accepts only the two real services", () => {
  assert.equal(asServiceType("cursor"), "cursor");
  assert.equal(asServiceType("claude"), "claude");
});

test("asServiceType rejects values that would become a store write path", () => {
  // `service` is interpolated into `credentials.${service}`, which electron-store
  // reads as a dot path — so anything unexpected here used to be a write
  // primitive aimed at the rest of the config file.
  assert.equal(asServiceType("__proto__"), null);
  assert.equal(asServiceType("settings"), null);
  assert.equal(asServiceType("settings.lineChannelAccessToken"), null);
  assert.equal(asServiceType("Cursor"), null);
  assert.equal(asServiceType(""), null);
  assert.equal(asServiceType(undefined), null);
  assert.equal(asServiceType({ toString: () => "cursor" }), null);
});

test("asSettingsPatch keeps known keys with the declared type", () => {
  const patch = asSettingsPatch({ language: "en", enableWaterReminder: false, notifyCooldownMinutes: 30 });
  assert.deepEqual(patch, { language: "en", enableWaterReminder: false, notifyCooldownMinutes: 30 });
});

test("asSettingsPatch drops unknown keys and mistyped values", () => {
  const patch = asSettingsPatch({
    language: "en",
    somethingInvented: "yes",
    __proto__: { polluted: true },
    enableWaterReminder: "true",
    notifyCooldownMinutes: Number.NaN
  });
  assert.deepEqual(patch, { language: "en" });
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("asSettingsPatch refuses non-objects", () => {
  assert.deepEqual(asSettingsPatch(null), {});
  assert.deepEqual(asSettingsPatch("language=en"), {});
  assert.deepEqual(asSettingsPatch([["language", "en"]]), {});
});

test("asClipboardText allows the CLI commands the UI copies, but no control characters", () => {
  assert.equal(asClipboardText("claude"), "claude");
  assert.equal(asClipboardText("claude setup-token"), "claude setup-token");
  assert.equal(asClipboardText("claude\nrm -rf ~"), null);
  assert.equal(asClipboardText("x".repeat(257)), null);
  assert.equal(asClipboardText(42), null);
});

test("asClaudeManualToken accepts a well-formed pasted token, trimmed", () => {
  const token = `sk-ant-oat01-${"a".repeat(95)}`;
  assert.equal(asClaudeManualToken(`  ${token}  \n`), token);
});

test("asClaudeManualToken rejects the wrong prefix, short values, and control characters", () => {
  assert.equal(asClaudeManualToken(`sk-ant-api01-${"a".repeat(95)}`), null);
  assert.equal(asClaudeManualToken("sk-ant-oat01-tooshort"), null);
  assert.equal(asClaudeManualToken(`sk-ant-oat01-${"a".repeat(40)}\nrm -rf ~`), null);
  assert.equal(asClaudeManualToken(""), null);
  assert.equal(asClaudeManualToken(undefined), null);
  assert.equal(asClaudeManualToken(42), null);
});

test("asWaterCupSize normalises to a supported cup and ignores junk", () => {
  assert.equal(asWaterCupSize(250), 250);
  assert.equal(asWaterCupSize("500"), 500);
  assert.equal(asWaterCupSize(undefined), null);
  assert.equal(asWaterCupSize("not-a-number"), null);
});

test("isSupportLink admits only the footer links", () => {
  assert.equal(isSupportLink(THREADS_URL), true);
  assert.equal(isSupportLink("https://example.com/"), false);
  assert.equal(isSupportLink(`${THREADS_URL}?x=1`), false);
  assert.equal(isSupportLink("file:///etc/passwd"), false);
  assert.equal(isSupportLink(undefined), false);
});
