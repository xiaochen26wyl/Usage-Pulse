import { join } from "node:path";
import { app, BrowserWindow, screen } from "electron";
import type { AlarmPopupPayload } from "@shared/types";
import { ALARM_POPUP_AUTO_DISMISS_SECONDS } from "@shared/alarm-utils";

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
  autoDismissTimer = setTimeout(() => closeAlarmPopup(), ALARM_POPUP_AUTO_DISMISS_SECONDS * 1000);
};

const raisePopup = (window: BrowserWindow): void => {
  // `floating` stays above ordinary windows but can still become key and
  // deliver clicks. `screen-saver` intercepts the mouse without handing it to
  // Chromium, so "知道了" looks clickable and never fires.
  window.setAlwaysOnTop(true, "floating");
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    // A menubar app is a UIElementApplication. Flipping it to a regular app
    // (Electron's default here) leaves this window eating clicks forever.
    skipTransformProcessType: true
  });
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
    // Inactive-window first click must reach the dismiss button, not just
    // try (and fail) to activate a menubar accessory app.
    acceptFirstMouse: true,
    // macOS NSPanel can take mouse input without a full app activation.
    ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // The alarm chime is synthesised on load with no click to authorise it,
      // so the default autoplay gate has to be lifted for this window.
      autoplayPolicy: "no-user-gesture-required"
    }
  });

  raisePopup(window);

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

  raisePopup(popup);
  // showInactive, not show: appear without stealing the keystroke the user is
  // in the middle of typing. Water's "我喝了。" still needs the first click.
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

const destroyPopupWindow = (): void => {
  if (!popup || popup.isDestroyed()) {
    popup = null;
    return;
  }
  const window = popup;
  popup = null;
  window.hide();
  if (!window.isDestroyed()) {
    window.destroy();
  }
};

export const closeAlarmPopup = (): void => {
  const closed = currentPayload;
  clearAutoDismiss();
  currentPayload = null;
  destroyPopupWindow();

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

export const fitAlarmWindowSize = (height: number): void => {
  if (!popup || popup.isDestroyed()) {
    return;
  }
  popup.setContentSize(WINDOW_WIDTH, height);
  const { x, y } = topRightPosition();
  popup.setPosition(x, y);
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
