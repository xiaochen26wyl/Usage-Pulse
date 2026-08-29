import { app } from "electron";

// Electron's setLoginItemSettings targets the app's own unnamed default login
// item on both macOS and Windows, so this needs no platform branching — unlike
// ide-launch-helper.ts, which installs a separate named watcher.
export const applyAppLoginItem = (enabled: boolean): void => {
  // Electron cannot register the Vite development process as a login item.
  // Treat it as a no-op so startup auth checks are not buried under a native
  // Operation not permitted warning.
  if (!app.isPackaged) {
    return;
  }
  if (!enabled) {
    app.setLoginItemSettings({ openAtLogin: false });
    return;
  }
  app.setLoginItemSettings({ openAtLogin: true });
};
