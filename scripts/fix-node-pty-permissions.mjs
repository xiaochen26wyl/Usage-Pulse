// node-pty ships its prebuilt macOS/Linux helper binaries (prebuilds/<platform-arch>/spawn-helper)
// without the executable bit set — pnpm's tarball extraction does not preserve it. Without this,
// pty.spawn() fails immediately with "posix_spawnp failed". Windows has no equivalent permission
// bit, so this is a no-op there.
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const prebuildsDir = join(process.cwd(), "node_modules", "node-pty", "prebuilds");

if (!existsSync(prebuildsDir)) {
  process.exit(0);
}

let fixed = 0;
for (const platformArchDir of readdirSync(prebuildsDir)) {
  const helperPath = join(prebuildsDir, platformArchDir, "spawn-helper");
  if (!existsSync(helperPath)) {
    continue;
  }
  const mode = statSync(helperPath).mode;
  // 0o111 = any executable bit already set for owner/group/other.
  if ((mode & 0o111) !== 0) {
    continue;
  }
  chmodSync(helperPath, mode | 0o755);
  fixed += 1;
}

if (fixed > 0) {
  console.log(`Fixed executable permission on ${fixed} node-pty spawn-helper binar${fixed === 1 ? "y" : "ies"}.`);
}
