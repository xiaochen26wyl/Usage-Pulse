// Both `claude auth login` and the retired `claude setup-token` mint tokens
// with this prefix, so it stays a valid sanity check regardless of which flow
// wrote the Keychain item.
export const CLAUDE_OAUTH_TOKEN_PREFIX = "sk-ant-oat01-";

export const isClaudeOAuthToken = (value: string): boolean =>
  value.startsWith(CLAUDE_OAUTH_TOKEN_PREFIX);
