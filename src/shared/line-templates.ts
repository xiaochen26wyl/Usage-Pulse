import type { Language, ServiceType } from "./types";
import { localeForLanguage, t } from "./i18n";

// LINE bubbles can't read the app's CSS, so the accents live here a second
// time. They mirror styles.css on purpose — change one and change the other:
//   cursor  -> logo black / .progress-fill-cursor (grayscale)
//   claude  -> terracotta / .progress-fill
// The bar colour identifies the *service*, never the quota level; the one
// exception is "quota used up", which is red for either service.
export const SERVICE_ACCENT: Record<ServiceType, string> = {
  cursor: "#1F2328",
  claude: "#E8945A",
};

// Deliberately darker than --color-danger (#ff7d7d): that one is tuned for the
// app's dark panels, and on LINE's white bubble it reads as washed-out pink.
export const EXHAUSTED_RED = "#E5484D";

export const BUBBLE_BG = "#FFFFFF";
const TEXT_COLOR = "#1F2328";
const TEXT_MUTED = "#6E7681";

interface FlexNode {
  type: string;
  [key: string]: unknown;
}

export interface LineFlexMessage {
  type: "flex";
  altText: string;
  contents: FlexNode;
}

export interface LineTextMessage {
  type: "text";
  text: string;
}

export type LineMessage = LineFlexMessage | LineTextMessage;

interface BubbleRow {
  label: string;
  value: string;
}

const formatTime = (
  iso: string | null | undefined,
  lang: Language,
): string | null =>
  iso ? new Date(iso).toLocaleString(localeForLanguage(lang)) : null;

const row = (entry: BubbleRow): FlexNode => ({
  type: "box",
  layout: "baseline",
  spacing: "sm",
  contents: [
    { type: "text", text: entry.label, size: "sm", color: TEXT_MUTED, flex: 2 },
    {
      type: "text",
      text: entry.value,
      size: "sm",
      color: TEXT_COLOR,
      weight: "bold",
      flex: 5,
      wrap: true,
    },
  ],
});

/**
 * The one bubble shape every LINE notification uses: white body, a thin bar of
 * the accent colour on top, accent-coloured title, then label/value rows.
 * Callers only choose the accent, the wording and the rows.
 */
const bubble = (options: {
  accent: string;
  altText: string;
  title: string;
  subtitle: string;
  rows: BubbleRow[];
  // Free-form paragraph shown below the rows, for alerts that have no
  // label/value pairs to list (credential expiry, reset alarms).
  note?: string;
  lang: Language;
  now: Date;
}): LineFlexMessage => ({
  type: "flex",
  // The phone's push banner shows nothing but altText, so it has to carry the
  // whole message on its own.
  altText: options.altText,
  contents: {
    type: "bubble",
    size: "kilo",
    body: {
      type: "box",
      layout: "vertical",
      backgroundColor: BUBBLE_BG,
      paddingAll: "16px",
      spacing: "md",
      contents: [
        {
          type: "box",
          layout: "vertical",
          height: "5px",
          cornerRadius: "3px",
          backgroundColor: options.accent,
          // A box needs at least one child; filler keeps the bar a pure block
          // of colour.
          contents: [{ type: "filler" }],
        },
        {
          type: "text",
          text: options.title,
          weight: "bold",
          size: "lg",
          color: options.accent,
          wrap: true,
        },
        {
          type: "text",
          text: options.subtitle,
          size: "sm",
          color: TEXT_COLOR,
          wrap: true,
        },
        ...options.rows.map(row),
        ...(options.note
          ? [
              {
                type: "text",
                text: options.note,
                size: "sm",
                color: TEXT_COLOR,
                wrap: true,
              },
            ]
          : []),
        {
          type: "text",
          text: t(options.lang, "line.tpl.footer", {
            time: options.now.toLocaleString(localeForLanguage(options.lang)),
          }),
          size: "xxs",
          color: TEXT_MUTED,
        },
      ],
    },
  },
});

interface QuotaTemplateOptions {
  service: ServiceType;
  // The service's display name, passed in rather than derived: SERVICE_LABELS
  // lives in the main process and shared code must not reach into it.
  serviceLabel: string;
  windowLabel: string;
  // Always *remaining* percent. Cursor's collectors store used%, so callers
  // convert before handing it over.
  remainingPercent?: number | null;
  thresholdPercent?: number;
  resetAt?: string | null;
  lang: Language;
  now?: Date;
}

/** 最低額度觸發通知 — accented with the service's own colour. */
export const buildLowQuotaFlex = (
  options: QuotaTemplateOptions,
): LineFlexMessage => {
  const {
    service,
    serviceLabel,
    windowLabel,
    remainingPercent,
    thresholdPercent,
    resetAt,
    lang,
  } = options;
  const remainingText =
    remainingPercent === null || remainingPercent === undefined
      ? t(lang, "app.unknown")
      : `${remainingPercent}%`;
  const rows: BubbleRow[] = [
    { label: t(lang, "line.tpl.remaining"), value: remainingText },
  ];

  if (thresholdPercent !== undefined) {
    rows.push({
      label: t(lang, "line.tpl.threshold"),
      value: `${thresholdPercent}%`,
    });
  }
  const resetText = formatTime(resetAt, lang);
  if (resetText) {
    rows.push({ label: t(lang, "line.tpl.resetAt"), value: resetText });
  }

  return bubble({
    accent: SERVICE_ACCENT[service],
    altText: t(lang, "line.tpl.altLow", {
      service: serviceLabel,
      label: windowLabel,
      remaining: remainingText.replace("%", ""),
      threshold: thresholdPercent ?? 0,
    }),
    title: t(lang, "line.tpl.lowTitle"),
    subtitle: `${serviceLabel} · ${windowLabel}`,
    rows,
    lang,
    now: options.now ?? new Date(),
  });
};

/** model 點數用完通知 — red for either service, per the notification spec. */
export const buildExhaustedFlex = (
  options: QuotaTemplateOptions,
): LineFlexMessage => {
  const { serviceLabel, windowLabel, resetAt, lang } = options;
  const rows: BubbleRow[] = [
    { label: t(lang, "line.tpl.remaining"), value: "0%" },
  ];
  const resetText = formatTime(resetAt, lang);
  if (resetText) {
    rows.push({ label: t(lang, "line.tpl.resetAt"), value: resetText });
  }

  return bubble({
    accent: EXHAUSTED_RED,
    altText: t(lang, "line.tpl.altExhausted", {
      service: serviceLabel,
      label: windowLabel,
    }),
    title: t(lang, "line.tpl.exhaustedTitle"),
    subtitle: `${serviceLabel} · ${windowLabel}`,
    rows,
    lang,
    now: options.now ?? new Date(),
  });
};

/**
 * Everything that isn't a quota threshold — credential expiry, reset alarms.
 * Same white bubble, same service accent, just a free-form body line.
 */
export const buildPlainAlertFlex = (options: {
  service: ServiceType;
  serviceLabel: string;
  title: string;
  body: string;
  lang: Language;
  now?: Date;
}): LineFlexMessage =>
  bubble({
    accent: SERVICE_ACCENT[options.service],
    altText: `${options.title} — ${options.body}`,
    title: options.title,
    subtitle: options.serviceLabel,
    rows: [],
    note: options.body,
    lang: options.lang,
    now: options.now ?? new Date(),
  });
