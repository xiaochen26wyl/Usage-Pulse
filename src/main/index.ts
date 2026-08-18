import { join } from "node:path";
import { app, ipcMain, Menu } from "electron";
import { menubar } from "menubar";
import type { CombinedSnapshot, QuotaSnapshot } from "@shared/types";
import { t } from "@shared/i18n";
import { getAuthStatus } from "@main/auth-service";
import { MonitorEngine } from "@main/monitor-engine";
import { settingsStore } from "@main/store";

const isMac = process.platform === "darwin";
const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);

if (process.platform === "win32") {
  app.setAppUserModelId("com.zorawl.usagepulse");
}

const monitor = new MonitorEngine();

let trayApp = menubar({
  preloadWindow: true,
  tooltip: "Usage-Pulse",
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

const updateTrayText = (snapshot: CombinedSnapshot): void => {
  if (!trayApp.tray) {
    return;
  }

  const lang = settingsStore.get().language;
  const title = `C:${valueText(snapshot.cursor)} A:${valueText(snapshot.claude)}`;
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
    trayApp.tray.setTitle(title);
  }
  trayApp.tray.setToolTip(toolTipLines.join("\n"));
};

const applyAutoLaunch = (enabled: boolean): void => {
  app.setLoginItemSettings({
    openAtLogin: enabled
  });
};

const buildTrayMenu = (): void => {
  if (!trayApp.tray) {
    return;
  }
  const lang = settingsStore.get().language;
  trayApp.tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: t(lang, "tray.menu.open"),
        click: () => trayApp.showWindow()
      },
      { type: "separator" },
      {
        label: t(lang, "tray.menu.quit"),
        click: () => app.quit()
      }
    ])
  );
};

const setupIpcHandlers = (): void => {
  ipcMain.handle("settings:get", () => settingsStore.get());
  ipcMain.handle("settings:save", (_event, patch) => {
    const next = settingsStore.update(patch);
    applyAutoLaunch(next.launchAtLogin);
    monitor.reschedule();
    buildTrayMenu();
    const latest = monitor.getLatestSnapshot();
    if (latest) {
      updateTrayText(latest);
    }
    return next;
  });

  ipcMain.handle("auth:status", () => getAuthStatus());

  ipcMain.handle("monitor:run-manual", async () => {
    return monitor.runCheck("manual");
  });
  ipcMain.handle("monitor:get-latest", () => monitor.getLatestSnapshot());
  ipcMain.handle("app:quit", () => {
    app.quit();
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

  trayApp.on("ready", async () => {
    buildTrayMenu();

    const latest = monitor.getLatestSnapshot();
    if (latest) {
      updateTrayText(latest);
    } else if (trayApp.tray) {
      const lang = settingsStore.get().language;
      trayApp.tray.setToolTip(t(lang, "tray.tooltip.noData"));
      if (isMac) {
        trayApp.tray.setTitle("C:? A:?");
      }
    }

    await monitor.runCheck("startup").catch((error) => {
      console.error("[Usage-Pulse] startup check failed", error);
    });
    monitor.start();
  });
});

app.on("before-quit", () => {
  monitor.stop();
});

app.on("window-all-closed", () => {});
