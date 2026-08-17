import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const targetDir = join(root, "src", "main");

const sensitiveHints = ["state.vscdb", ".credentials.json", "claude code-credentials", "cursorauth/accesstoken"];
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
  "delete from"
];

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

  for (const filePath of files) {
    const source = (await readFile(filePath, "utf-8")).toLowerCase();
    const hasSensitiveAccess = sensitiveHints.some((hint) => source.includes(hint));
    if (!hasSensitiveAccess) {
      continue;
    }
    const writeMatch = writeHints.find((hint) => source.includes(hint));
    if (writeMatch) {
      violations.push(`${filePath} (matched: ${writeMatch})`);
    }
  }

  if (violations.length > 0) {
    console.error("Readonly check failed. Sensitive credential paths must remain read-only:");
    for (const line of violations) {
      console.error(`- ${line}`);
    }
    process.exit(1);
  }

  console.log("Readonly check passed.");
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Readonly check error: ${message}`);
  process.exit(1);
});
