import { useEffect, useRef, useState } from "react";
import type { AlarmPopupPayload, ServiceType } from "@shared/types";
import { t } from "@shared/i18n";

const serviceNames: Record<ServiceType, string> = {
  cursor: "Cursor",
  claude: "Claude Code"
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

export const AlarmApp = () => {
  const [payload, setPayload] = useState<AlarmPopupPayload | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

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
  const serviceLabel = payload.service ? serviceNames[payload.service] : "Usage-Pulse";

  return (
    <main className="alarm">
      <div className="alarm-head">
        <strong className="alarm-title">{t(lang, "alarm.popup.title")}</strong>
        {payload.catchUp ? <span className="status-tag status-low">{t(lang, "alarm.popup.catchUp")}</span> : null}
      </div>

      <p className="alarm-subject">
        {serviceLabel} · {payload.label}
      </p>
      <p className="alarm-meta">{t(lang, "alarm.popup.firedAt", { time: formatTime(payload.fireAt) })}</p>
      <p className="alarm-meta">{t(lang, "alarm.autoDismiss", { minutes: payload.autoDismissMinutes })}</p>

      <div className="alarm-actions">
        <button type="button" className="warning-btn" onClick={() => window.usagePulse.snoozeAlarm()}>
          {t(lang, "alarm.popup.snooze")}
        </button>
        <button type="button" className="primary-btn" onClick={() => window.usagePulse.dismissAlarm()}>
          {t(lang, "alarm.popup.dismiss")}
        </button>
      </div>
    </main>
  );
};
