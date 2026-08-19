import { contextBridge, ipcRenderer } from "electron";
import type { AppSettings, CombinedSnapshot } from "@shared/types";

const api = {
  getSettings: () => ipcRenderer.invoke("settings:get") as Promise<AppSettings>,
  saveSettings: (settings: Partial<AppSettings>) =>
    ipcRenderer.invoke("settings:save", settings) as Promise<AppSettings>,
  getAuthStatus: () => ipcRenderer.invoke("auth:status") as Promise<{ cursor: boolean; claude: boolean }>,
  getLatestSnapshot: () => ipcRenderer.invoke("monitor:get-latest") as Promise<CombinedSnapshot | null>,
  quitApp: () => ipcRenderer.invoke("app:quit") as Promise<void>,
  openExternal: (url: string) => ipcRenderer.invoke("app:open-external", url) as Promise<void>,
  openClockApp: () => ipcRenderer.invoke("app:open-clock") as Promise<void>,
  onSnapshotUpdated: (handler: (snapshot: CombinedSnapshot) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: CombinedSnapshot) => handler(snapshot);
    ipcRenderer.on("snapshot:updated", listener);
    return () => {
      ipcRenderer.removeListener("snapshot:updated", listener);
    };
  }
};

contextBridge.exposeInMainWorld("usagePulse", api);
