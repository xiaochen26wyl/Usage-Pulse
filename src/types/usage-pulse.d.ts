import type {
  AlarmPopupPayload,
  AlarmStatusReport,
  AppSettings,
  AuthStatus,
  ClaudeTokenSaveResult,
  CombinedSnapshot,
  CredentialStatus,
  HistoryCleanResult,
  HistoryService,
  HistoryStats,
  ManualQuotaResult,
  ServiceType,
  UpdateCheckResult,
  UpdateDownloadProgress,
  UpdateInfo
} from "@shared/types";

interface UsagePulseApi {
  platform: NodeJS.Platform;
  getSettings: () => Promise<AppSettings>;
  saveSettings: (settings: Partial<AppSettings>) => Promise<AppSettings>;
  getAuthStatus: () => Promise<AuthStatus>;
  checkAuth: (service: ServiceType) => Promise<CredentialStatus>;
  runManualCheck: (service: ServiceType) => Promise<ManualQuotaResult>;
  getLatestSnapshot: () => Promise<CombinedSnapshot | null>;
  saveClaudeToken: (token: string) => Promise<ClaudeTokenSaveResult>;
  clearClaudeToken: () => Promise<ClaudeTokenSaveResult>;
  sendLineTest: () => Promise<boolean>;
  sendLineStatus: () => Promise<boolean>;
  quitApp: () => Promise<void>;
  getHistoryStats: () => Promise<Record<HistoryService, HistoryStats>>;
  cleanHistory: (service: HistoryService) => Promise<HistoryCleanResult>;
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
  checkForUpdates: () => Promise<UpdateCheckResult>;
  startUpdateDownload: () => Promise<void>;
  quitAndInstallUpdate: () => Promise<void>;
  onUpdateAvailable: (handler: (info: UpdateInfo) => void) => () => void;
  onUpdateDownloadProgress: (handler: (progress: UpdateDownloadProgress) => void) => () => void;
  onUpdateDownloaded: (handler: () => void) => () => void;
}

declare global {
  interface Window {
    usagePulse: UsagePulseApi;
  }
}

export {};
