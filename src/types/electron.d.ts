import type {
  AlarmPopupPayload,
  AlarmStatusReport,
  AppSettings,
  AuthStatus,
  CombinedSnapshot,
  CredentialStatus,
  ManualCredentialContext,
  ManualTokenResult,
  ServiceType
} from "@shared/types";

interface UsagePulseApi {
  getSettings: () => Promise<AppSettings>;
  saveSettings: (settings: Partial<AppSettings>) => Promise<AppSettings>;
  getAuthStatus: () => Promise<AuthStatus>;
  checkAuth: (service: ServiceType) => Promise<CredentialStatus>;
  getLatestSnapshot: () => Promise<CombinedSnapshot | null>;
  openManualCredential: (service: ServiceType) => Promise<void>;
  requestManualCredentialContext: () => Promise<ManualCredentialContext | null>;
  submitManualToken: (token: string) => Promise<ManualTokenResult>;
  dismissManualCredential: () => Promise<void>;
  clearManualCredential: (service: ServiceType) => Promise<void>;
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
