import { EventEmitter } from "node:events";
import axios from "axios";
import { autoUpdater } from "electron-updater";
import type { UpdateCheckResult, UpdateInfo } from "@shared/types";
import { settingsStore } from "@main/store";
import { redact } from "@main/log-redaction";

// Auto-update is Windows-only for now: the app is unsigned on macOS, and
// Squirrel.Mac's silent install cannot be relied on without a signature (see
// doc/Guide.md). Every method below is a no-op on any other platform, so
// nothing here ever touches electron-updater outside win32.
const isSupported = process.platform === "win32";

const PERIODIC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Release notes are not the (English-only, auto-generated) GitHub Release
// body — they come from that tag's own release-notes/<version>.json, fetched
// straight from raw.githubusercontent.com so what the app shows always
// matches the exact tag it is offering to install.
const releaseNotesUrl = (version: string): string =>
  `https://raw.githubusercontent.com/xiaochen26wyl/Usage-Pulse/v${version}/release-notes/${version}.json`;

const fetchReleaseNotes = async (version: string): Promise<string> => {
  try {
    const response = await axios.get<Record<string, string>>(releaseNotesUrl(version), { timeout: 10_000 });
    const lang = settingsStore.get().language;
    return response.data[lang] || response.data.en || "";
  } catch (error) {
    console.error("[Usage-Pulse] failed to fetch release notes", redact(error));
    return "";
  }
};

/**
 * Thin wrapper around electron-updater, Windows-only (see isSupported above).
 *
 * Every check — startup, periodic, or the manual tray-menu item — goes
 * through checkNow(), which both resolves with the outcome for its own caller
 * and emits "available" / "download-progress" / "downloaded" so index.ts can
 * push the same event to the renderer regardless of what triggered it.
 */
class UpdateChecker extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private wired = false;
  private checking = false;

  private wireEvents(): void {
    if (this.wired) {
      return;
    }
    this.wired = true;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.logger = {
      info: (message?: unknown) => console.log("[Usage-Pulse] updater:", message),
      warn: (message?: unknown) => console.warn("[Usage-Pulse] updater:", message),
      error: (message?: unknown) => console.error("[Usage-Pulse] updater:", message),
      debug: () => {}
    };

    autoUpdater.on("download-progress", (progress) => {
      this.emit("download-progress", { percent: Math.round(progress.percent) });
    });

    autoUpdater.on("update-downloaded", () => {
      this.emit("downloaded");
    });
  }

  async checkNow(): Promise<UpdateCheckResult> {
    if (!isSupported) {
      return { status: "unsupported" };
    }
    // At most one in-flight check: a periodic tick landing mid-manual-check
    // would otherwise race the same autoUpdater singleton.
    if (this.checking) {
      return { status: "checking" };
    }
    this.checking = true;
    this.wireEvents();

    try {
      const result = await new Promise<UpdateCheckResult>((resolve) => {
        const cleanup = () => {
          autoUpdater.removeListener("update-available", onAvailable);
          autoUpdater.removeListener("update-not-available", onNotAvailable);
          autoUpdater.removeListener("error", onError);
        };
        const onAvailable = (info: { version: string }) => {
          cleanup();
          void fetchReleaseNotes(info.version).then((releaseNotes) => {
            const updateInfo: UpdateInfo = {
              version: info.version,
              releaseNotes,
              releaseUrl: `https://github.com/xiaochen26wyl/Usage-Pulse/releases/tag/v${info.version}`
            };
            this.emit("available", updateInfo);
            resolve({ status: "available", info: updateInfo });
          });
        };
        const onNotAvailable = () => {
          cleanup();
          resolve({ status: "not-available" });
        };
        const onError = (error: Error) => {
          cleanup();
          resolve({ status: "error", message: String(error) });
        };
        autoUpdater.once("update-available", onAvailable);
        autoUpdater.once("update-not-available", onNotAvailable);
        autoUpdater.once("error", onError);
        autoUpdater.checkForUpdates().catch((error: Error) => {
          cleanup();
          resolve({ status: "error", message: String(error) });
        });
      });
      return result;
    } finally {
      this.checking = false;
    }
  }

  async startDownload(): Promise<void> {
    if (!isSupported) {
      return;
    }
    await autoUpdater.downloadUpdate();
  }

  quitAndInstall(): void {
    if (!isSupported) {
      return;
    }
    autoUpdater.quitAndInstall();
  }

  start(): void {
    this.reschedule();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  reschedule(): void {
    this.stop();
    if (!isSupported || !settingsStore.get().autoCheckForUpdates) {
      return;
    }
    this.timer = setInterval(() => {
      void this.checkNow();
    }, PERIODIC_CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }
}

export const updateChecker = new UpdateChecker();
