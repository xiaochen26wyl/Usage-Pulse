# Usage-Pulse

**English** | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Usage-Pulse is a cross-platform desktop menu bar tool that monitors Cursor, Claude Code, and Codex quotas, sending notifications when quota changes, runs low, or resets.

It only reads credentials you're already logged in with locally and official usage data — it never writes back to any IDE's credential or config files.

## Installation

### Download

Grab the latest build from the [Releases page](https://github.com/xiaochen26wyl/Usage-Pulse/releases):

- Apple Silicon (M1/M2/M3...): `Usage-Pulse-<version>-arm64.dmg`
- Intel Mac: `Usage-Pulse-<version>.dmg` (or the x64-labeled file)
- Windows x64: `Usage-Pulse.Setup.<version>.exe`

### Run from source

Usage-Pulse is open source — you can clone the repository, read the code yourself, and run it directly.

Requires [Node.js](https://nodejs.org/) 24 and pnpm 9.15.9 (run `corepack enable` once and pnpm picks the right version automatically).

```bash
git clone https://github.com/xiaochen26wyl/Usage-Pulse.git
cd Usage-Pulse
pnpm install
pnpm dev
```

`pnpm dev` starts the app in development mode; the menu bar icon works the same as the installed version, and the logins listed in **Before first use** are still required.

A fresh clone already checks out and tracks the `main` branch. Since every release is published as a tag off `main`, run `git pull` before rebuilding to pick up the changes behind each new release.

### Unsigned build warnings

- macOS Gatekeeper: on first launch, right-click the app in Finder -> `Open` -> click `Open` again.
- Windows SmartScreen: if a protection prompt appears, choose `More info` -> `Run anyway`.

### Before first use

- Log in to **Cursor Desktop** first (required for Cursor quota reads).
- Install the **standalone Claude Code CLI** and log in with it first.
- Log in to the **Codex CLI** or **Codex Desktop** first (Usage-Pulse does not open a Codex login UI).
- Allow system notification permissions when prompted.

> Usage-Pulse does not read the Claude Desktop app's internal (encrypted) session. Even if you only use Claude through the Claude Desktop app day to day, you still need a Claude Code login saved via the official CLI.

### Claude Code credential setup

Click **Update Values** in Usage-Pulse to detect the credential and fetch usage. Whenever the Claude card has no numbers to show, it opens a panel on the spot with the exact login command to run and a box you can paste a token into instead.

A pasted token is tried against your real usage before it is kept: if it can't read your usage, it isn't saved and the panel tells you why.

> Why the numbers can look different from Claude Desktop's own "Plan usage limits" panel: Usage-Pulse shows **remaining** quota, while Claude Desktop's panel shows **used** quota. `44%` remaining and `56%` used describe the same state — not a data error.

## Behavior

1. Checks Cursor / Claude Code / Codex quota periodically in the background and alerts you on changes.
2. Low-quota and quota-reset alerts can each be toggled independently, per service and per window, in Settings.
3. Two notification channels, each toggled independently in Settings: an in-app popup (no OS permission needed, always works — top-right, auto-closes after 30 seconds) and LINE notifications (needs a Channel Access Token).
4. Available in Traditional Chinese, English, Japanese, and Korean from the in-app language menu.
5. Quit anytime from the UI or the tray menu; if LINE is on, quitting sends a final status from the last cached reading.

## Security notes

- What's read, all read-only: Cursor's local session file, the official Claude Code CLI's saved login, and Codex's local auth file.
- Usage-Pulse never writes to or modifies any of these files or credentials.
- General settings (notification toggles, language, and the rest of Settings) are stored locally only — there's no cloud sync.

If anything appears incorrect — such as a reading that seems wrong, a notification that should not have been triggered, or any other unexpected behavior — please open a question in [Discussions Q&A](https://github.com/xiaochen26wyl/Usage-Pulse/discussions/categories/q-a-%E8%A7%A3%E6%B1%BA%E5%95%8F%E9%A1%8C) instead of making assumptions.

## License and important notice

Usage-Pulse uses an **MIT-style license with a non-commercial default** (full terms in [`LICENSE`](LICENSE)). **Personal use and use within a company for the company's own internal purposes are both free.** Since it's provided free for company use, please have your company assess the security risk on its own before adopting it.

**Only download Usage-Pulse from this repository's official GitHub Releases page.** Builds from any other source are not published by the original developer, and their handling of your credentials cannot be trusted.

## Support

If Usage-Pulse has been helpful to you, please consider starring the project on GitHub ⭐ — it's free, quick, and greatly appreciated. You can also support the project via [GitHub Sponsors](https://github.com/sponsors/xiaochen26wyl).

## Follow Developer

- Instagram (English): [@xiaochen26wyl](https://www.instagram.com/xiaochen26wyl/)
- Threads (中文): [@xiaochen26wyl](https://www.threads.com/@xiaochen26wyl)

W.Y. LI — [LinkedIn](https://www.linkedin.com/in/wenyu-li-1a9868bb/) (commercial licensing & buyout)
