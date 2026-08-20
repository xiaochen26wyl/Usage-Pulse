import type {
  AlarmPopupPayload,
  AlarmStatusReport,
  AppSettings,
  AuthStatus,
  CombinedSnapshot
} from "@shared/types";

interface UsagePulseApi {
  getSettings: () => Promise<AppSettings>;
  saveSettings: (settings: Partial<AppSettings>) => Promise<AppSettings>;
  getAuthStatus: () => Promise<AuthStatus>;
  getLatestSnapshot: () => Promise<CombinedSnapshot | null>;
  quitApp: () => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  openClockApp: () => Promise<void>;
  clearClipboard: () => Promise<void>;
  openShortcutsApp: () => Promise<void>;
  getAlarmStatus: () => Promise<AlarmStatusReport>;
  rearmAlarm: () => Promise<AlarmStatusReport>;
  testAlarmPopup: () => Promise<void>;
  requestAlarmPayload: () => Promise<AlarmPopupPayload | null>;
  dismissAlarm: () => Promise<void>;
  snoozeAlarm: () => Promise<void>;
  onAlarmPayload: (handler: (payload: AlarmPopupPayload) => void) => () => void;
  onSnapshotUpdated: (handler: (snapshot: CombinedSnapshot) => void) => () => void;
}

declare global {
  interface Window {
    usagePulse: UsagePulseApi;
  }
}

export {};
