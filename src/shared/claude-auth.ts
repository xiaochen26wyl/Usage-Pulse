// Claude Code waits for the browser's one-time `code#state` value in its
// terminal before exchanging it for the long-lived setup-token.
export const CLAUDE_OAUTH_TOKEN_PREFIX = "sk-ant-oat01-";

export const isClaudeAuthCodePrompt = (text: string): boolean =>
  /paste\s+code\s+here\s+if\s+prompted/i.test(text);

export const isClaudeOAuthToken = (value: string): boolean =>
  value.startsWith(CLAUDE_OAUTH_TOKEN_PREFIX);
