import type {
  AppSettings,
  AuthStatus,
  CombinedSnapshot,
  MonitorResult,
  ServiceType
} from "@shared/types";

interface UsagePulseApi {
  getSettings: () => Promise<AppSettings>;
  saveSettings: (settings: Partial<AppSettings>) => Promise<AppSettings>;
  getAuthStatus: () => Promise<AuthStatus>;
  openLoginWindow: (service: ServiceType) => Promise<void>;
  saveLoginSession: (service: ServiceType) => Promise<boolean>;
  clearLoginSession: (service: ServiceType) => Promise<boolean>;
  runManualCheck: () => Promise<MonitorResult>;
  getLatestSnapshot: () => Promise<CombinedSnapshot | null>;
  onSnapshotUpdated: (handler: (snapshot: CombinedSnapshot) => void) => () => void;
}

declare global {
  interface Window {
    usagePulse: UsagePulseApi;
  }
}

export {};
