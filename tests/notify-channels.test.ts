import test from "node:test";
import assert from "node:assert/strict";
import { isLineEnabled, isLineInUse, isPopupEnabled, resolveChannelFlags } from "../src/shared/notify-channels";

const flags = (patch: Record<string, boolean> = {}) => ({
  enableCursorAlarmPopup: true,
  enableClaudeAlarmPopup: true,
  enableCodexAlarmPopup: true,
  enableCursorLineNotification: true,
  enableClaudeLineNotification: true,
  enableCodexLineNotification: true,
  enableCursorMonitoring: true,
  enableClaudeMonitoring: true,
  enableCodexMonitoring: true,
  ...patch
});

test("isPopupEnabled / isLineEnabled read each service's own flag", () => {
  const settings = flags({ enableClaudeAlarmPopup: false, enableCodexLineNotification: false });
  assert.equal(isPopupEnabled(settings, "cursor"), true);
  assert.equal(isPopupEnabled(settings, "claude"), false);
  assert.equal(isPopupEnabled(settings, "codex"), true);
  assert.equal(isLineEnabled(settings, "cursor"), true);
  assert.equal(isLineEnabled(settings, "claude"), true);
  assert.equal(isLineEnabled(settings, "codex"), false);
});

test("isLineInUse is true when any monitored service sends LINE", () => {
  assert.equal(isLineInUse(flags()), true);
  assert.equal(
    isLineInUse(flags({ enableCursorLineNotification: false, enableClaudeLineNotification: false })),
    true
  );
});

test("isLineInUse is false when no monitored service sends LINE", () => {
  assert.equal(
    isLineInUse(
      flags({
        enableCursorLineNotification: false,
        enableClaudeLineNotification: false,
        enableCodexLineNotification: false
      })
    ),
    false
  );
});

test("isLineInUse ignores a LINE checkbox left on for a service that is not monitored", () => {
  assert.equal(
    isLineInUse(
      flags({
        enableCursorLineNotification: false,
        enableClaudeLineNotification: false,
        enableCodexLineNotification: true,
        enableCodexMonitoring: false
      })
    ),
    false
  );
});

test("resolveChannelFlags defaults every flag to on when nothing was stored", () => {
  assert.deepEqual(resolveChannelFlags({}), {
    enableCursorAlarmPopup: true,
    enableClaudeAlarmPopup: true,
    enableCodexAlarmPopup: true,
    enableCursorLineNotification: true,
    enableClaudeLineNotification: true,
    enableCodexLineNotification: true
  });
});

test("resolveChannelFlags carries the legacy global switches over to every service", () => {
  assert.deepEqual(resolveChannelFlags({ enableAlarmPopup: false, enableLineNotification: true }), {
    enableCursorAlarmPopup: false,
    enableClaudeAlarmPopup: false,
    enableCodexAlarmPopup: false,
    enableCursorLineNotification: true,
    enableClaudeLineNotification: true,
    enableCodexLineNotification: true
  });
  assert.deepEqual(resolveChannelFlags({ enableAlarmPopup: true, enableLineNotification: false }), {
    enableCursorAlarmPopup: true,
    enableClaudeAlarmPopup: true,
    enableCodexAlarmPopup: true,
    enableCursorLineNotification: false,
    enableClaudeLineNotification: false,
    enableCodexLineNotification: false
  });
});

test("resolveChannelFlags prefers a service's own saved flag over the legacy global", () => {
  const resolved = resolveChannelFlags({
    enableAlarmPopup: false,
    enableLineNotification: false,
    enableClaudeAlarmPopup: true,
    enableCodexLineNotification: true
  });
  assert.equal(resolved.enableClaudeAlarmPopup, true);
  assert.equal(resolved.enableCursorAlarmPopup, false);
  assert.equal(resolved.enableCodexLineNotification, true);
  assert.equal(resolved.enableClaudeLineNotification, false);
});

test("resolveChannelFlags ignores non-boolean stored values", () => {
  const resolved = resolveChannelFlags({ enableAlarmPopup: "no", enableClaudeLineNotification: 0 });
  assert.equal(resolved.enableCursorAlarmPopup, true);
  assert.equal(resolved.enableClaudeLineNotification, true);
});
