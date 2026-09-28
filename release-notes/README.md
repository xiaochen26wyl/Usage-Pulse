# Release notes

Before tagging a release (see `doc/Guide.md`'s "Releasing (tag)" section), add a
file here named `<version>.json` (matching `package.json`'s `version`, no `v`
prefix), for example `release-notes/2.0.4.json`:

```json
{
  "zh": "...",
  "en": "...",
  "ja": "...",
  "ko": "..."
}
```

All four languages are required — `scripts/build-release-notes.mjs` (run by
`.github/workflows/release.yml`) fails the release build if any is missing or
empty. Keep each entry short (a few lines): it becomes both the GitHub Release
body and the in-app update notification's content, read straight from this
file by the running app in the user's current UI language — not the
auto-generated GitHub Release text.
