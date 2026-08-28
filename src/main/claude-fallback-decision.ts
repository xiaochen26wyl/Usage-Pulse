import type { CredentialSource } from "@shared/types";

export type FallbackClearDecision = "clear" | "keepNotOurToken" | "keepNoFallbackBeneath";

/**
 * Whether a 401 justifies dropping the stored `claudeManualOAuthToken`.
 *
 * The stored token is a fallback for when the setup-token flow's Keychain write
 * couldn't be confirmed, and it outranks the Keychain in readClaudeCredential's
 * order. Dropping it on a confirmed-dead credential is right in principle, but
 * only under two conditions that the old unconditional `if` checked neither of:
 *
 *  - The rejected request must actually have used it. A 401 against the
 *    CLAUDE_CODE_OAUTH_TOKEN env credential (which outranks it) says nothing
 *    about the stored token, and deleting it there destroys a working fallback
 *    the user pasted in by hand.
 *
 *  - There must be something different underneath to fall back to. When the
 *    stored token and the Keychain hold the same value — the documented common
 *    case, since the flow that stores it also writes the Keychain — dropping it
 *    changes which source answers but not the answer, so the next fetch 401s
 *    identically. On Windows and Linux there is no Keychain at all, so the drop
 *    turns "dead credential" into "no credential", which is strictly worse.
 */
export const decideClaudeFallbackClear = (
  usedSource: CredentialSource | undefined,
  storedFallbackToken: string,
  tokenBeneath: string | null
): FallbackClearDecision => {
  if (!storedFallbackToken || usedSource !== "manual") {
    return "keepNotOurToken";
  }
  if (!tokenBeneath || tokenBeneath === storedFallbackToken) {
    return "keepNoFallbackBeneath";
  }
  return "clear";
};
