import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(".");

// Runs one of the repo's guard scripts against a throwaway project tree.
const runGuard = (script: string, files: Record<string, string>): number | null => {
  const dir = mkdtempSync(join(tmpdir(), "usage-pulse-guard-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      const full = join(dir, path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    }
    return spawnSync(process.execPath, [join(repo, "scripts", script)], { cwd: dir, stdio: "ignore" }).status;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("check-readonly passes for read-only collector code", () => {
  assert.equal(runGuard("check-readonly.mjs", { "src-tauri/src/collectors/ok.rs": "fn read() { let _ = std::fs::read(\"x\"); }" }), 0);
});

test("check-readonly fails when collector code writes", () => {
  assert.equal(runGuard("check-readonly.mjs", { "src-tauri/src/collectors/bad.rs": "fn w() { std::fs::write(\"x\", \"y\").ok(); }" }), 1);
});

test("check-readonly fails when other code touching IDE files writes", () => {
  const source = "fn w() { let _ = \"state.vscdb\"; std::fs::remove_file(\"x\").ok(); }";
  assert.equal(runGuard("check-readonly.mjs", { "src-tauri/src/elsewhere.rs": source }), 1);
});

test("smoke-build passes with both renderer entry points and fails without them", () => {
  const entries = { "dist/renderer-tauri/index.html": "", "dist/renderer-tauri/alarm.html": "" };
  assert.equal(runGuard("smoke-build.mjs", entries), 0);
  assert.equal(runGuard("smoke-build.mjs", { "dist/renderer-tauri/index.html": "" }), 1);
  assert.equal(runGuard("smoke-build.mjs", {}), 1);
});
