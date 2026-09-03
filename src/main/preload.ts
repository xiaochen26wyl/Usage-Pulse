import { contextBridge, ipcRenderer } from "electron";
import type {
  AlarmPopupPayload,
  AlarmStatusReport,
  AppSettings,
  AuthStatus,
  ClaudeTokenSaveResult,
  CombinedSnapshot,
  CredentialStatus,
  ManualQuotaResult,
  SessionStats,
  ServiceType,
  WaterCupSizeMl
} from "@shared/types";

const api = {
  getSettings: () => ipcRenderer.invoke("settings:get") as Promise<AppSettings>,
  saveSettings: (settings: Partial<AppSettings>) =>
    ipcRenderer.invoke("settings:save", settings) as Promise<AppSettings>,
  getAuthStatus: () => ipcRenderer.invoke("auth:status") as Promise<AuthStatus>,
  checkAuth: (service: ServiceType) => ipcRenderer.invoke("auth:check", service) as Promise<CredentialStatus>,
  runManualCheck: (service: ServiceType) =>
    ipcRenderer.invoke("monitor:run-manual", service) as Promise<ManualQuotaResult>,
  getLatestSnapshot: () => ipcRenderer.invoke("monitor:get-latest") as Promise<CombinedSnapshot | null>,
  // One-way: the token goes to main, is verified against the usage API there,
  // and only a localized outcome comes back. It is never handed out again.
  saveClaudeToken: (token: string) =>
    ipcRenderer.invoke("claude:save-token", token) as Promise<ClaudeTokenSaveResult>,
  clearClaudeToken: () => ipcRenderer.invoke("claude:clear-token") as Promise<ClaudeTokenSaveResult>,
  sendLineTest: () => ipcRenderer.invoke("line:send-test") as Promise<boolean>,
  sendLineStatus: () => ipcRenderer.invoke("line:send-status") as Promise<boolean>,
  quitApp: () => ipcRenderer.invoke("app:quit") as Promise<void>,
  getSessionStats: () => ipcRenderer.invoke("session:get-stats") as Promise<SessionStats>,
  logWaterCup: (sizeMl?: WaterCupSizeMl) =>
    ipcRenderer.invoke("session:log-cup", sizeMl) as Promise<SessionStats>,
  drinkWater: () => ipcRenderer.invoke("water:drink") as Promise<SessionStats>,
  skipWater: () => ipcRenderer.invoke("water:skip") as Promise<void>,
  continueSession: () => ipcRenderer.invoke("session:continue") as Promise<void>,
  confirmQuit: () => ipcRenderer.invoke("session:confirm-quit") as Promise<void>,
  requestSessionStats: () => ipcRenderer.invoke("session:request-stats") as Promise<SessionStats | null>,
  onSessionStatsUpdated: (handler: (stats: SessionStats) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, stats: SessionStats) => handler(stats);
    ipcRenderer.on("session:stats", listener);
    return () => {
      ipcRenderer.removeListener("session:stats", listener);
    };
  },
  openExternal: (url: string) => ipcRenderer.invoke("app:open-external", url) as Promise<void>,
  clearClipboard: () => ipcRenderer.invoke("app:clear-clipboard") as Promise<void>,
  isSecretStorageAvailable: () =>
    ipcRenderer.invoke("app:secret-storage-available") as Promise<boolean>,
  copyToClipboard: (text: string) => ipcRenderer.invoke("app:copy-to-clipboard", text) as Promise<void>,
  getAlarmStatus: () => ipcRenderer.invoke("alarm:get-status") as Promise<AlarmStatusReport>,
  rearmAlarm: () => ipcRenderer.invoke("alarm:rearm") as Promise<AlarmStatusReport>,
  testAlarmPopup: () => ipcRenderer.invoke("alarm:test-popup") as Promise<void>,
  requestAlarmPayload: () => ipcRenderer.invoke("alarm:request-payload") as Promise<AlarmPopupPayload | null>,
  dismissAlarm: () => ipcRenderer.invoke("alarm:dismiss") as Promise<void>,
  snoozeAlarm: () => ipcRenderer.invoke("alarm:snooze") as Promise<void>,
  fitAlarmSize: (height: number) => ipcRenderer.invoke("alarm:fit-size", height) as Promise<void>,
  onAlarmPayload: (handler: (payload: AlarmPopupPayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AlarmPopupPayload) => handler(payload);
    ipcRenderer.on("alarm:payload", listener);
    return () => {
      ipcRenderer.removeListener("alarm:payload", listener);
    };
  },
  onAuthUpdated: (handler: (status: AuthStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: AuthStatus) => handler(status);
    ipcRenderer.on("auth:updated", listener);
    return () => {
      ipcRenderer.removeListener("auth:updated", listener);
    };
  },
  onSnapshotUpdated: (handler: (snapshot: CombinedSnapshot) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: CombinedSnapshot) => handler(snapshot);
    ipcRenderer.on("snapshot:updated", listener);
    return () => {
      ipcRenderer.removeListener("snapshot:updated", listener);
    };
  },
};

contextBridge.exposeInMainWorld("usagePulse", api);
