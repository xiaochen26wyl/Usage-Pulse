import { access } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const requiredFiles = [
  "dist/main/index.js",
  "dist/preload/index.js",
  "dist/renderer/index.html",
  "dist/renderer/alarm.html",
  "dist/renderer/credential.html",
  "dist/renderer/session.html"
];

const assertExists = async (relativePath) => {
  const absolutePath = join(root, relativePath);
  await access(absolutePath);
  return relativePath;
};

const main = async () => {
  const missing = [];
  for (const file of requiredFiles) {
    try {
      await assertExists(file);
    } catch {
      missing.push(file);
    }
  }

  if (missing.length > 0) {
    console.error("Smoke build check failed. Missing build artifacts:");
    for (const file of missing) {
      console.error(`- ${file}`);
    }
    process.exit(1);
  }

  console.log("Smoke build check passed.");
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Smoke build script failed: ${message}`);
  process.exit(1);
});
