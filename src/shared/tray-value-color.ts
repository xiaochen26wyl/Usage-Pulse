// The menu-bar image draws its own dark background (the popover's panel grey), so
// the main figure is always white. Every colour below was checked against it at
// 4.5:1 or better (the red warning at 4.0:1).
export const TRAY_BACKGROUND_COLOR = "#181D25";
export const TRAY_VALUE_COLOR = "#FFFFFF";

// Menu-bar service labels stay brand-coloured. Mirror src/renderer/styles.css
// --color-cursor / --color-claude / --color-codex. Do not use SERVICE_ACCENT.cursor
// (#1F2328): that near-black is for LINE's white bubbles and would vanish on the
// dark menu-bar background.
export const TRAY_CURSOR_LABEL_COLOR = "#c084fc";
export const TRAY_CLAUDE_LABEL_COLOR = "#E8945A";
export const TRAY_CODEX_LABEL_COLOR = "#3F87F7";

// The second menu-bar figure (weekly remaining; Cursor's advanced models) is one
// colour for every service, and turns red once 5% or less is left.
export const TRAY_WEEKLY_COLOR = "#FACC15";
export const TRAY_WEEKLY_LOW_COLOR = "#FF5A5A";
export const TRAY_WEEKLY_LOW_THRESHOLD_PERCENT = 5;
