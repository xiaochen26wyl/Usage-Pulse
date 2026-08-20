import type { CredentialState } from "./types";

// How long before a credential's own expiry we start calling it "expiring".
// Wide enough that the IDE's own refresh normally lands inside the window, so
// the user sees a heads-up rather than a hard failure.
export const EXPIRING_SOON_MS = 30 * 60_000;

// The periodic sweep that re-reads every credential from its source.
export const CREDENTIAL_CHECK_INTERVAL_MS = 4 * 60 * 60_000;

const parseIsoMs = (iso: string | null): number | null => {
  if (!iso) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
};

/**
 * Where a credential sits relative to its own expiry.
 *
 * A credential with no parseable expiry is reported as "ok" rather than
 * "error": plenty of tokens legitimately carry no `exp`, and claiming they are
 * broken would fire the notification path on every sweep.
 */
export const classifyCredentialState = (
  expiresAt: string | null,
  nowMs: number,
  expiringSoonMs: number = EXPIRING_SOON_MS
): CredentialState => {
  const expiryMs = parseIsoMs(expiresAt);
  if (expiryMs === null) {
    return "ok";
  }
  if (nowMs >= expiryMs) {
    return "expired";
  }
  if (nowMs >= expiryMs - expiringSoonMs) {
    return "expiring";
  }
  return "ok";
};

/**
 * Whether the periodic sweep is overdue.
 *
 * setInterval does not advance while the machine sleeps, so the wake handlers
 * consult this against the persisted `checkedAt` instead of trusting the timer
 * to have ticked. A missing timestamp means "never checked" and is always due.
 */
export const isCredentialCheckDue = (
  checkedAt: string | null,
  nowMs: number,
  intervalMs: number = CREDENTIAL_CHECK_INTERVAL_MS
): boolean => {
  const lastMs = parseIsoMs(checkedAt);
  if (lastMs === null) {
    return true;
  }
  return nowMs - lastMs >= intervalMs;
};

// A credential state that warrants telling the user something is wrong, as
// opposed to one that is merely approaching its refresh.
export const isCredentialUnusable = (state: CredentialState): boolean =>
  state === "expired" || state === "missing" || state === "error";
