import { join } from "node:path";
import { app, BrowserWindow, screen } from "electron";
import type { SessionStats } from "@shared/types";

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);

const WINDOW_WIDTH = 420;
const WINDOW_HEIGHT = 520;

let window: BrowserWindow | null = null;
let currentStats: SessionStats | null = null;

const centeredPosition = (): { x: number; y: number } => {
  const workArea = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(workArea.x + (workArea.width - WINDOW_WIDTH) / 2),
    y: Math.round(workArea.y + (workArea.height - WINDOW_HEIGHT) / 2)
  };
};

const sessionUrl = (): string =>
  isDev
    ? `${process.env.ELECTRON_RENDERER_URL}/session.html`
    : `file://${join(app.getAppPath(), "dist/renderer/session.html")}`;

const sendStats = (): void => {
  if (!window || window.isDestroyed() || !currentStats) {
    return;
  }
  window.webContents.send("session:stats", currentStats);
};

const createWindow = (): BrowserWindow => {
  const { x, y } = centeredPosition();

  const created = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x,
    y,
    resizable: false,
    show: false,
    fullscreenable: false,
    title: "Usage-Pulse",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  created.on("closed", () => {
    window = null;
    currentStats = null;
  });

  created.webContents.on("did-finish-load", () => {
    sendStats();
  });

  void created.loadURL(sessionUrl());
  return created;
};

export const showSessionSummary = (stats: SessionStats): void => {
  currentStats = stats;

  if (!window || window.isDestroyed()) {
    window = createWindow();
    window.once("ready-to-show", () => {
      window?.show();
      window?.focus();
    });
    return;
  }

  sendStats();
  window.show();
  window.focus();
};

export const closeSessionSummary = (): void => {
  currentStats = null;
  if (window && !window.isDestroyed()) {
    window.close();
  }
  window = null;
};

export const destroySessionWindow = (): void => {
  closeSessionSummary();
};
