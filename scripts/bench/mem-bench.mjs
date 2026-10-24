/**
 * RAM sampler for comparing the Electron and Tauri builds (macOS only).
 *
 * Launches the packaged binary, then every `--interval` seconds sums the
 * `phys_footprint` (what Activity Monitor shows as "Memory") of the whole
 * process tree. WKWebView's WebContent / Networking / GPU processes are not
 * children of the Tauri binary, so any WebKit process that appeared after
 * launch is counted too — close Safari and other WebKit apps before running.
 *
 * Usage:
 *   node scripts/bench/mem-bench.mjs --target electron|tauri --label s0-run1 \
 *     --duration 300 [--interval 2] [--out <dir>] [--keep-alive]
 *
 * Writes <out>/<label>.csv (one row per sample, one column per process role)
 * and prints a summary line. Without --keep-alive the app is killed at the end.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const TARGETS = {
  electron: "release/mac-arm64/Usage-Pulse.app/Contents/MacOS/Usage-Pulse",
  tauri: "src-tauri/target/release/usage-pulse",
};

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((arg, index, all) =>
    arg.startsWith("--") ? [[arg.slice(2), all[index + 1]?.startsWith("--") || all[index + 1] === undefined ? "true" : all[index + 1]]] : []
  )
);

const target = args.target;
if (!TARGETS[target]) {
  console.error("--target must be electron or tauri");
  process.exit(1);
}
const label = args.label ?? `${target}-${Date.now()}`;
const duration = Number(args.duration ?? 300);
const interval = Number(args.interval ?? 2);
const outDir = resolve(args.out ?? "bench-results");
mkdirSync(outDir, { recursive: true });

const processTable = () =>
  execFileSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map(([, pid, ppid, comm]) => ({ pid: Number(pid), ppid: Number(ppid), comm }));

const isWebKit = (comm) => /com\.apple\.WebKit\.(WebContent|Networking|GPU)/.test(comm);
const baselineWebKit = new Set(processTable().filter((p) => isWebKit(p.comm)).map((p) => p.pid));

const child = spawn(resolve(args.bin ?? TARGETS[target]), [], { stdio: "ignore", detached: false });
child.on("error", (error) => {
  console.error(`launch failed: ${error.message}`);
  process.exit(1);
});

// Clicks the app's menu-bar item (toggles the popover) with a real mouse click:
// Tauri's tray ignores the synthetic AXPress. The item's position comes from
// System Events; --click-bin is a tiny CGEvent helper (x y args). Needs the
// terminal to have the Accessibility permission.
const clickTray = () =>
  new Promise((done) => {
    const script = `tell application "System Events" to tell (first process whose unix id is ${child.pid}) to get {position, size} of menu bar item 1 of menu bar 2`;
    let out = "";
    const osa = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    osa.stdout.on("data", (chunk) => (out += chunk));
    osa.on("close", () => {
      const [x, y, w, h] = out.split(",").map((n) => Number(n.trim()));
      if ([x, y, w, h].some(Number.isNaN)) return done();
      spawn(args["click-bin"], [String(Math.round(x + w / 2)), String(Math.round(y + h / 2))], { stdio: "ignore" }).on("close", done);
    });
  });

// --scenario s1: open the popover after a 30 s warm-up and leave it open.
// --scenario s2: after warm-up, open/close the popover 50 times, then idle so the
//   60 s idle close (and the memory it should give back) shows up in the samples.
// Anything else (s0, s3): no interaction, idle sampling only.
const driveScenario = async () => {
  const pause = (ms) => new Promise((done) => setTimeout(done, ms));
  await pause(30_000);
  if (args.scenario === "s1") {
    await clickTray();
  } else if (args.scenario === "s2") {
    for (let i = 0; i < 50; i += 1) {
      await clickTray();
      await pause(1500);
      await clickTray();
      await pause(1000);
    }
  }
};
if (args.scenario === "s1" || args.scenario === "s2") void driveScenario();

const treeOf = (rootPid) => {
  const table = processTable();
  const members = new Map();
  const walk = (pid) => {
    for (const p of table) {
      if (p.ppid === pid && !members.has(p.pid)) {
        members.set(p.pid, p);
        walk(p.pid);
      }
    }
  };
  const root = table.find((p) => p.pid === rootPid);
  if (root) members.set(root.pid, root);
  walk(rootPid);
  for (const p of table) {
    if (isWebKit(p.comm) && !baselineWebKit.has(p.pid)) members.set(p.pid, p);
  }
  return [...members.values()];
};

const roleOf = (comm, isRoot) => {
  if (isRoot) return "main";
  if (/WebKit\.WebContent/.test(comm)) return "webcontent";
  if (/WebKit\.Networking/.test(comm)) return "network";
  if (/WebKit\.GPU/.test(comm)) return "gpu";
  if (/Renderer/.test(comm)) return "renderer";
  if (/\(GPU\)/.test(comm)) return "gpu";
  if (/Helper/.test(comm)) return "helper";
  return "other";
};

const footprints = (pids) => {
  const jsonFile = join(tmpdir(), `mem-bench-${process.pid}.json`);
  try {
    execFileSync("footprint", ["-j", jsonFile, ...pids.flatMap((pid) => ["-p", String(pid)])], { stdio: "ignore" });
  } catch {
    // footprint exits non-zero when a pid vanished mid-sample; the JSON is still written.
  }
  try {
    const data = JSON.parse(readFileSync(jsonFile, "utf8"));
    return new Map(data.processes.map((p) => [p.pid, p.footprint]));
  } catch {
    return new Map();
  } finally {
    rmSync(jsonFile, { force: true });
  }
};

const ROLES = ["main", "renderer", "webcontent", "network", "gpu", "helper", "other"];
const csv = join(outDir, `${label}.csv`);
writeFileSync(csv, ["elapsed_s", "total_mb", "procs", ...ROLES.map((r) => `${r}_mb`)].join(",") + "\n");

const MB = 1024 * 1024;
const totals = [];
const started = Date.now();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

while ((Date.now() - started) / 1000 < duration) {
  await sleep(interval * 1000);
  const members = treeOf(child.pid);
  if (!members.some((p) => p.pid === child.pid)) {
    console.error("app exited before the run finished");
    break;
  }
  const sizes = footprints(members.map((p) => p.pid));
  const perRole = Object.fromEntries(ROLES.map((r) => [r, 0]));
  let total = 0;
  for (const p of members) {
    const bytes = sizes.get(p.pid) ?? 0;
    perRole[roleOf(p.comm, p.pid === child.pid)] += bytes;
    total += bytes;
  }
  totals.push(total / MB);
  const elapsed = ((Date.now() - started) / 1000).toFixed(0);
  appendFileSync(
    csv,
    [elapsed, (total / MB).toFixed(1), members.length, ...ROLES.map((r) => (perRole[r] / MB).toFixed(1))].join(",") + "\n"
  );
}

if (args["keep-alive"] !== "true") child.kill("SIGTERM");
else child.unref();

totals.sort((a, b) => a - b);
const median = totals.length ? totals[Math.floor(totals.length / 2)] : 0;
console.log(
  `${label}: samples=${totals.length} median=${median.toFixed(1)}MB min=${(totals[0] ?? 0).toFixed(1)}MB max=${(totals.at(-1) ?? 0).toFixed(1)}MB csv=${csv}`
);
