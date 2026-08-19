import type {
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
  onSnapshotUpdated: (handler: (snapshot: CombinedSnapshot) => void) => () => void;
}

declare global {
  interface Window {
    usagePulse: UsagePulseApi;
  }
}

export {};
