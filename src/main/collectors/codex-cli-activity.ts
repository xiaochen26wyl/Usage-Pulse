import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveCodexHome } from "@main/credential-provider";

/**
 * Read-only mtime scan of Codex CLI session logs under ~/.codex/sessions.
 *
 * Only used to decide whether the CLI has been active since the last usage
 * fetch. Session JSONL also holds conversation text, so this module never
 * opens file contents — it stats, then stops.
 */

const MAX_FILES_PER_SCAN = 40;

export interface CodexCliActivity {
  lastActivityAt: string | null;
  fileCount: number;
}

interface SessionFile {
  path: string;
  mtimeMs: number;
}

const listSessionFiles = async (root: string, files: SessionFile[], remaining: { count: number }): Promise<void> => {
  if (remaining.count <= 0) {
    return;
  }
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (remaining.count <= 0) {
      return;
    }
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      await listSessionFiles(full, files, remaining);
      continue;
    }
    const lower = entry.name.toLowerCase();
    if (!lower.endsWith(".jsonl") && !lower.endsWith(".json")) {
      continue;
    }
    try {
      const info = await stat(full);
      files.push({ path: full, mtimeMs: info.mtimeMs });
      remaining.count -= 1;
    } catch {
      // Unreadable file: skip.
    }
  }
};

export const readCodexCliActivity = async (): Promise<CodexCliActivity> => {
  const roots = [join(resolveCodexHome(), "sessions"), join(resolveCodexHome(), "archived_sessions")];
  const files: SessionFile[] = [];
  const remaining = { count: MAX_FILES_PER_SCAN };
  for (const root of roots) {
    await listSessionFiles(root, files, remaining);
  }
  if (files.length === 0) {
    return { lastActivityAt: null, fileCount: 0 };
  }
  let newest = 0;
  for (const file of files) {
    if (file.mtimeMs > newest) {
      newest = file.mtimeMs;
    }
  }
  return {
    lastActivityAt: newest > 0 ? new Date(newest).toISOString() : null,
    fileCount: files.length
  };
};
