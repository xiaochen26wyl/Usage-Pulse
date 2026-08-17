import { join } from "node:path";
import { app, ipcMain } from "electron";
import { menubar } from "menubar";
import type { CombinedSnapshot } from "@shared/types";
import { clearLoginSession, getAuthStatus, openLoginWindow, saveLoginSession } from "@main/auth-service";
import { MonitorEngine } from "@main/monitor-engine";
import { settingsStore } from "@main/store";

const isMac = process.platform === "darwin";
const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);

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

const valueText = (value: number | null): string => (value === null ? "?" : `${value}`);

const updateTrayText = (snapshot: CombinedSnapshot): void => {
  if (!trayApp.tray) {
    return;
  }

  const title = `C:${valueText(snapshot.cursor.remaining)} A:${valueText(snapshot.claude.remaining)}`;
  const toolTipLines = [
    "Usage-Pulse",
    `Cursor: ${valueText(snapshot.cursor.remaining)}`,
    `Claude: ${valueText(snapshot.claude.remaining)}`,
    `更新: ${new Date(snapshot.fetchedAt).toLocaleTimeString()}`
  ];

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

const setupIpcHandlers = (): void => {
  ipcMain.handle("settings:get", () => settingsStore.get());
  ipcMain.handle("settings:save", (_event, patch) => {
    const next = settingsStore.update(patch);
    applyAutoLaunch(next.launchAtLogin);
    monitor.reschedule();
    return next;
  });

  ipcMain.handle("auth:status", () => getAuthStatus());
  ipcMain.handle("auth:open-login", (_event, service) => openLoginWindow(service));
  ipcMain.handle("auth:save-session", (_event, service) => saveLoginSession(service));
  ipcMain.handle("auth:clear-session", (_event, service) => clearLoginSession(service));

  ipcMain.handle("monitor:run-manual", async () => {
    return monitor.runCheck("manual");
  });
  ipcMain.handle("monitor:get-latest", () => monitor.getLatestSnapshot());
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
    const latest = monitor.getLatestSnapshot();
    if (latest) {
      updateTrayText(latest);
    } else if (trayApp.tray) {
      trayApp.tray.setToolTip("Usage-Pulse\n尚未抓取到配額資料");
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
