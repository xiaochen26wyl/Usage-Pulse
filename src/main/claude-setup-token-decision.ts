export type SetupTokenAction = "refreshQuota" | "openLogin";

/**
 * Whether "Get Credentials" should open a login, or just bounce to a quota
 * refresh because Keychain already has something.
 *
 * A 401 or scope-insufficient 403 on the last scrape still opens login even
 * when Keychain still holds the rejected token — otherwise the user would loop
 * on "refresh" and never be offered a new authorization.
 */
export const decideSetupTokenAction = (options: {
  hasKeychainCredential: boolean;
  lastScrapeNeedsReauth: boolean;
}): SetupTokenAction => {
  if (options.lastScrapeNeedsReauth) {
    return "openLogin";
  }
  return options.hasKeychainCredential ? "refreshQuota" : "openLogin";
};
