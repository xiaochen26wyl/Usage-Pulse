import type {
  AlarmPopupPayload,
  AlarmStatusReport,
  AppSettings,
  AuthStatus,
  CombinedSnapshot,
  CredentialStatus,
  ManualCredentialContext,
  ManualTokenResult,
  SessionStats,
  ServiceType,
  WaterCupSizeMl
} from "@shared/types";

interface UsagePulseApi {
  getSettings: () => Promise<AppSettings>;
  saveSettings: (settings: Partial<AppSettings>) => Promise<AppSettings>;
  getAuthStatus: () => Promise<AuthStatus>;
  checkAuth: (service: ServiceType) => Promise<CredentialStatus>;
  runSetupToken: () => Promise<ManualTokenResult>;
  getLatestSnapshot: () => Promise<CombinedSnapshot | null>;
  openManualCredential: (service: ServiceType) => Promise<void>;
  requestManualCredentialContext: () => Promise<ManualCredentialContext | null>;
  submitManualToken: (token: string) => Promise<ManualTokenResult>;
  dismissManualCredential: () => Promise<void>;
  clearManualCredential: (service: ServiceType) => Promise<void>;
  quitApp: () => Promise<void>;
  getSessionStats: () => Promise<SessionStats>;
  logWaterCup: (sizeMl?: WaterCupSizeMl) => Promise<SessionStats>;
  drinkWater: () => Promise<SessionStats>;
  skipWater: () => Promise<void>;
  continueSession: () => Promise<void>;
  confirmQuit: () => Promise<void>;
  requestSessionStats: () => Promise<SessionStats | null>;
  onSessionStatsUpdated: (handler: (stats: SessionStats) => void) => () => void;
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
  onManualCredentialContext: (handler: (context: ManualCredentialContext) => void) => () => void;
  onAuthUpdated: (handler: (status: AuthStatus) => void) => () => void;
  onSnapshotUpdated: (handler: (snapshot: CombinedSnapshot) => void) => () => void;
}

declare global {
  interface Window {
    usagePulse: UsagePulseApi;
  }
}

export {};
