import { contextBridge, ipcRenderer } from "electron";
import type { AppSettings, CombinedSnapshot, MonitorResult } from "@shared/types";

const api = {
  getSettings: () => ipcRenderer.invoke("settings:get") as Promise<AppSettings>,
  saveSettings: (settings: Partial<AppSettings>) =>
    ipcRenderer.invoke("settings:save", settings) as Promise<AppSettings>,
  getAuthStatus: () => ipcRenderer.invoke("auth:status") as Promise<{ cursor: boolean; claude: boolean }>,
  runManualCheck: () => ipcRenderer.invoke("monitor:run-manual") as Promise<MonitorResult>,
  getLatestSnapshot: () => ipcRenderer.invoke("monitor:get-latest") as Promise<CombinedSnapshot | null>,
  getAlarmSyncStatus: () => ipcRenderer.invoke("alarm:status") as Promise<string>,
  onSnapshotUpdated: (handler: (snapshot: CombinedSnapshot) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: CombinedSnapshot) => handler(snapshot);
    ipcRenderer.on("snapshot:updated", listener);
    return () => {
      ipcRenderer.removeListener("snapshot:updated", listener);
    };
  }
};

contextBridge.exposeInMainWorld("usagePulse", api);
