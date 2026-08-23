import type { TrayValueColorMode } from "./types";

export const TRAY_VALUE_COLOR_WHITE = "#FFFFFF";
// Same near-black as LINE bubble body text — readable on a light menu bar.
export const TRAY_VALUE_COLOR_BLACK = "#1F2328";

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
