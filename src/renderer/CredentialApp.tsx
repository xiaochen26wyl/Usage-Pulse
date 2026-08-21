import { useEffect, useState } from "react";
import type { ManualCredentialContext } from "@shared/types";
import { t } from "@shared/i18n";

const SETUP_COMMAND = "claude setup-token";

/**
 * The hand-entry fallback for a Claude Code credential.
 *
 * Only ever opened after automatic detection has concluded twice that it
 * cannot find a usable credential, or when the user asks for it from Settings.
 * The token goes one way — into the main process, which verifies it against the
 * usage API before storing it — and never comes back out to any renderer.
 */
export const CredentialApp = (): JSX.Element => {
  const [context, setContext] = useState<ManualCredentialContext | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void window.usagePulse.requestManualCredentialContext().then((next) => {
      if (next) {
        setContext(next);
      }
    });
    return window.usagePulse.onManualCredentialContext((next) => setContext(next));
  }, []);

  if (!context) {
    return <main className="manual-token" />;
  }

  const lang = context.language;

  const copyCommand = async (): Promise<void> => {
    await window.usagePulse.copyToClipboard(SETUP_COMMAND);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      const result = await window.usagePulse.submitManualToken(token);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      // A success closes the window from the main process; clearing the field
      // keeps the token out of the DOM in the moment before that lands.
      setToken("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="manual-token">
      <h1 className="manual-token-title">{t(lang, "manualToken.title")}</h1>
      <p className="manual-token-intro">{t(lang, "manualToken.intro")}</p>
      <p className="manual-token-reason">{context.message}</p>

      <p className="manual-token-step">{t(lang, "manualToken.step1")}</p>
      <div className="manual-token-command">
        <code>{SETUP_COMMAND}</code>
        <button type="button" className="ghost-btn" onClick={copyCommand}>
          {copied ? t(lang, "auth.claude.copied") : t(lang, "auth.claude.copyCommand")}
        </button>
      </div>

      <p className="manual-token-step">{t(lang, "manualToken.step2")}</p>
      <input
        className="manual-token-input"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={token}
        placeholder={t(lang, "manualToken.placeholder")}
        onChange={(event) => setToken(event.target.value)}
      />

      {context.hasStoredToken ? <p className="manual-token-meta">{t(lang, "manualToken.stored")}</p> : null}
      {error ? <p className="manual-token-error">{error}</p> : null}
      <p className="manual-token-meta">{t(lang, "manualToken.privacy")}</p>

      <div className="manual-token-actions">
        <button
          type="button"
          className="ghost-btn"
          onClick={() => window.usagePulse.dismissManualCredential()}
          disabled={busy}
        >
          {t(lang, "manualToken.later")}
        </button>
        <button type="button" className="primary-btn" onClick={submit} disabled={busy || !token.trim()}>
          {busy ? t(lang, "manualToken.verifying") : t(lang, "manualToken.submit")}
        </button>
      </div>
    </main>
  );
};
