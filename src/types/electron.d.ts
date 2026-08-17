import type {
  AppSettings,
  AuthStatus,
  CombinedSnapshot,
  MonitorResult
} from "@shared/types";

interface UsagePulseApi {
  getSettings: () => Promise<AppSettings>;
  saveSettings: (settings: Partial<AppSettings>) => Promise<AppSettings>;
  getAuthStatus: () => Promise<AuthStatus>;
  runManualCheck: () => Promise<MonitorResult>;
  getLatestSnapshot: () => Promise<CombinedSnapshot | null>;
  quitApp: () => Promise<void>;
  onSnapshotUpdated: (handler: (snapshot: CombinedSnapshot) => void) => () => void;
}

declare global {
  interface Window {
    usagePulse: UsagePulseApi;
  }
}

export {};
