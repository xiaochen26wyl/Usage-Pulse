import type {
  AlarmPopupPayload,
  AlarmStatusReport,
  AppSettings,
  AuthStatus,
  CombinedSnapshot,
  CredentialStatus,
  ManualQuotaResult,
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
  submitManualToken: (token: string) => Promise<ManualTokenResult>;
  runManualCheck: (service: ServiceType) => Promise<ManualQuotaResult>;
  sendClaudeLoginInput: (data: string) => void;
  resizeClaudeLoginPty: (cols: number, rows: number) => void;
  onClaudeLoginData: (handler: (chunk: string) => void) => () => void;
  onClaudeLoginExit: (handler: (exitCode: number) => void) => () => void;
  onSetupTokenSpawnError: (handler: (message: string) => void) => () => void;
  getLatestSnapshot: () => Promise<CombinedSnapshot | null>;
  sendLineTest: () => Promise<boolean>;
  sendLineStatus: () => Promise<boolean>;
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
  isSecretStorageAvailable: () => Promise<boolean>;
  clearClipboard: () => Promise<void>;
  copyToClipboard: (text: string) => Promise<void>;
  getAlarmStatus: () => Promise<AlarmStatusReport>;
  rearmAlarm: () => Promise<AlarmStatusReport>;
  testAlarmPopup: () => Promise<void>;
  requestAlarmPayload: () => Promise<AlarmPopupPayload | null>;
  dismissAlarm: () => Promise<void>;
  snoozeAlarm: () => Promise<void>;
  fitAlarmSize: (height: number) => Promise<void>;
  onAlarmPayload: (handler: (payload: AlarmPopupPayload) => void) => () => void;
  onAuthUpdated: (handler: (status: AuthStatus) => void) => () => void;
  onSnapshotUpdated: (handler: (snapshot: CombinedSnapshot) => void) => () => void;
}

declare global {
  interface Window {
    usagePulse: UsagePulseApi;
  }
}

export {};
