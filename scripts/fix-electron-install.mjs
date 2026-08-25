// Two problems this script works around:
//
// 1. Since Electron 42 (electron/electron#49328), the `electron` npm package no
//    longer downloads its binary via a `postinstall` script — it lazy-downloads
//    on first launch instead. `node_modules/electron/install.js` still exists and
//    still does the download+extract, it's just no longer invoked automatically.
//    We call it here ourselves so `pnpm install` keeps eagerly provisioning
//    Electron like it always has (this repo's release build needs a real binary
//    present, not a lazy download deferred to first `electron` launch).
// 2. https://github.com/nodejs/node/issues/63487 (Node 24.16+/26.1+): extract-zip
//    can silently exit 0 after an incomplete extraction, leaving
//    node_modules/electron without path.txt / dist/version. If install.js's own
//    extraction falls victim to this, we repair from the zip it already
//    downloaded into the local Electron cache. Delete this repair path once the
//    upstream Node.js regression is fixed and extract-zip is unaffected.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { arch as osArch, homedir, platform } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const electronDir = join(root, "node_modules", "electron");

const getPlatformPath = () => {
  switch (platform()) {
    case "darwin":
      return "Electron.app/Contents/MacOS/Electron";
    case "linux":
    case "freebsd":
    case "openbsd":
      return "electron";
    case "win32":
      return "electron.exe";
    default:
      throw new Error(`Electron builds are not available on platform: ${platform()}`);
  }
};

const isInstalled = (distDir, pathTxtPath, versionFilePath, platformPath, expectedVersion) => {
  try {
    const distVersion = readFileSync(versionFilePath, "utf-8").replace(/^v/, "");
    if (distVersion !== expectedVersion) return false;
    const recordedPath = readFileSync(pathTxtPath, "utf-8");
    if (recordedPath !== platformPath) return false;
  } catch {
    return false;
  }
  return existsSync(join(distDir, platformPath));
};

const resolveDownloadPlatformArch = () => {
  const plat = platform();
  let arch = osArch();

  if (plat === "darwin" && arch === "x64") {
    try {
      const output = execFileSync("sysctl", ["-in", "sysctl.proc_translated"]).toString().trim();
      if (output === "1") arch = "arm64";
    } catch {
      // not running under Rosetta, ignore
    }
  }

  return { plat, arch };
};

const getDefaultCacheDir = () => {
  if (process.env.electron_config_cache) return process.env.electron_config_cache;
  switch (platform()) {
    case "darwin":
      return join(homedir(), "Library", "Caches", "electron");
    case "win32":
      return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "electron", "Cache");
    default:
      return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "electron");
  }
};

const findCachedZip = (version) => {
  const { plat, arch } = resolveDownloadPlatformArch();
  const cacheDir = getDefaultCacheDir();
  const zipName = `electron-v${version}-${plat}-${arch}.zip`;

  const flatPath = join(cacheDir, zipName);
  if (existsSync(flatPath)) return flatPath;

  if (existsSync(cacheDir)) {
    for (const entry of readdirSync(cacheDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const nestedPath = join(cacheDir, entry.name, zipName);
      if (existsSync(nestedPath)) return nestedPath;
    }
  }

  return null;
};

const extractZip = (zipPath, distDir) => {
  if (platform() === "win32") {
    // Paths travel in the environment rather than interpolated into the command
    // string: a directory containing a single quote would otherwise break out of
    // the quoting and change what PowerShell executes.
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Expand-Archive -LiteralPath $env:UP_ZIP_PATH -DestinationPath $env:UP_DIST_DIR -Force"
      ],
      { env: { ...process.env, UP_ZIP_PATH: zipPath, UP_DIST_DIR: distDir } }
    );
  } else {
    execFileSync("unzip", ["-o", "-q", zipPath, "-d", distDir]);
  }
};

const main = async () => {
  const electronPackageJsonPath = join(electronDir, "package.json");
  if (!existsSync(electronPackageJsonPath)) return;

  const { version } = JSON.parse(readFileSync(electronPackageJsonPath, "utf-8"));
  const platformPath = getPlatformPath();
  const distDir = join(electronDir, "dist");
  const pathTxtPath = join(electronDir, "path.txt");
  const versionFilePath = join(distDir, "version");
  const installScriptPath = join(electronDir, "install.js");

  if (isInstalled(distDir, pathTxtPath, versionFilePath, platformPath, version)) return;

  // Electron >=42 no longer runs this download itself, so trigger it directly.
  // install.js is a no-op (exits 0 immediately) if it's already installed.
  if (existsSync(installScriptPath)) {
    console.log(`Downloading Electron v${version} (no longer fetched automatically since Electron 42)...`);
    try {
      execFileSync(process.execPath, [installScriptPath], { stdio: "inherit", cwd: electronDir });
    } catch (error) {
      console.warn(`Electron's own install.js failed (${error.message}); falling back to cache repair.`);
    }
  }

  if (isInstalled(distDir, pathTxtPath, versionFilePath, platformPath, version)) {
    console.log("Electron installed.");
    return;
  }

  console.log(
    "Electron dist is still missing/incomplete after install.js — checking the local Electron cache for a zip to extract (possible Node 24.16+/26.1+ extract-zip regression, see https://github.com/nodejs/node/issues/63487)..."
  );

  const zipPath = findCachedZip(version);
  if (!zipPath) {
    // Nothing was ever downloaded (e.g. no network in this environment) rather than
    // downloaded-and-corrupted — that's expected under Electron's lazy-install model,
    // not a broken install. Anything that actually needs the binary (pnpm dev,
    // electron-builder) will trigger install.js's own download on demand.
    console.warn(
      `No cached Electron v${version} zip found and install.js could not download one. Electron will lazy-download on first use if network access is available then.`
    );
    return;
  }

  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });
  extractZip(zipPath, distDir);
  await writeFile(pathTxtPath, platformPath);

  if (!isInstalled(distDir, pathTxtPath, versionFilePath, platformPath, version)) {
    console.error("Repair failed: extraction is still incomplete after using the system unzip tool.");
    process.exit(1);
  }

  console.log("Electron install repaired.");
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`fix-electron-install failed: ${message}`);
  process.exit(1);
});
