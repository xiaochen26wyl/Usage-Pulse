/**
 * Writes the two update manifests a release needs, from the installers the
 * build jobs produced.
 *
 *  - latest.json: what tauri-plugin-updater (the Tauri build) reads. One entry
 *    per platform, each with the installer's URL and its `.sig` signature.
 *  - latest.yml: what electron-updater (every 2.x install) reads. Those installs
 *    keep looking for it after the switch, so it points at the Windows installer
 *    of this release and lets them step over to the Tauri build.
 *
 * Usage:
 *   node scripts/build-update-manifests.mjs --dir dist-artifacts --version 3.0.0 \
 *     --repo owner/name --notes release-notes-body.md --out dist-artifacts
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((arg, index, all) => (arg.startsWith("--") ? [[arg.slice(2), all[index + 1]]] : []))
);
const required = ["dir", "version", "repo"];
for (const key of required) {
  if (!args[key]) {
    console.error(`--${key} is required`);
    process.exit(1);
  }
}
const dir = resolve(args.dir);
const outDir = resolve(args.out ?? args.dir);
const { version, repo } = args;

const walk = async (root) => {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => (entry.isDirectory() ? walk(join(root, entry.name)) : [join(root, entry.name)]))
  );
  return nested.flat();
};

const files = await walk(dir);
const find = (suffix, mustInclude = []) =>
  files.find((path) => path.endsWith(suffix) && mustInclude.every((part) => basename(path).includes(part)));
const downloadUrl = (path) => `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(basename(path))}`;

// Tauri's platform keys: <os>-<arch>. Only entries whose installer and signature
// both exist are written, so a partial build never publishes a dangling URL.
const platforms = {};
const addPlatform = async (key, installer) => {
  if (!installer) {
    return;
  }
  const signaturePath = `${installer}.sig`;
  if (!files.includes(signaturePath)) {
    return;
  }
  platforms[key] = { signature: (await readFile(signaturePath, "utf-8")).trim(), url: downloadUrl(installer) };
};

const windowsInstaller = find("-setup.exe", ["x64"]);
await addPlatform("windows-x86_64", windowsInstaller);
await addPlatform("darwin-aarch64", find(".app.tar.gz", ["aarch64"]));
await addPlatform("darwin-x86_64", find(".app.tar.gz", ["x64"]));

const notes = args.notes ? (await readFile(resolve(args.notes), "utf-8")).trim() : "";
const pubDate = new Date().toISOString();

await writeFile(join(outDir, "latest.json"), `${JSON.stringify({ version, notes, pub_date: pubDate, platforms }, null, 2)}\n`);

if (windowsInstaller) {
  const bytes = await readFile(windowsInstaller);
  const sha512 = createHash("sha512").update(bytes).digest("base64");
  const name = basename(windowsInstaller);
  const size = (await stat(windowsInstaller)).size;
  const yml = [
    `version: ${version}`,
    "files:",
    `  - url: ${encodeURIComponent(name)}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${encodeURIComponent(name)}`,
    `sha512: ${sha512}`,
    `releaseDate: '${pubDate}'`,
    ""
  ].join("\n");
  await writeFile(join(outDir, "latest.yml"), yml);
}

console.log(`Wrote latest.json (${Object.keys(platforms).join(", ") || "no platforms"})${windowsInstaller ? " and latest.yml" : ""}`);
