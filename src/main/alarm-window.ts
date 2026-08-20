import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import type { AlarmPopupPayload } from "@shared/types";

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);

const SNOOZE_MS = 5 * 60_000;

let popup: BrowserWindow | null = null;
let currentPayload: AlarmPopupPayload | null = null;
let autoDismissTimer: NodeJS.Timeout | null = null;
let snoozeTimer: NodeJS.Timeout | null = null;

const alarmUrl = (): string =>
  isDev
    ? `${process.env.ELECTRON_RENDERER_URL}/alarm.html`
    : `file://${join(app.getAppPath(), "dist/renderer/alarm.html")}`;

const clearAutoDismiss = (): void => {
  if (autoDismissTimer) {
    clearTimeout(autoDismissTimer);
    autoDismissTimer = null;
  }
};

const armAutoDismiss = (minutes: number): void => {
  clearAutoDismiss();
  autoDismissTimer = setTimeout(() => closeAlarmPopup(), Math.max(1, minutes) * 60_000);
};

const createPopup = (): BrowserWindow => {
  // Deliberately a window of its own rather than the menubar popover: that one
  // hides itself on blur, which is exactly the wrong behaviour for an alarm.
  const window = new BrowserWindow({
    width: 380,
    height: 240,
    resizable: false,
    frame: false,
    show: false,
    skipTaskbar: false,
    fullscreenable: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // The alarm chime is synthesised on load with no click to authorise it,
      // so the default autoplay gate has to be lifted for this window.
      autoplayPolicy: "no-user-gesture-required"
    }
  });

  window.setAlwaysOnTop(true, "screen-saver");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  window.on("closed", () => {
    popup = null;
  });

  window.webContents.on("did-finish-load", () => {
    if (currentPayload) {
      window.webContents.send("alarm:payload", currentPayload);
    }
  });

  void window.loadURL(alarmUrl());
  return window;
};

export const showAlarmPopup = (payload: AlarmPopupPayload): void => {
  currentPayload = payload;

  if (snoozeTimer) {
    clearTimeout(snoozeTimer);
    snoozeTimer = null;
  }

  if (!popup || popup.isDestroyed()) {
    popup = createPopup();
  } else {
    popup.webContents.send("alarm:payload", payload);
  }

  popup.setAlwaysOnTop(true, "screen-saver");
  // showInactive, not show: the window must be impossible to miss without
  // stealing the keystroke the user is in the middle of typing elsewhere.
  popup.showInactive();
  armAutoDismiss(payload.autoDismissMinutes);
};

export const getAlarmPayload = (): AlarmPopupPayload | null => currentPayload;

export const closeAlarmPopup = (): void => {
  clearAutoDismiss();
  if (popup && !popup.isDestroyed()) {
    popup.close();
  }
  popup = null;
};

export const snoozeAlarmPopup = (): void => {
  const payload = currentPayload;
  closeAlarmPopup();
  if (!payload) {
    return;
  }

  if (snoozeTimer) {
    clearTimeout(snoozeTimer);
  }
  snoozeTimer = setTimeout(() => {
    snoozeTimer = null;
    showAlarmPopup(payload);
  }, SNOOZE_MS);
};

export const destroyAlarmWindow = (): void => {
  if (snoozeTimer) {
    clearTimeout(snoozeTimer);
    snoozeTimer = null;
  }
  closeAlarmPopup();
  currentPayload = null;
};
