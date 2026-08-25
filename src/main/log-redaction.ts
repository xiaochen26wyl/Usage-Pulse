/**
 * Turns anything destined for a log line into a string with secrets removed.
 *
 * The motivating case is `child_process`: Node attaches the *entire* command —
 * every argument included — to both `error.cmd` and `error.message`, so logging
 * a failed `security add-generic-password` used to print the Claude token
 * verbatim. Axios errors are the same story from the other direction, carrying
 * `config.headers.Authorization` through `util.inspect`.
 *
 * The rule this module enforces is simple: nothing in src/main ever hands a
 * raw error object to console.*, it goes through redact() first.
 */

const PATTERNS: Array<[RegExp, string]> = [
  // Anthropic tokens in every flavour: sk-ant-oat01-, sk-ant-api03-, ...
  [/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-[redacted]"],
  // Cursor / LINE / anything else presented as a bearer credential.
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  // The JSON credential blob shape written to (and read from) the Keychain.
  [/("(?:access_?[Tt]oken|refresh_?[Tt]oken)"\s*:\s*")[^"]*(")/g, "$1[redacted]$2"],
  // LINE channel access tokens are long opaque base64url runs with no prefix to
  // key off, so fall back to the header they always travel in.
  [/(channelAccessToken"?\s*[:=]\s*"?)[A-Za-z0-9._~+/=-]{20,}/gi, "$1[redacted]"]
];

export const redactSecrets = (text: string): string =>
  PATTERNS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);

/**
 * The safe form of any value for a log line.
 *
 * Errors collapse to `name: message` — deliberately not the full object, whose
 * enumerable extras (`cmd`, `config`, `request`) are exactly where credentials
 * hide.
 */
export const redact = (value: unknown): string => {
  if (value instanceof Error) {
    return redactSecrets(`${value.name}: ${value.message}`);
  }
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  try {
    return redactSecrets(String(value));
  } catch {
    return "[unprintable]";
  }
};
