// Gives the renderer the same `window.usagePulse` the Electron preload builds,
// on top of Tauri's invoke / listen. Under Electron the preload has already
// defined it, so this file does nothing there.
//
// Every request goes through one Rust command, `ipc_invoke`, keyed by the same
// `domain:action` channel names Electron uses, so the two shells stay
// comparable channel for channel (see doc/Tauri_Migration_Inventory.md §6).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type Api = Window["usagePulse"];

const call = <T>(channel: string, arg?: unknown): Promise<T> =>
  invoke<T>("ipc_invoke", { channel, arg: arg ?? null });

// listen() is async but the renderer expects a synchronous unsubscribe, so an
// unsubscribe that arrives before the listener is registered cancels it.
const subscribe = <T>(event: string, handler: (payload: T) => void): (() => void) => {
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  void listen<T>(event, (message) => handler(message.payload)).then((off) => {
    if (cancelled) {
      off();
    } else {
      unlisten = off;
    }
  });
  return () => {
    cancelled = true;
    unlisten?.();
  };
};

// The OS never changes while the app runs, and the renderer reads this
// synchronously on first render, so derive it from the user agent.
const detectPlatform = (): Api["platform"] => {
  const agent = navigator.userAgent;
  if (agent.includes("Mac")) {
    return "darwin";
  }
  if (agent.includes("Windows")) {
    return "win32";
  }
  return "linux";
};

const createApi = (): Api => ({
  platform: detectPlatform(),
  getSettings: () => call("settings:get"),
  saveSettings: (settings) => call("settings:save", settings),
  getAuthStatus: () => call("auth:status"),
  checkAuth: (service) => call("auth:check", service),
  runManualCheck: (service) => call("monitor:run-manual", service),
  getLatestSnapshot: () => call("monitor:get-latest"),
  saveClaudeToken: (token) => call("claude:save-token", token),
  clearClaudeToken: () => call("claude:clear-token"),
  sendLineTest: () => call("line:send-test"),
  sendLineStatus: () => call("line:send-status"),
  quitApp: () => call("app:quit"),
  getHistoryStats: () => call("history:get-stats"),
  cleanHistory: (service) => call("history:clean", service),
  openExternal: (url) => call("app:open-external", url),
  clearClipboard: () => call("app:clear-clipboard"),
  isSecretStorageAvailable: () => call("app:secret-storage-available"),
  copyToClipboard: (text) => call("app:copy-to-clipboard", text),
  getAlarmStatus: () => call("alarm:get-status"),
  rearmAlarm: () => call("alarm:rearm"),
  testAlarmPopup: () => call("alarm:test-popup"),
  requestAlarmPayload: () => call("alarm:request-payload"),
  dismissAlarm: () => call("alarm:dismiss"),
  snoozeAlarm: () => call("alarm:snooze"),
  fitAlarmSize: (height) => call("alarm:fit-size", height),
  onAlarmPayload: (handler) => subscribe("alarm:payload", handler),
  onAuthUpdated: (handler) => subscribe("auth:updated", handler),
  onSnapshotUpdated: (handler) => subscribe("snapshot:updated", handler),
  checkForUpdates: () => call("update:check"),
  startUpdateDownload: () => call("update:download"),
  quitAndInstallUpdate: () => call("update:install"),
  onUpdateAvailable: (handler) => subscribe("update:available", handler),
  onUpdateDownloadProgress: (handler) => subscribe("update:download-progress", handler),
  onUpdateDownloaded: (handler) => subscribe("update:downloaded", () => handler())
});

if (!window.usagePulse && "__TAURI_INTERNALS__" in window) {
  window.usagePulse = createApi();
}
