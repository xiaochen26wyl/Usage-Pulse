import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A read-only window onto the Claude Code CLI's local session logs.
 *
 * Two things live here that the usage API cannot give us cheaply:
 *
 *  - **Activity.** Whether the CLI has done anything since we last looked is a
 *    file mtime, not a network call. Knowing the CLI is idle is what lets the
 *    monitor skip a poll entirely instead of asking Anthropic the same question
 *    every ten minutes.
 *  - **Ground truth for a lockout.** When a request is actually rate-limited the
 *    CLI records a `quotaLimits` object on that line, carrying the rejection and
 *    the window's real `resetsAt`. That corroborates a "quota used up" reading
 *    without spending a single request.
 *
 * The directory also holds full conversation text and account identifiers, so
 * this module is deliberately narrow: it stats files, reads only the tail of
 * the few that changed, keeps only lines that literally contain `quotaLimits`,
 * and extracts only the four fields below. Nothing else is parsed, retained,
 * logged, or handed across IPC. Nothing here ever writes.
 */

// Only the last slice of each changed file is read. A rate-limit rejection is
// followed by very little output, so it is always near the end; reading whole
// files would mean pulling hundreds of megabytes of conversation into memory.
const TAIL_BYTES = 64 * 1024;

// A guard against a pathological projects directory: newest-first, then capped.
const MAX_FILES_PER_SCAN = 40;

export interface ClaudeCliQuotaEvent {
  // When the CLI recorded the rejection.
  at: string;
  // "rejected" is the case we care about; other statuses are passed through
  // rather than interpreted here.
  status: string;
  // "five_hour" | "seven_day" | ... — left as the raw string.
  rateLimitType: string | null;
  resetsAt: string | null;
}

export interface ClaudeCliActivity {
  lastActivityAt: string | null;
  fileCount: number;
}

const resolveClaudeProjectsDir = (): string => {
  const customDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (customDir) {
    return join(customDir, "projects");
  }
  if (process.platform === "win32") {
    const profile = process.env.USERPROFILE || homedir();
    return join(profile, ".claude", "projects");
  }
  return join(homedir(), ".claude", "projects");
};

interface LogFile {
  path: string;
  mtimeMs: number;
}

const listSessionLogs = async (): Promise<LogFile[]> => {
  const root = resolveClaudeProjectsDir();
  let projectDirs: string[];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    projectDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
  } catch {
    // No projects directory at all: the CLI has never run here, or the path is
    // not readable. Either way there is nothing to report and nothing to fix.
    return [];
  }

  const files: LogFile[] = [];
  for (const dir of projectDirs) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) {
        continue;
      }
      const path = join(dir, name);
      try {
        const info = await stat(path);
        files.push({ path, mtimeMs: info.mtimeMs });
      } catch {
        // Raced with a rotation or unreadable; skip it.
      }
    }
  }
  return files;
};

/**
 * When the CLI last wrote anything. Stats only — no file contents are read.
 */
export const readClaudeCliActivity = async (): Promise<ClaudeCliActivity> => {
  const files = await listSessionLogs();
  if (files.length === 0) {
    return { lastActivityAt: null, fileCount: 0 };
  }
  const newest = files.reduce((best, file) => (file.mtimeMs > best.mtimeMs ? file : best));
  return {
    lastActivityAt: new Date(newest.mtimeMs).toISOString(),
    fileCount: files.length
  };
};

const toIso = (value: unknown): string | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    // The CLI writes resetsAt as epoch seconds; tolerate milliseconds too.
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
};

/**
 * Pulls the quota events out of one line of log.
 *
 * Exported for tests. Returns null for every line that is not a quota event,
 * which is the overwhelming majority — those lines are never parsed at all
 * thanks to the substring pre-filter in readClaudeCliQuotaEvents.
 */
export const parseQuotaLine = (line: string): ClaudeCliQuotaEvent | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // A truncated first line is expected: we start reading mid-file.
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const quota = record.quotaLimits;
  if (!quota || typeof quota !== "object") {
    return null;
  }
  const limits = quota as Record<string, unknown>;
  const status = typeof limits.status === "string" ? limits.status : null;
  if (!status) {
    return null;
  }
  return {
    at: toIso(record.timestamp) ?? new Date(0).toISOString(),
    status,
    rateLimitType: typeof limits.rateLimitType === "string" ? limits.rateLimitType : null,
    resetsAt: toIso(limits.resetsAt)
  };
};

const readTail = async (path: string, bytes: number): Promise<string> => {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    const length = Math.min(bytes, info.size);
    const start = info.size - length;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer.toString("utf-8");
  } finally {
    await handle.close();
  }
};

/**
 * Quota events recorded at or after `sinceMs`, newest last.
 *
 * Only files modified since then are opened, and only their tail is read.
 */
export const readClaudeCliQuotaEvents = async (sinceMs: number): Promise<ClaudeCliQuotaEvent[]> => {
  const files = (await listSessionLogs())
    .filter((file) => file.mtimeMs >= sinceMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_FILES_PER_SCAN);

  const events: ClaudeCliQuotaEvent[] = [];
  for (const file of files) {
    let tail: string;
    try {
      tail = await readTail(file.path, TAIL_BYTES);
    } catch {
      continue;
    }
    for (const line of tail.split("\n")) {
      // Cheap substring gate first: only lines that actually mention a quota
      // limit are ever handed to JSON.parse, so conversation content is never
      // deserialized.
      if (!line.includes('"quotaLimits"')) {
        continue;
      }
      const event = parseQuotaLine(line);
      if (event && Date.parse(event.at) >= sinceMs) {
        events.push(event);
      }
    }
  }

  return events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
};

/**
 * Whether the CLI itself was turned away by the given window recently.
 *
 * `resetsAt` is compared because a rejection from the *previous* cycle says
 * nothing about the current one.
 */
export const hasRecentRejection = (
  events: ClaudeCliQuotaEvent[],
  rateLimitTypes: string[],
  resetsAt: string | null
): boolean => {
  const targetMs = resetsAt ? Date.parse(resetsAt) : NaN;
  return events.some((event) => {
    if (event.status !== "rejected") {
      return false;
    }
    if (event.rateLimitType && !rateLimitTypes.includes(event.rateLimitType)) {
      return false;
    }
    if (Number.isNaN(targetMs) || !event.resetsAt) {
      return true;
    }
    // The CLI and the API can round the same boundary differently; a couple of
    // minutes of slack keeps them matching without letting a stale cycle in.
    return Math.abs(Date.parse(event.resetsAt) - targetMs) <= 5 * 60_000;
  });
};

/**
 * The newest still-in-the-future reset time the CLI recorded for a window.
 *
 * The usage API does not always carry a reset time, and without one the reset
 * alarm cannot be armed and the cooldown countdown has nothing to count to.
 * The CLI writes the real `resetsAt` alongside every rejection, so when the API
 * leaves the field out the local log can supply it — no request, no credential.
 * Past reset times are ignored: a rejection from a spent cycle says nothing
 * about the current one.
 */
export const latestFutureReset = (
  events: ClaudeCliQuotaEvent[],
  rateLimitTypes: string[],
  nowMs: number
): string | null => {
  let best: string | null = null;
  let bestMs = -Infinity;

  for (const event of events) {
    if (!event.resetsAt || (event.rateLimitType && !rateLimitTypes.includes(event.rateLimitType))) {
      continue;
    }
    const ms = Date.parse(event.resetsAt);
    if (Number.isNaN(ms) || ms <= nowMs || ms <= bestMs) {
      continue;
    }
    best = event.resetsAt;
    bestMs = ms;
  }
  return best;
};
