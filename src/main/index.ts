import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { app, clipboard, ipcMain, Menu, powerMonitor, shell } from "electron";
import { menubar } from "menubar";
import type { AlarmStatusReport, CombinedSnapshot, QuotaSnapshot } from "@shared/types";
import { t } from "@shared/i18n";
import { alarmService } from "@main/alarm-service";
import { destroyAlarmWindow, closeAlarmPopup, getAlarmPayload, snoozeAlarmPopup } from "@main/alarm-window";
import { getAuthStatus } from "@main/auth-service";
import { MonitorEngine } from "@main/monitor-engine";
import { settingsStore } from "@main/store";
import { probeSystemAlarms, syncSystemAlarms } from "@main/system-alarm";
import { destroyTrayRenderer, initTrayRenderer, renderTrayImage } from "@main/tray-icon-renderer";

const isMac = process.platform === "darwin";
const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);
const execFileAsync = promisify(execFile);

if (process.platform === "win32") {
  app.setAppUserModelId("com.xiaochen26wyl.usagepulse");
}

// The "wake app" system alarm fires by launching this binary again. Without a
// single-instance lock that would start a second copy instead of alerting the
// one already sitting in the menu bar.
const isAlarmLaunch = (argv: string[]): boolean => argv.some((arg) => arg.startsWith("--alarm-fired="));

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const monitor = new MonitorEngine();

// Explicit icon path: menubar's own default-icon fallback resolves via a
// __dirname-relative lookup that breaks once menubar is bundled into
// dist/main/index.js by electron-vite (the path ends up pointing at
// dist/assets instead of node_modules/menubar/assets).
const trayIconPath = join(app.getAppPath(), "assets/tray/icon.png");

let trayApp = menubar({
  preloadWindow: true,
  tooltip: "Usage-Pulse",
  icon: trayIconPath,
  index: isDev
    ? process.env.ELECTRON_RENDERER_URL
    : `file://${join(app.getAppPath(), "dist/renderer/index.html")}`,
  browserWindow: {
    width: 460,
    height: 700,
    show: false,
    autoHideMenuBar: true,
    resizable: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  }
});

const valueText = (snapshot: QuotaSnapshot): string => {
  if (snapshot.unit === "usd") {
    if (snapshot.remaining === null) {
      return "?";
    }
    return `$${snapshot.remaining.toFixed(1)}`;
  }

  if (snapshot.unit === "percent") {
    const value = snapshot.remaining ?? snapshot.percent;
    if (value === null) {
      return "?";
    }
    return `${Math.round(value)}%`;
  }

  return snapshot.remaining === null ? "?" : `${snapshot.remaining}`;
};

// Once the 5-hour session window is exhausted (0%), showing "0%" is dead
// information — the countdown to the next reset is what's actually useful,
// so switch to "X.x小時" (or "xx分" under an hour) until it refills.
const sessionCountdownText = (session: QuotaSnapshot["windows"][number]): string | null => {
  if (!session.resetsAt) {
    return null;
  }
  const msRemaining = new Date(session.resetsAt).getTime() - Date.now();
  if (msRemaining <= 0) {
    return null;
  }
  const hoursRemaining = msRemaining / (60 * 60 * 1000);
  if (hoursRemaining >= 1) {
    return `${hoursRemaining.toFixed(1)}小時`;
  }
  const minutesRemaining = Math.max(1, Math.round(msRemaining / 60000));
  return `${minutesRemaining}分`;
};

// Claude Code's top-level `remaining` is the max of the 5-hour session and
// weekly windows; the tray specifically wants the 5-hour figure, so read it
// straight from the session window instead of falling back to that combined value.
const sessionValueText = (snapshot: QuotaSnapshot): string => {
  const session = snapshot.windows.find((window) => window.key === "session");
  if (session && session.remaining !== null) {
    if (Math.round(session.remaining) <= 0) {
      return sessionCountdownText(session) ?? "0%";
    }
    return `${Math.round(session.remaining)}%`;
  }
  return valueText(snapshot);
};

const trayTitleLine1 = "Cursor CC";
const trayTitleLine2 = (snapshot: CombinedSnapshot): string =>
  `${valueText(snapshot.cursor)} ${sessionValueText(snapshot.claude)}`;

const updateTrayText = async (snapshot: CombinedSnapshot): Promise<void> => {
  if (!trayApp.tray) {
    return;
  }

  const lang = settingsStore.get().language;
  const toolTipLines = [
    "Usage-Pulse",
    `Cursor: ${valueText(snapshot.cursor)}`,
    `Claude Code: ${valueText(snapshot.claude)}`,
  ];
  if (snapshot.claude.resetsAt) {
    const date = new Date(snapshot.claude.resetsAt);
    if (!Number.isNaN(date.getTime())) {
      const timeStr = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
      toolTipLines.push(t(lang, "tray.tooltip.claudeReset", { time: timeStr }));
    }
  }
  toolTipLines.push(t(lang, "tray.tooltip.updated", { time: new Date(snapshot.fetchedAt).toLocaleTimeString() }));

  if (isMac) {
    await setTrayImage(trayTitleLine1, trayTitleLine2(snapshot));
  }
  trayApp.tray.setToolTip(toolTipLines.join("\n"));
};

const setTrayImage = async (line1: string, line2: string): Promise<void> => {
  if (!trayApp.tray) {
    return;
  }
  try {
    const image = await renderTrayImage(line1, line2);
    trayApp.tray.setImage(image);
  } catch (error) {
    console.error("[Usage-Pulse] tray render failed", error);
  }
};

const applyAutoLaunch = (enabled: boolean): void => {
  app.setLoginItemSettings({
    openAtLogin: enabled
  });
};

// Built lazily on each right-click (instead of via tray.setContextMenu) so
// the menu only appears when explicitly requested. setContextMenu attaches
// the menu as the tray icon's permanent native menu on macOS, which makes
// *every* click - left or right - pop it up on top of menubar's own
// left-click-to-toggle-window behavior, leaving it stuck over the popup.
const buildTrayMenu = (): Menu =>
  Menu.buildFromTemplate([
    {
      label: t(settingsStore.get().language, "tray.menu.open"),
      click: () => trayApp.showWindow()
    },
    { type: "separator" },
    {
      label: t(settingsStore.get().language, "tray.menu.quit"),
      click: () => app.quit()
    }
  ]);

const setupIpcHandlers = (): void => {
  ipcMain.handle("settings:get", () => settingsStore.get());
  ipcMain.handle("settings:save", (_event, patch) => {
    const next = settingsStore.update(patch);
    applyAutoLaunch(next.launchAtLogin);
    monitor.reschedule();
    syncSystemAlarms(next, alarmService.nextTarget()).catch((error) => {
      console.error("[Usage-Pulse] failed to sync system alarms", error);
    });
    const latest = monitor.getLatestSnapshot();
    if (latest) {
      updateTrayText(latest);
    }
    return next;
  });

  ipcMain.handle("auth:status", () => getAuthStatus());

  ipcMain.handle("monitor:get-latest", () => monitor.getLatestSnapshot());
  ipcMain.handle("app:quit", () => {
    app.quit();
  });
  ipcMain.handle("app:open-external", (_event, url: string) => {
    if (typeof url === "string" && /^https:\/\//.test(url)) {
      return shell.openExternal(url);
    }
  });
  ipcMain.handle("app:open-clock", async () => {
    if (!isMac) {
      throw new Error("app:open-clock is macOS-only");
    }
    await execFileAsync("open", ["-a", "Clock"]);
  });
  ipcMain.handle("app:clear-clipboard", () => {
    clipboard.clear();
  });
  ipcMain.handle("app:open-shortcuts", async () => {
    if (!isMac) {
      throw new Error("app:open-shortcuts is macOS-only");
    }
    await execFileAsync("open", ["-a", "Shortcuts"]);
  });

  ipcMain.handle("alarm:get-status", async (): Promise<AlarmStatusReport> => {
    const system = await probeSystemAlarms(settingsStore.get());
    return alarmService.getReport(system);
  });
  ipcMain.handle("alarm:rearm", async (): Promise<AlarmStatusReport> => {
    alarmService.rearm("manual");
    const system = await syncSystemAlarms(settingsStore.get(), alarmService.nextTarget());
    return alarmService.getReport(system);
  });
  ipcMain.handle("alarm:test-popup", () => {
    alarmService.showTestPopup();
  });
  ipcMain.handle("alarm:request-payload", () => getAlarmPayload());
  ipcMain.handle("alarm:dismiss", () => {
    closeAlarmPopup();
  });
  ipcMain.handle("alarm:snooze", () => {
    snoozeAlarmPopup();
  });
};

app.whenReady().then(async () => {
  const settings = settingsStore.get();
  applyAutoLaunch(settings.launchAtLogin);
  setupIpcHandlers();

  monitor.on("snapshot", (snapshot: CombinedSnapshot) => {
    updateTrayText(snapshot);
    if (trayApp.window && !trayApp.window.isDestroyed()) {
      trayApp.window.webContents.send("snapshot:updated", snapshot);
    }
  });

  monitor.on("error", (error: Error) => {
    console.error("[Usage-Pulse]", error.message);
  });

  // Chromium timers do not advance while the machine sleeps, so a timer armed
  // before a sleep comes back late — or, for an alarm already past, not at all.
  // Re-arming on wake is what lets the catch-up window replay it.
  powerMonitor.on("resume", () => alarmService.rearm("resume"));
  powerMonitor.on("unlock-screen", () => alarmService.rearm("unlock"));

  app.on("second-instance", (_event, argv) => {
    if (isAlarmLaunch(argv)) {
      alarmService.rearm("manual");
      return;
    }
    trayApp.showWindow();
  });

  trayApp.on("ready", async () => {
    trayApp.tray?.on("right-click", () => {
      trayApp.tray?.popUpContextMenu(buildTrayMenu());
    });

    if (isMac) {
      await initTrayRenderer(trayIconPath);
    }

    const latest = monitor.getLatestSnapshot();
    if (latest) {
      await updateTrayText(latest);
    } else if (trayApp.tray) {
      const lang = settingsStore.get().language;
      trayApp.tray.setToolTip(t(lang, "tray.tooltip.noData"));
      if (isMac) {
        await setTrayImage(trayTitleLine1, "? ?");
      }
    }

    // Before the refresh, not after: a successful check moves resetsAt forward
    // to the next cycle, which would erase the very firing we need to catch up.
    alarmService.rearm("startup");
    if (isAlarmLaunch(process.argv)) {
      console.log("[Usage-Pulse] launched by a system alarm");
    }

    await monitor.runCheck("startup").catch((error) => {
      console.error("[Usage-Pulse] startup check failed", error);
    });
    monitor.start();
  });
});

app.on("before-quit", () => {
  monitor.stop();
  destroyAlarmWindow();
  destroyTrayRenderer();
});

app.on("window-all-closed", () => {});
