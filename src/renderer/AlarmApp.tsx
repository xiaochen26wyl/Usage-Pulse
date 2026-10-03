import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { AlarmPopupPayload, ServiceType } from "@shared/types";
import { ALARM_POPUP_AUTO_DISMISS_SECONDS, formatCountdown } from "@shared/alarm-utils";
import { t, type TranslationKey } from "@shared/i18n";

const serviceNames: Record<ServiceType, string> = {
  cursor: "Cursor",
  claude: "Claude Code",
  codex: "Codex"
};

const formatTime = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "--:--";
  }
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

const isCooldownPopup = (id: AlarmPopupPayload["id"]): boolean =>
  id === "test" || id === "claude-cooldown" || id === "codex-cooldown";

const isSessionReset = (id: AlarmPopupPayload["id"]): boolean =>
  id === "claude-session" || id === "codex-session";

const isWeeklyReset = (id: AlarmPopupPayload["id"]): boolean =>
  id === "claude-weekly" || id === "codex-weekly";

const alarmTitleKey = (id: AlarmPopupPayload["id"]): TranslationKey => {
  if (id === "cursor-billing") {
    return "alarm.popup.title.cursorPeriod";
  }
  if (id === "claude-billing") {
    return "alarm.popup.title.claudePeriod";
  }
  if (isCooldownPopup(id)) {
    return "alarm.popup.title.cooldown";
  }
  if (id === "claude-session-low" || id === "codex-session-low") {
    return "alarm.popup.title.sessionLow";
  }
  if (id === "claude-weekly-low" || id === "codex-weekly-low") {
    return "alarm.popup.title.weeklyLow";
  }
  if (id === "cursor-models-low") {
    return "alarm.popup.title.cursorModelsLow";
  }
  if (id === "cursor-advanced-models-low") {
    return "alarm.popup.title.cursorAdvancedLow";
  }
  if (id === "claude-weekly-exhausted" || id === "codex-weekly-exhausted") {
    return "alarm.popup.title.weeklyExhausted";
  }
  if (id === "cursor-models-exhausted") {
    return "alarm.popup.title.cursorModelsExhausted";
  }
  if (id === "cursor-advanced-models-exhausted") {
    return "alarm.popup.title.cursorAdvancedExhausted";
  }
  if (isSessionReset(id)) {
    return "alarm.popup.title.sessionReset";
  }
  if (isWeeklyReset(id)) {
    return "alarm.popup.title.weeklyReset";
  }
  if (id.endsWith("-exhausted")) {
    return "alarm.popup.title.exhausted";
  }
  if (id.endsWith("-low")) {
    return "alarm.popup.title.low";
  }
  return "alarm.popup.title";
};

export const AlarmApp = () => {
  const [payload, setPayload] = useState<AlarmPopupPayload | null>(null);
  const [now, setNow] = useState<number>(Date.now());
  const rootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!payload?.countdownTarget) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [payload?.countdownTarget]);

  useEffect(() => {
    const unsubscribe = window.usagePulse.onAlarmPayload((next) => {
      setPayload(next);
    });
    window.usagePulse
      .requestAlarmPayload()
      .then((next) => {
        if (next) {
          setPayload(next);
        }
      })
      .catch((error) => {
        console.error("[Usage-Pulse] failed to request alarm payload", error);
      });
    return () => {
      unsubscribe();
    };
  }, []);

  useLayoutEffect(() => {
    const node = rootRef.current;
    if (!node || !payload) {
      return;
    }

    const reportHeight = (): void => {
      const height = Math.ceil(node.getBoundingClientRect().height);
      void window.usagePulse.fitAlarmSize(height);
    };

    reportHeight();
    const observer = new ResizeObserver(reportHeight);
    observer.observe(node);
    return () => observer.disconnect();
  }, [payload]);

  if (!payload) {
    return <main className="alarm" />;
  }

  const lang = payload.language;
  const isCooldown = isCooldownPopup(payload.id);
  const isBilling = payload.id === "cursor-billing" || payload.id === "claude-billing";
  const isReset = isSessionReset(payload.id) || isWeeklyReset(payload.id);
  const serviceLabel = payload.service ? serviceNames[payload.service] : "Usage-Pulse";
  const title = t(lang, alarmTitleKey(payload.id), { service: serviceLabel });
  const countdownText = payload.countdownTarget
    ? t(lang, "alarm.popup.cooldownCountdown", {
        countdown: formatCountdown(payload.countdownTarget, now, lang)
      })
    : null;

  let card: ReactNode = null;
  let extraMeta: ReactNode = null;

  if (countdownText && payload.countdownTarget) {
    card = (
      <div className="alarm-countdown-card">
        <p className="alarm-countdown">
          {t(lang, "alarm.popup.nextAvailable", { time: formatTime(payload.countdownTarget) })}
        </p>
      </div>
    );
    extraMeta = <p className="alarm-meta">{countdownText}</p>;
  } else if (isReset) {
    card = (
      <div className="alarm-countdown-card">
        <p className="alarm-countdown">{t(lang, "alarm.popup.nowAvailable")}</p>
      </div>
    );
    extraMeta = <p className="alarm-meta">{t(lang, "alarm.popup.resetAt", { time: formatTime(payload.fireAt) })}</p>;
  } else if (isBilling) {
    card = (
      <div className="alarm-countdown-card">
        <p className="alarm-countdown">{t(lang, "alarm.popup.endedAt", { time: formatTime(payload.fireAt) })}</p>
      </div>
    );
  } else {
    extraMeta = <p className="alarm-meta">{t(lang, "alarm.popup.firedAt", { time: formatTime(payload.fireAt) })}</p>;
  }

  return (
    <main ref={rootRef} className="alarm" onPointerDown={() => window.focus()}>
      <div className="alarm-head">
        <strong className="alarm-title">{title}</strong>
      </div>

      {card}
      {extraMeta}
      {isCooldown && payload.resetAlarmEnabled ? (
        <p className="alarm-meta">{t(lang, "alarm.popup.resetAlarmOn")}</p>
      ) : null}
      <p className="alarm-meta">{t(lang, "alarm.autoDismiss", { seconds: ALARM_POPUP_AUTO_DISMISS_SECONDS })}</p>
    </main>
  );
};
