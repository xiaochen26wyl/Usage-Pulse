// Workaround for https://github.com/nodejs/node/issues/63487 (Node 24.16+/26.1+):
// extract-zip silently exits 0 after an incomplete extraction, leaving
// node_modules/electron without path.txt / dist/version. Delete this once
// the upstream Node.js regression is fixed and extract-zip is unaffected.
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
    execFileSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${distDir}' -Force`
    ]);
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

  if (isInstalled(distDir, pathTxtPath, versionFilePath, platformPath, version)) return;

  console.log(
    "Detected an incomplete Electron install (Node 24.16+/26.1+ extract-zip regression, see https://github.com/nodejs/node/issues/63487). Repairing..."
  );

  const zipPath = findCachedZip(version);
  if (!zipPath) {
    console.error(
      `Could not find a cached Electron v${version} zip to repair from. Run "pnpm install" again, or delete node_modules/electron and reinstall.`
    );
    process.exit(1);
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
