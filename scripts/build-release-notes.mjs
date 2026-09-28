import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();

// Order mirrors CHANGELOG.md's existing English-first convention.
const LANG_HEADINGS = {
  en: "English",
  zh: "繁體中文",
  ja: "日本語",
  ko: "한국어"
};

const main = async () => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf-8"));
  const version = pkg.version;
  const notesPath = join(root, "release-notes", `${version}.json`);

  let notes;
  try {
    notes = JSON.parse(await readFile(notesPath, "utf-8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Missing or unreadable release-notes/${version}.json: ${message}`);
    console.error(`Write a four-language summary for this release before tagging — see release-notes/README.md.`);
    process.exit(1);
  }

  const missing = Object.keys(LANG_HEADINGS).filter((lang) => !notes[lang] || !String(notes[lang]).trim());
  if (missing.length > 0) {
    console.error(`release-notes/${version}.json is missing content for: ${missing.join(", ")}`);
    process.exit(1);
  }

  const sections = Object.entries(LANG_HEADINGS).map(
    ([lang, heading]) => `## ${heading}\n\n${String(notes[lang]).trim()}`
  );
  process.stdout.write(`${sections.join("\n\n---\n\n")}\n`);
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`build-release-notes error: ${message}`);
  process.exit(1);
});
