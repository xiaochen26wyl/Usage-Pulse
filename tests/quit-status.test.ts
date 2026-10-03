import test from "node:test";
import assert from "node:assert/strict";
import type { AppSettings, CombinedSnapshot, QuotaSnapshot, QuotaWindow, ServiceType } from "../src/shared/types";
import { buildQuitStatusMessages } from "../src/shared/quit-status";
import { EXHAUSTED_RED, SERVICE_ACCENT, type LineFlexMessage } from "../src/shared/line-templates";

const NOW = new Date("2026-08-24T12:00:00.000Z");

type FlexCard = { body: { contents: Array<Record<string, unknown>> } };

// The quit status is one message: a carousel of cards, or a lone card when only
// one window qualifies. Either way these flatten it back to the cards.
const cardsOf = (messages: LineFlexMessage[]): FlexCard[] => {
  assert.ok(messages.length <= 1, "quit status must be a single LINE message");
  const contents = messages[0]?.contents as { type: string; contents?: FlexCard[] } | undefined;
  if (!contents) {
    return [];
  }
  return contents.type === "carousel" ? (contents.contents ?? []) : [contents as unknown as FlexCard];
};

const accentOfCard = (card: FlexCard): string => card.body.contents[0].backgroundColor as string;

const accentsOf = (messages: LineFlexMessage[]): string[] => cardsOf(messages).map(accentOfCard);

const quotaSnapshot = (
  service: ServiceType,
  windows: Array<Partial<QuotaWindow>>,
  overrides: Partial<QuotaSnapshot> = {}
): QuotaSnapshot => ({
  service,
  remaining: null,
  total: null,
  percent: null,
  unit: service === "cursor" ? "usd" : "percent",
  resetsAt: null,
  windows: windows.map((window) => ({
    key: window.key ?? "",
    label: window.label ?? "",
    remaining: window.remaining ?? null,
    total: window.total ?? null,
    percent: window.percent ?? null,
    resetsAt: window.resetsAt ?? null
  })),
  status: "ok",
  message: "",
  fetchedAt: NOW.toISOString(),
  ...overrides
});

const workingCursorSnapshot = (): QuotaSnapshot =>
  quotaSnapshot("cursor", [{ key: "cursor_models", percent: 58 }], { remaining: 12.34, total: 20 });

const workingClaudeSnapshot = (): QuotaSnapshot =>
  quotaSnapshot(
    "claude",
    [
      { key: "session", label: "5 小時視窗", remaining: 63, percent: 63 },
      { key: "weekly_all", label: "每週總配額", remaining: 47, percent: 47 }
    ],
    { remaining: 63, percent: 63 }
  );

const combinedOf = (
  cursor: QuotaSnapshot,
  claude: QuotaSnapshot,
  codex: QuotaSnapshot = quotaSnapshot("codex", [])
): CombinedSnapshot => ({
  cursor,
  claude,
  codex,
  fetchedAt: NOW.toISOString()
});

const settingsOf = (
  patch: Partial<
    Pick<
      AppSettings,
      | "enableCursorMonitoring"
      | "enableClaudeMonitoring"
      | "enableCodexMonitoring"
      | "enableCursorLineNotification"
      | "enableClaudeLineNotification"
      | "enableCodexLineNotification"
      | "language"
    >
  > = {}
) => ({
  enableCursorMonitoring: true,
  enableClaudeMonitoring: true,
  enableCodexMonitoring: false,
  enableCursorLineNotification: true,
  enableClaudeLineNotification: true,
  enableCodexLineNotification: true,
  language: "zh" as const,
  ...patch
});

const serviceLabels = { cursor: "Cursor", claude: "Claude Code", codex: "Codex" };

test("returns [] when there is no cached snapshot yet", () => {
  const messages = buildQuitStatusMessages({ settings: settingsOf(), snapshot: null, serviceLabels, now: NOW });
  assert.deepEqual(messages, []);
});

test("returns [] when both services' monitoring is disabled", () => {
  const messages = buildQuitStatusMessages({
    settings: settingsOf({ enableCursorMonitoring: false, enableClaudeMonitoring: false }),
    snapshot: combinedOf(workingCursorSnapshot(), workingClaudeSnapshot()),
    serviceLabels,
    now: NOW
  });
  assert.deepEqual(messages, []);
});

test("skips a service whose LINE checkbox is off but keeps the others", () => {
  const messages = buildQuitStatusMessages({
    settings: settingsOf({ enableClaudeLineNotification: false }),
    snapshot: combinedOf(workingCursorSnapshot(), workingClaudeSnapshot()),
    serviceLabels,
    now: NOW
  });
  // Only Cursor's window is left, so it is sent as a plain card, not a carousel.
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.contents.type, "bubble");
  assert.deepEqual(accentsOf(messages), [SERVICE_ACCENT.cursor]);
});

test("returns [] when every monitored service has LINE unchecked", () => {
  const messages = buildQuitStatusMessages({
    settings: settingsOf({ enableCursorLineNotification: false, enableClaudeLineNotification: false }),
    snapshot: combinedOf(workingCursorSnapshot(), workingClaudeSnapshot()),
    serviceLabels,
    now: NOW
  });
  assert.deepEqual(messages, []);
});

test("skips a service whose monitoring is off even with a populated snapshot", () => {
  const messages = buildQuitStatusMessages({
    settings: settingsOf({ enableCursorMonitoring: false }),
    snapshot: combinedOf(workingCursorSnapshot(), workingClaudeSnapshot()),
    serviceLabels,
    now: NOW
  });
  const accents = accentsOf(messages);
  assert.equal(accents.length, 2);
  assert.ok(!accents.includes(SERVICE_ACCENT.cursor));
});

test("skips Cursor's card when it has never been successfully polled", () => {
  const neverPolled = quotaSnapshot("cursor", []);
  const messages = buildQuitStatusMessages({
    settings: settingsOf(),
    snapshot: combinedOf(neverPolled, workingClaudeSnapshot()),
    serviceLabels,
    now: NOW
  });
  // Only the two Claude cards (session + weekly) should be present.
  assert.deepEqual(accentsOf(messages), [SERVICE_ACCENT.claude, SERVICE_ACCENT.claude]);
});

test("skips the weekly card when only the session window exists, without leaking the session's number", () => {
  const sessionOnly = quotaSnapshot("claude", [{ key: "session", label: "5 小時視窗", remaining: 63, percent: 63 }], {
    remaining: 63,
    percent: 63
  });
  const messages = buildQuitStatusMessages({
    settings: settingsOf(),
    snapshot: combinedOf(workingCursorSnapshot(), sessionOnly),
    serviceLabels,
    now: NOW
  });
  // Cursor + Claude session only — weekly must not appear, and must not
  // silently reuse the session's percentage via the shared fallback text.
  assert.deepEqual(accentsOf(messages), [SERVICE_ACCENT.cursor, SERVICE_ACCENT.claude]);
});

test("happy path: one message carrying all 3 cards, weekly label comes from the window's own label", () => {
  const messages = buildQuitStatusMessages({
    settings: settingsOf(),
    snapshot: combinedOf(workingCursorSnapshot(), workingClaudeSnapshot()),
    serviceLabels,
    now: NOW
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.contents.type, "carousel");
  assert.deepEqual(accentsOf(messages), [SERVICE_ACCENT.cursor, SERVICE_ACCENT.claude, SERVICE_ACCENT.claude]);
  assert.match(messages[0]?.altText ?? "", /5 小時視窗/);
  assert.match(messages[0]?.altText ?? "", /每週總配額/);
});

test("exhausted-but-not-red: a session at 0% still uses the service's own accent", () => {
  const exhaustedSession = quotaSnapshot(
    "claude",
    [{ key: "session", label: "5 小時視窗", remaining: 0, percent: 0, resetsAt: "2026-08-24T17:00:00.000Z" }],
    { remaining: 0, percent: 0 }
  );
  const messages = buildQuitStatusMessages({
    settings: settingsOf({ enableCursorMonitoring: false }),
    snapshot: combinedOf(workingCursorSnapshot(), exhaustedSession),
    serviceLabels,
    now: NOW
  });
  assert.deepEqual(accentsOf(messages), [SERVICE_ACCENT.claude]);
  assert.notEqual(accentsOf(messages)[0], EXHAUSTED_RED);
});

const workingCodexSnapshot = (): QuotaSnapshot =>
  quotaSnapshot(
    "codex",
    [
      { key: "session", label: "5 小時視窗", remaining: 55, percent: 55 },
      { key: "weekly", label: "每週配額", remaining: 40, percent: 40 }
    ],
    { remaining: 55, percent: 55 }
  );

test("happy path includes Codex 5-hour and weekly when monitoring is on", () => {
  const messages = buildQuitStatusMessages({
    settings: settingsOf({ enableCursorMonitoring: false, enableClaudeMonitoring: false, enableCodexMonitoring: true }),
    snapshot: combinedOf(workingCursorSnapshot(), workingClaudeSnapshot(), workingCodexSnapshot()),
    serviceLabels,
    now: NOW
  });
  assert.deepEqual(accentsOf(messages), [SERVICE_ACCENT.codex, SERVICE_ACCENT.codex]);
  assert.match(messages[0]?.altText ?? "", /5 小時視窗/);
  assert.match(messages[0]?.altText ?? "", /每週配額/);
});

test("every monitored window travels in a single message, in service order", () => {
  const messages = buildQuitStatusMessages({
    settings: settingsOf({ enableCodexMonitoring: true }),
    snapshot: combinedOf(workingCursorSnapshot(), workingClaudeSnapshot(), workingCodexSnapshot()),
    serviceLabels,
    now: NOW
  });
  assert.equal(messages.length, 1);
  assert.deepEqual(accentsOf(messages), [
    SERVICE_ACCENT.cursor,
    SERVICE_ACCENT.claude,
    SERVICE_ACCENT.claude,
    SERVICE_ACCENT.codex,
    SERVICE_ACCENT.codex
  ]);
});

test("the push-banner text lists every window and stays within LINE's altText limit", () => {
  const messages = buildQuitStatusMessages({
    settings: settingsOf({ enableCodexMonitoring: true }),
    snapshot: combinedOf(workingCursorSnapshot(), workingClaudeSnapshot(), workingCodexSnapshot()),
    serviceLabels,
    now: NOW
  });
  const altText = messages[0]?.altText ?? "";
  assert.ok(altText.length <= 400);
  assert.match(altText, /Cursor/);
  assert.match(altText, /Claude Code/);
  assert.match(altText, /Codex/);
});
