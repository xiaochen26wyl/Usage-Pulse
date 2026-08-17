import { contextBridge, ipcRenderer } from "electron";
import type { AppSettings, CombinedSnapshot, MonitorResult, ServiceType } from "@shared/types";

const api = {
  getSettings: () => ipcRenderer.invoke("settings:get") as Promise<AppSettings>,
  saveSettings: (settings: Partial<AppSettings>) =>
    ipcRenderer.invoke("settings:save", settings) as Promise<AppSettings>,
  getAuthStatus: () => ipcRenderer.invoke("auth:status") as Promise<{ cursor: boolean; claude: boolean }>,
  openLoginWindow: (service: ServiceType) => ipcRenderer.invoke("auth:open-login", service) as Promise<void>,
  saveLoginSession: (service: ServiceType) =>
    ipcRenderer.invoke("auth:save-session", service) as Promise<boolean>,
  clearLoginSession: (service: ServiceType) =>
    ipcRenderer.invoke("auth:clear-session", service) as Promise<boolean>,
  runManualCheck: () => ipcRenderer.invoke("monitor:run-manual") as Promise<MonitorResult>,
  getLatestSnapshot: () => ipcRenderer.invoke("monitor:get-latest") as Promise<CombinedSnapshot | null>,
  onSnapshotUpdated: (handler: (snapshot: CombinedSnapshot) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: CombinedSnapshot) => handler(snapshot);
    ipcRenderer.on("snapshot:updated", listener);
    return () => {
      ipcRenderer.removeListener("snapshot:updated", listener);
    };
  }
};

contextBridge.exposeInMainWorld("usagePulse", api);
