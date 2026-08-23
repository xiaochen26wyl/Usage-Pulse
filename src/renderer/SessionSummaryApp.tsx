import { useEffect, useState } from "react";
import type { Language, SessionMetricDelta, SessionStats } from "@shared/types";
import { t } from "@shared/i18n";

const formatDuration = (durationMs: number, lang: Language): string => {
  const totalMinutes = Math.max(0, Math.floor(durationMs / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) {
    return t(lang, "session.durationMinutes", { minutes });
  }
  return t(lang, "session.duration", { hours, minutes });
};

const formatMetric = (delta: SessionMetricDelta, lang: Language): string => {
  if (delta.kind === "reset") {
    return t(lang, "session.reset");
  }
  if (delta.kind === "unknown" || delta.used === null) {
    return t(lang, "session.unknown");
  }
  if (delta.unit === "usd") {
    return t(lang, "session.usedUsd", { amount: delta.used.toFixed(2) });
  }
  return t(lang, "session.usedPercent", { percent: Math.round(delta.used) });
};

const metricLabel = (key: SessionMetricDelta["key"]): "session.metric.billing" | "session.metric.cursorModels" | "session.metric.advancedModels" | "session.metric.claudeSession" | "session.metric.claudeWeekly" => {
  if (key === "billing") {
    return "session.metric.billing";
  }
  if (key === "cursorModels") {
    return "session.metric.cursorModels";
  }
  if (key === "advancedModels") {
    return "session.metric.advancedModels";
  }
  if (key === "claudeSession") {
    return "session.metric.claudeSession";
  }
  return "session.metric.claudeWeekly";
};

export const SessionSummaryApp = () => {
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [now, setNow] = useState(Date.now());
  const [lang, setLang] = useState<Language>("zh");

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    window.usagePulse.getSettings().then((settings) => setLang(settings.language)).catch((error) => {
      console.error("[Usage-Pulse] failed to load language for session summary", error);
    });
    const unsubscribe = window.usagePulse.onSessionStatsUpdated((next) => {
      setStats(next);
    });
    window.usagePulse.requestSessionStats().then(setStats).catch((error) => {
      console.error("[Usage-Pulse] failed to request session stats", error);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  if (!stats) {
    return <main className="session-summary" />;
  }

  const elapsedMs = Math.max(stats.durationMs, Date.now() - new Date(stats.startedAt).getTime(), now - new Date(stats.startedAt).getTime());

  return (
    <main className="session-summary">
      <h1 className="session-summary-title">{t(lang, "session.title")}</h1>
      <p className="session-summary-duration">{formatDuration(elapsedMs, lang)}</p>

      <section className="session-summary-block session-summary-block-cursor">
        <h2>{t(lang, "session.cursor")}</h2>
        <p>
          {t(lang, metricLabel(stats.usage.billing.key))} · {formatMetric(stats.usage.billing, lang)}
        </p>
        <p>
          {t(lang, metricLabel(stats.usage.cursorModels.key))} · {formatMetric(stats.usage.cursorModels, lang)}
        </p>
        <p>
          {t(lang, metricLabel(stats.usage.advancedModels.key))} · {formatMetric(stats.usage.advancedModels, lang)}
        </p>
      </section>

      <section className="session-summary-block session-summary-block-claude">
        <h2>{t(lang, "session.claude")}</h2>
        <p>
          {t(lang, metricLabel(stats.usage.claudeSession.key))} · {formatMetric(stats.usage.claudeSession, lang)}
        </p>
        <p>
          {t(lang, metricLabel(stats.usage.claudeWeekly.key))} · {formatMetric(stats.usage.claudeWeekly, lang)}
        </p>
      </section>

      <section className="session-summary-block session-summary-block-water">
        <h2>{t(lang, "session.water")}</h2>
        <p>{t(lang, "session.waterValue", { ml: stats.waterMl, cups: stats.waterCups })}</p>
      </section>

      <div className="session-summary-actions">
        <button type="button" className="ghost-btn" onClick={() => window.usagePulse.continueSession()}>
          {t(lang, "session.continue")}
        </button>
        <button type="button" className="danger-btn" onClick={() => window.usagePulse.confirmQuit()}>
          {t(lang, "session.quit")}
        </button>
      </div>
    </main>
  );
};
