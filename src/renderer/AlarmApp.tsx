import { useEffect, useRef, useState } from "react";
import type { AlarmPopupPayload, ServiceType } from "@shared/types";
import { ALARM_POPUP_AUTO_DISMISS_MINUTES, formatCountdown } from "@shared/alarm-utils";
import { t, type TranslationKey } from "@shared/i18n";

const serviceNames: Record<ServiceType, string> = {
  cursor: "Cursor",
  claude: "Claude Code",
  codex: "Codex"
};

const CHIME_INTERVAL_MS = 2500;

const formatTime = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "--:--";
  }
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

// A short synthesised two-tone chime. Generating it with the Web Audio API
// keeps the app free of any bundled audio asset (and of the licensing question
// that shipping a system sound would raise).
const playChime = (context: AudioContext): void => {
  const startAt = context.currentTime;
  const tones = [
    { frequency: 880, offset: 0 },
    { frequency: 1320, offset: 0.18 }
  ];

  for (const tone of tones) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const begin = startAt + tone.offset;

    oscillator.type = "sine";
    oscillator.frequency.value = tone.frequency;
    gain.gain.setValueAtTime(0.0001, begin);
    gain.gain.exponentialRampToValueAtTime(0.22, begin + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, begin + 0.32);

    oscillator.connect(gain).connect(context.destination);
    oscillator.start(begin);
    oscillator.stop(begin + 0.34);
  }
};

/**
 * The popup used to announce "Quota reset" whatever it was actually about, so a
 * low-quota or used-up warning claimed a reset that had not happened. The title
 * now follows the alert that opened it.
 */
const alarmTitleKey = (id: AlarmPopupPayload["id"]): TranslationKey => {
  if (id === "water") {
    return "water.popup.title";
  }
  if (id === "cursor-billing") {
    return "alarm.popup.title.cursorPeriod";
  }
  if (id === "claude-billing") {
    return "alarm.popup.title.claudePeriod";
  }
  if (id === "claude-cooldown" || id === "codex-cooldown") {
    return "alarm.popup.title.cooldown";
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
  const audioContextRef = useRef<AudioContext | null>(null);

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
    window.usagePulse.requestAlarmPayload().catch((error) => {
      console.error("[Usage-Pulse] failed to request alarm payload", error);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!payload?.soundEnabled) {
      return;
    }

    const context = audioContextRef.current ?? new AudioContext();
    audioContextRef.current = context;
    void context.resume();

    playChime(context);
    const timer = window.setInterval(() => playChime(context), CHIME_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [payload?.id, payload?.fireAt, payload?.soundEnabled]);

  useEffect(
    () => () => {
      void audioContextRef.current?.close();
      audioContextRef.current = null;
    },
    []
  );

  if (!payload) {
    return <main className="alarm" />;
  }

  const lang = payload.language;
  const isWater = payload.id === "water";
  const serviceLabel = payload.service ? serviceNames[payload.service] : "Usage-Pulse";

  return (
    <main className="alarm">
      <div className="alarm-head">
        <strong className="alarm-title">{t(lang, alarmTitleKey(payload.id))}</strong>
      </div>

      <p className="alarm-subject">{isWater ? payload.label : `${serviceLabel} · ${payload.label}`}</p>
      {isWater ? null : payload.countdownTarget ? (
        <p className="alarm-meta">
          {t(lang, "alarm.popup.cooldownCountdown", { countdown: formatCountdown(payload.countdownTarget, now, lang) })}
        </p>
      ) : (
        <p className="alarm-meta">{t(lang, "alarm.popup.firedAt", { time: formatTime(payload.fireAt) })}</p>
      )}
      <p className="alarm-meta">{t(lang, "alarm.autoDismiss", { minutes: ALARM_POPUP_AUTO_DISMISS_MINUTES })}</p>

      <div className="alarm-actions">
        {isWater ? (
          <>
            <button type="button" className="primary-btn" onClick={() => window.usagePulse.drinkWater()}>
              {t(lang, "water.popup.drink")}
            </button>
            <button type="button" className="warning-btn" onClick={() => window.usagePulse.skipWater()}>
              {t(lang, "water.popup.skip")}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="warning-btn" onClick={() => window.usagePulse.snoozeAlarm()}>
              {t(lang, "alarm.popup.snooze")}
            </button>
            <button type="button" className="primary-btn" onClick={() => window.usagePulse.dismissAlarm()}>
              {t(lang, "alarm.popup.dismiss")}
            </button>
          </>
        )}
      </div>
    </main>
  );
};
