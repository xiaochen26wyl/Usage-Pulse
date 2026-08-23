import { join } from "node:path";
import { app, BrowserWindow, screen } from "electron";
import type { AlarmPopupPayload } from "@shared/types";
import { ALARM_POPUP_AUTO_DISMISS_MINUTES } from "@shared/alarm-utils";

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);

const SNOOZE_MS = 5 * 60_000;
const WINDOW_WIDTH = 380;
const WINDOW_HEIGHT = 240;
const EDGE_MARGIN = 16;

// Always the primary display's top-right corner, recomputed on every show so a
// resolution or monitor-arrangement change since the last popup doesn't leave
// the window parked off-screen or in the wrong place.
const topRightPosition = (): { x: number; y: number } => {
  const workArea = screen.getPrimaryDisplay().workArea;
  return {
    x: workArea.x + workArea.width - WINDOW_WIDTH - EDGE_MARGIN,
    y: workArea.y + EDGE_MARGIN
  };
};

let popup: BrowserWindow | null = null;
let currentPayload: AlarmPopupPayload | null = null;
let autoDismissTimer: NodeJS.Timeout | null = null;
let snoozeTimer: NodeJS.Timeout | null = null;
// Each low-quota alert (and each reset alarm) fires its own popup independently
// rather than clobbering whichever one is already on screen — anything that
// arrives while a popup is showing waits here and is shown once it closes.
const queue: AlarmPopupPayload[] = [];
const closeListeners = new Set<(payload: AlarmPopupPayload) => void>();

export const onAlarmPopupClosed = (listener: (payload: AlarmPopupPayload) => void): (() => void) => {
  closeListeners.add(listener);
  return () => {
    closeListeners.delete(listener);
  };
};

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

const armAutoDismiss = (): void => {
  clearAutoDismiss();
  autoDismissTimer = setTimeout(() => closeAlarmPopup(), ALARM_POPUP_AUTO_DISMISS_MINUTES * 60_000);
};

const createPopup = (): BrowserWindow => {
  const { x, y } = topRightPosition();

  // Deliberately a window of its own rather than the menubar popover: that one
  // hides itself on blur, which is exactly the wrong behaviour for an alarm.
  const window = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x,
    y,
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

const displayPopup = (payload: AlarmPopupPayload): void => {
  currentPayload = payload;

  if (!popup || popup.isDestroyed()) {
    popup = createPopup();
  } else {
    popup.webContents.send("alarm:payload", payload);
    const { x, y } = topRightPosition();
    popup.setPosition(x, y);
  }

  popup.setAlwaysOnTop(true, "screen-saver");
  // showInactive, not show: the window must be impossible to miss without
  // stealing the keystroke the user is in the middle of typing elsewhere.
  popup.showInactive();
  armAutoDismiss();
};

export const showAlarmPopup = (payload: AlarmPopupPayload): void => {
  if (snoozeTimer) {
    clearTimeout(snoozeTimer);
    snoozeTimer = null;
  }

  if (currentPayload && popup && !popup.isDestroyed()) {
    queue.push(payload);
    return;
  }

  displayPopup(payload);
};

export const getAlarmPayload = (): AlarmPopupPayload | null => currentPayload;

export const closeAlarmPopup = (): void => {
  const closed = currentPayload;
  clearAutoDismiss();
  currentPayload = null;
  if (popup && !popup.isDestroyed()) {
    popup.close();
  }
  popup = null;

  if (closed) {
    for (const listener of closeListeners) {
      listener(closed);
    }
  }

  const next = queue.shift();
  if (next) {
    displayPopup(next);
  }
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
  queue.length = 0;
  closeAlarmPopup();
  currentPayload = null;
};
