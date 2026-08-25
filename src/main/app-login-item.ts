import { app } from "electron";

// Electron's setLoginItemSettings targets the app's own unnamed default login
// item on both macOS and Windows, so this needs no platform branching — unlike
// ide-launch-helper.ts, which installs a separate named watcher.
export const applyAppLoginItem = (enabled: boolean): void => {
  if (!enabled) {
    app.setLoginItemSettings({ openAtLogin: false });
    return;
  }
  if (!app.isPackaged) {
    return;
  }
  app.setLoginItemSettings({ openAtLogin: true });
};
