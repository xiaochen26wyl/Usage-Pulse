import type { TrayValueColorMode } from "./types";

export const TRAY_VALUE_COLOR_WHITE = "#FFFFFF";
// Same near-black as LINE bubble body text — readable on a light menu bar.
export const TRAY_VALUE_COLOR_BLACK = "#1F2328";

// Menu-bar service labels stay brand-coloured regardless of trayValueColorMode.
// Mirror src/renderer/styles.css --color-cursor / --color-claude. Do not use
// SERVICE_ACCENT.cursor (#1F2328): that near-black is for LINE's white bubbles
// and would vanish on a dark menu bar.
export const TRAY_CURSOR_LABEL_COLOR = "#c084fc";
export const TRAY_CLAUDE_LABEL_COLOR = "#E8945A";

export const resolveTrayValueColor = (
  mode: TrayValueColorMode,
  shouldUseDarkColors: boolean
): string => {
  if (mode === "white") {
    return TRAY_VALUE_COLOR_WHITE;
  }
  if (mode === "black") {
    return TRAY_VALUE_COLOR_BLACK;
  }
  return shouldUseDarkColors ? TRAY_VALUE_COLOR_WHITE : TRAY_VALUE_COLOR_BLACK;
};
