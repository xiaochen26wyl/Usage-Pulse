import type {
  AlarmPopupPayload,
  AlarmStatusReport,
  AppSettings,
  AuthStatus,
  CombinedSnapshot,
  MonitorResult
} from "@shared/types";

interface UsagePulseApi {
  getSettings: () => Promise<AppSettings>;
  saveSettings: (settings: Partial<AppSettings>) => Promise<AppSettings>;
  getAuthStatus: () => Promise<AuthStatus>;
  getLatestSnapshot: () => Promise<CombinedSnapshot | null>;
  runManualCheck: () => Promise<MonitorResult>;
  quitApp: () => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  clearClipboard: () => Promise<void>;
  copyToClipboard: (text: string) => Promise<void>;
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
