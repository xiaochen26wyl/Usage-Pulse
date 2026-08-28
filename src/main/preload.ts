import { contextBridge, ipcRenderer } from "electron";
import type {
  AlarmPopupPayload,
  AlarmStatusReport,
  AppSettings,
  AuthStatus,
  CombinedSnapshot,
  CredentialStatus,
  ManualTokenResult,
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
  runSetupToken: () => ipcRenderer.invoke("credential:run-setup-token") as Promise<ManualTokenResult>,
  submitManualToken: (token: string) =>
    ipcRenderer.invoke("credential:submit-manual-token", token) as Promise<ManualTokenResult>,
  sendClaudeLoginInput: (data: string) => ipcRenderer.send("claude-login:input", data),
  resizeClaudeLoginPty: (cols: number, rows: number) => ipcRenderer.send("claude-login:resize", { cols, rows }),
  onClaudeLoginData: (handler: (chunk: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, chunk: string) => handler(chunk);
    ipcRenderer.on("claude-login:data", listener);
    return () => {
      ipcRenderer.removeListener("claude-login:data", listener);
    };
  },
  onClaudeLoginExit: (handler: (exitCode: number) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, exitCode: number) => handler(exitCode);
    ipcRenderer.on("claude-login:exit", listener);
    return () => {
      ipcRenderer.removeListener("claude-login:exit", listener);
    };
  },
  onManualTokenCaptured: (handler: (token: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, token: string) => handler(token);
    ipcRenderer.on("credential:manual-token-captured", listener);
    return () => {
      ipcRenderer.removeListener("credential:manual-token-captured", listener);
    };
  },
  onSetupTokenSpawnError: (handler: (message: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, message: string) => handler(message);
    ipcRenderer.on("credential:setup-token-spawn-error", listener);
    return () => {
      ipcRenderer.removeListener("credential:setup-token-spawn-error", listener);
    };
  },
  getLatestSnapshot: () => ipcRenderer.invoke("monitor:get-latest") as Promise<CombinedSnapshot | null>,
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
