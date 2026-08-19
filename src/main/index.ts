import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { app, ipcMain, Menu, nativeTheme, shell } from "electron";
import { menubar } from "menubar";
import type { CombinedSnapshot, QuotaSnapshot } from "@shared/types";
import { t } from "@shared/i18n";
import { getAuthStatus } from "@main/auth-service";
import { MonitorEngine } from "@main/monitor-engine";
import { settingsStore } from "@main/store";
import { destroyTrayRenderer, initTrayRenderer, renderTrayImage } from "@main/tray-icon-renderer";

const isMac = process.platform === "darwin";
const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);
const execFileAsync = promisify(execFile);

if (process.platform === "win32") {
  app.setAppUserModelId("com.zorawl.usagepulse");
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

// Claude Code's top-level `remaining` is the max of the 5-hour session and
// weekly windows; the tray specifically wants the 5-hour figure, so read it
// straight from the session window instead of falling back to that combined value.
const sessionValueText = (snapshot: QuotaSnapshot): string => {
  const session = snapshot.windows.find((window) => window.key === "session");
  if (session && session.remaining !== null) {
    return `${Math.round(session.remaining)}%`;
  }
  return valueText(snapshot);
};

const trayTitleLine1 = "Cursor  CC";
const trayTitleLine2 = (snapshot: CombinedSnapshot): string =>
  `${valueText(snapshot.cursor)}  ${sessionValueText(snapshot.claude)}`;

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
    const image = await renderTrayImage(line1, line2, nativeTheme.shouldUseDarkColors);
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
        await setTrayImage(trayTitleLine1, "?  ?");
      }
    }

    nativeTheme.on("updated", () => {
      const latestSnapshot = monitor.getLatestSnapshot();
      if (isMac && latestSnapshot) {
        setTrayImage(trayTitleLine1, trayTitleLine2(latestSnapshot));
      }
    });

    await monitor.runCheck("startup").catch((error) => {
      console.error("[Usage-Pulse] startup check failed", error);
    });
    monitor.start();
  });
});

app.on("before-quit", () => {
  monitor.stop();
  destroyTrayRenderer();
});

app.on("window-all-closed", () => {});
