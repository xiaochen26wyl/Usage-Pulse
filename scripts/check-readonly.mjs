import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const root = process.cwd();
const targetDir = join(root, "src", "main");

const sensitiveHints = [
  "state.vscdb",
  ".credentials.json",
  "claude code-credentials",
  "cursorauth/accesstoken",
  // The Claude Code CLI session logs. Not a credential, but the same rule
  // applies: Usage-Pulse reads the IDE's own files and never writes to them.
  "claude_config_dir",
  ".jsonl",
  "auth.json",
  // Directory / env forms only — the bare `.codex` substring also matches
  // `snapshot.codex` and would pull every third-service file into the scan.
  "~/.codex",
  "codex_home"
];
const writeHints = [
  "writefile(",
  "writefilesync(",
  "appendfile(",
  "appendfilesync(",
  "unlink(",
  "rm(",
  "rename(",
  "copyfile(",
  "insert into",
  "update ",
  "delete from",
  // A write does not have to go through fs. The Keychain is reached by
  // subprocess, so the guard has to know what a write looks like there too —
  // otherwise the one place that legitimately writes a credential is also the
  // one place the guard cannot see.
  "add-generic-password",
  "delete-generic-password",
  "set-generic-password"
];

// The single deliberate exception, recorded rather than hidden: writing a
// `claude setup-token` into a Usage-Pulse-owned Keychain item so the next
// re-detect can find it. Anything NOT listed here that trips a write hint is
// a genuine violation.
//
// Each entry names the file and the exact write it is allowed to perform. Adding
// to this list is a deliberate act that shows up in review.
const allowedWrites = new Map([["src/main/credential-provider.ts", ["add-generic-password"]]]);

const listFiles = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        return listFiles(fullPath);
      }
      return [fullPath];
    })
  );
  return nested.flat();
};

const main = async () => {
  const files = (await listFiles(targetDir)).filter((path) => path.endsWith(".ts"));
  const violations = [];
  const exercised = [];

  for (const filePath of files) {
    const source = (await readFile(filePath, "utf-8")).toLowerCase();
    const hasSensitiveAccess = sensitiveHints.some((hint) => source.includes(hint));
    if (!hasSensitiveAccess) {
      continue;
    }
    const relativePath = relative(root, filePath).split(sep).join("/");
    const allowed = allowedWrites.get(relativePath) ?? [];
    const writeMatch = writeHints.find((hint) => source.includes(hint) && !allowed.includes(hint));
    if (writeMatch) {
      violations.push(`${filePath} (matched: ${writeMatch})`);
    }
    for (const exception of allowed) {
      if (source.includes(exception)) {
        exercised.push(`${relativePath} -> ${exception}`);
      }
    }
  }

  if (violations.length > 0) {
    console.error("Readonly check failed. Sensitive credential paths must remain read-only:");
    for (const line of violations) {
      console.error(`- ${line}`);
    }
    process.exit(1);
  }

  for (const line of exercised) {
    console.log(`Readonly check: allowed exception in use - ${line}`);
  }
  console.log("Readonly check passed.");
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Readonly check error: ${message}`);
  process.exit(1);
});
