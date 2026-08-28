import test from "node:test";
import assert from "node:assert/strict";
import {
  BUBBLE_BG,
  EXHAUSTED_RED,
  SERVICE_ACCENT,
  buildExhaustedFlex,
  buildLowQuotaFlex,
  buildPlainAlertFlex,
  buildQuitStatusFlex,
  type LineFlexMessage,
} from "../src/shared/line-templates";

// The accent bar is the first child of the body box; the title text right
// after it carries the same colour.
const accentOf = (message: LineFlexMessage): string => {
  const body = (
    message.contents.body as { contents: Array<Record<string, unknown>> }
  ).contents;
  return body[0].backgroundColor as string;
};

const backgroundOf = (message: LineFlexMessage): string =>
  (message.contents.body as { backgroundColor: string }).backgroundColor;

// Each label/value row is a baseline box whose two text children are the
// label then the value — walk the whole tree and collect them in order.
const rowsOf = (message: LineFlexMessage): Array<{ label: string; value: string }> => {
  const rows: Array<{ label: string; value: string }> = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") {
      return;
    }
    const record = node as Record<string, unknown>;
    if (record.layout === "baseline" && Array.isArray(record.contents)) {
      const [label, value] = record.contents as Array<Record<string, unknown>>;
      rows.push({ label: String(label?.text ?? ""), value: String(value?.text ?? "") });
      return;
    }
    Object.values(record).forEach(walk);
  };
  walk(message.contents);
  return rows;
};

const fixedNow = new Date("2026-08-20T14:05:00Z");

test("low-quota bubbles are accented with the service's own colour", () => {
  const cursor = buildLowQuotaFlex({
    service: "cursor",
    serviceLabel: "Cursor",
    windowLabel: "其他模型",
    remainingPercent: 12,
    thresholdPercent: 20,
    resetAt: "2026-09-01T00:00:00Z",
    lang: "zh",
    now: fixedNow,
  });
  const claude = buildLowQuotaFlex({
    service: "claude",
    serviceLabel: "Claude Code",
    windowLabel: "Weekly 消耗度",
    remainingPercent: 8,
    thresholdPercent: 20,
    resetAt: null,
    lang: "zh",
    now: fixedNow,
  });

  assert.equal(accentOf(cursor), SERVICE_ACCENT.cursor);
  assert.equal(accentOf(claude), SERVICE_ACCENT.claude);
  assert.notEqual(SERVICE_ACCENT.cursor, SERVICE_ACCENT.claude);
});

test("exhausted bubbles are red for either service", () => {
  for (const service of ["cursor", "claude"] as const) {
    const message = buildExhaustedFlex({
      service,
      serviceLabel: service === "cursor" ? "Cursor" : "Claude Code",
      windowLabel: "Weekly",
      resetAt: "2026-09-01T00:00:00Z",
      lang: "en",
      now: fixedNow,
    });
    assert.equal(accentOf(message), EXHAUSTED_RED);
  }
});

test("every template keeps a white bubble background", () => {
  const messages = [
    buildLowQuotaFlex({
      service: "cursor",
      serviceLabel: "Cursor",
      windowLabel: "Cursor 模型",
      remainingPercent: 5,
      thresholdPercent: 20,
      lang: "zh",
      now: fixedNow,
    }),
    buildExhaustedFlex({
      service: "claude",
      serviceLabel: "Claude Code",
      windowLabel: "Weekly",
      lang: "zh",
      now: fixedNow,
    }),
    buildPlainAlertFlex({
      service: "claude",
      serviceLabel: "Claude Code",
      title: "Usage-Pulse 配額通知",
      body: "Claude Code 憑證已過期",
      lang: "zh",
      now: fixedNow,
    }),
  ];

  for (const message of messages) {
    assert.equal(backgroundOf(message), BUBBLE_BG);
    assert.equal(BUBBLE_BG, "#FFFFFF");
  }
});

test("altText carries the whole message for the push banner", () => {
  const low = buildLowQuotaFlex({
    service: "cursor",
    serviceLabel: "Cursor",
    windowLabel: "其他模型",
    remainingPercent: 12,
    thresholdPercent: 20,
    lang: "zh",
    now: fixedNow,
  });
  const exhausted = buildExhaustedFlex({
    service: "claude",
    serviceLabel: "Claude Code",
    windowLabel: "Weekly 消耗度",
    lang: "zh",
    now: fixedNow,
  });

  assert.match(low.altText, /Cursor/);
  assert.match(low.altText, /12/);
  assert.match(exhausted.altText, /Claude Code/);
  assert.match(exhausted.altText, /Weekly 消耗度/);
});

test("quit-status bubbles use the service's own colour, never EXHAUSTED_RED, even at 0%", () => {
  for (const service of ["cursor", "claude"] as const) {
    const message = buildQuitStatusFlex({
      service,
      serviceLabel: service === "cursor" ? "Cursor" : "Claude Code",
      windowLabel: "5 小時視窗",
      valueText: "0%",
      resetAt: "2026-09-01T00:00:00Z",
      lang: "zh",
      now: fixedNow,
    });
    assert.equal(accentOf(message), SERVICE_ACCENT[service]);
    assert.notEqual(accentOf(message), EXHAUSTED_RED);
  }
});

test("quit-status valueText passes through verbatim, never reformatted", () => {
  const message = buildQuitStatusFlex({
    service: "claude",
    serviceLabel: "Claude Code",
    windowLabel: "5 小時視窗",
    valueText: "3.2h",
    resetAt: null,
    lang: "zh",
    now: fixedNow,
  });
  const rows = rowsOf(message);
  assert.equal(rows[0]?.value, "3.2h");
});

test("quit-status omits the reset row when resetAt is null", () => {
  const withReset = buildQuitStatusFlex({
    service: "cursor",
    serviceLabel: "Cursor",
    windowLabel: "整體配額",
    valueText: "42%",
    resetAt: "2026-09-01T00:00:00Z",
    lang: "zh",
    now: fixedNow,
  });
  const withoutReset = buildQuitStatusFlex({
    service: "cursor",
    serviceLabel: "Cursor",
    windowLabel: "整體配額",
    valueText: "42%",
    resetAt: null,
    lang: "zh",
    now: fixedNow,
  });
  assert.equal(rowsOf(withReset).length, 2);
  assert.equal(rowsOf(withoutReset).length, 1);
});

test("no text node in a bubble is ever empty (LINE rejects those)", () => {
  const message = buildPlainAlertFlex({
    service: "cursor",
    serviceLabel: "Cursor",
    title: "配額已重置",
    body: "Cursor 本期 included usage 已到重置時間",
    lang: "zh",
    now: fixedNow,
  });

  const texts: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") {
      return;
    }
    const record = node as Record<string, unknown>;
    if (record.type === "text") {
      texts.push(String(record.text ?? ""));
    }
    Object.values(record).forEach(walk);
  };
  walk(message.contents);

  assert.ok(texts.length > 0);
  for (const text of texts) {
    assert.notEqual(text.trim(), "");
  }
});
