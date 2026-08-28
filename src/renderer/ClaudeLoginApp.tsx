import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { Language } from "@shared/types";
import { t } from "@shared/i18n";

export const ClaudeLoginApp = () => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [lang, setLang] = useState<Language>("zh");
  const [exited, setExited] = useState(false);

  useEffect(() => {
    window.usagePulse
      .getSettings()
      .then((settings) => setLang(settings.language))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const term = new Terminal({
      convertEol: true,
      fontSize: 13,
      theme: { background: "#1e1e1e", foreground: "#e6e6e6" }
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();
    window.usagePulse.resizeClaudeLoginPty(term.cols, term.rows);

    const dataDisposable = term.onData((data) => {
      window.usagePulse.sendClaudeLoginInput(data);
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      window.usagePulse.resizeClaudeLoginPty(term.cols, term.rows);
    });
    resizeObserver.observe(containerRef.current);

    const unsubscribeData = window.usagePulse.onClaudeLoginData((chunk) => {
      term.write(chunk);
    });
    const unsubscribeExit = window.usagePulse.onClaudeLoginExit(() => {
      setExited(true);
    });

    return () => {
      dataDisposable.dispose();
      resizeObserver.disconnect();
      unsubscribeData();
      unsubscribeExit();
      term.dispose();
    };
  }, []);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "#1e1e1e",
        color: "#e6e6e6",
        fontFamily: "system-ui, sans-serif"
      }}
    >
      <p style={{ margin: 0, padding: "10px 14px", fontSize: 13, borderBottom: "1px solid #333" }}>
        {t(lang, "claudeLogin.hint")}
      </p>
      {exited ? (
        <p style={{ margin: 0, padding: "6px 14px", fontSize: 12, color: "#f0b429", background: "#2a2410" }}>
          {t(lang, "claudeLogin.exited")}
        </p>
      ) : null}
      <div ref={containerRef} style={{ flex: 1, padding: "8px", minHeight: 0 }} />
    </div>
  );
};
