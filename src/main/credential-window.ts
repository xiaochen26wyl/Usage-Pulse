import { join } from "node:path";
import { app, BrowserWindow, screen } from "electron";
import type { ManualCredentialContext } from "@shared/types";

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);

const WINDOW_WIDTH = 460;
const WINDOW_HEIGHT = 420;

/**
 * The window that walks a user through pasting a Claude Code token by hand.
 *
 * Deliberately not the alarm popup. That one is frameless, always-on-top,
 * shown with showInactive() so it never takes focus, and closes itself after a
 * minute — every one of which is wrong for a window you are meant to paste a
 * long string into. This one takes focus, sits still until it is answered, and
 * only ever exists as a single instance.
 */
let window: BrowserWindow | null = null;
let context: ManualCredentialContext | null = null;

const centeredPosition = (): { x: number; y: number } => {
  const workArea = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(workArea.x + (workArea.width - WINDOW_WIDTH) / 2),
    y: Math.round(workArea.y + (workArea.height - WINDOW_HEIGHT) / 2)
  };
};

const credentialUrl = (): string =>
  isDev
    ? `${process.env.ELECTRON_RENDERER_URL}/credential.html`
    : `file://${join(app.getAppPath(), "dist/renderer/credential.html")}`;

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
    context = null;
  });

  created.webContents.on("did-finish-load", () => {
    if (context) {
      created.webContents.send("credential:manual-context", context);
    }
  });

  void created.loadURL(credentialUrl());
  return created;
};

export const showManualCredentialWindow = (next: ManualCredentialContext): void => {
  context = next;

  if (!window || window.isDestroyed()) {
    window = createWindow();
    window.once("ready-to-show", () => {
      window?.show();
      window?.focus();
    });
    return;
  }

  window.webContents.send("credential:manual-context", context);
  window.show();
  window.focus();
};

export const getManualCredentialContext = (): ManualCredentialContext | null => context;

export const closeManualCredentialWindow = (): void => {
  if (window && !window.isDestroyed()) {
    window.close();
  }
  window = null;
  context = null;
};
