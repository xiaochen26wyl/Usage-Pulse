import { contextBridge, ipcRenderer } from "electron";
import type { AlarmPopupPayload, AlarmStatusReport, AppSettings, CombinedSnapshot } from "@shared/types";

const api = {
  getSettings: () => ipcRenderer.invoke("settings:get") as Promise<AppSettings>,
  saveSettings: (settings: Partial<AppSettings>) =>
    ipcRenderer.invoke("settings:save", settings) as Promise<AppSettings>,
  getAuthStatus: () => ipcRenderer.invoke("auth:status") as Promise<{ cursor: boolean; claude: boolean }>,
  getLatestSnapshot: () => ipcRenderer.invoke("monitor:get-latest") as Promise<CombinedSnapshot | null>,
  quitApp: () => ipcRenderer.invoke("app:quit") as Promise<void>,
  openExternal: (url: string) => ipcRenderer.invoke("app:open-external", url) as Promise<void>,
  openClockApp: () => ipcRenderer.invoke("app:open-clock") as Promise<void>,
  clearClipboard: () => ipcRenderer.invoke("app:clear-clipboard") as Promise<void>,
  openShortcutsApp: () => ipcRenderer.invoke("app:open-shortcuts") as Promise<void>,
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
  onSnapshotUpdated: (handler: (snapshot: CombinedSnapshot) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: CombinedSnapshot) => handler(snapshot);
    ipcRenderer.on("snapshot:updated", listener);
    return () => {
      ipcRenderer.removeListener("snapshot:updated", listener);
    };
  }
};

contextBridge.exposeInMainWorld("usagePulse", api);
