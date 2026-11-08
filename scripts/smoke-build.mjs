import { access } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
// The renderer bundle `tauri build` embeds (see vite.tauri.config.ts). The Rust half
// is compiled and tested by the `rust` CI job, so this only guards the web half.
const requiredFiles = ["dist/renderer-tauri/index.html", "dist/renderer-tauri/alarm.html"];

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
