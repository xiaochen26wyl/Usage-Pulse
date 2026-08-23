import { join } from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, powerMonitor, shell } from "electron";
import { menubar } from "menubar";
import type {
  AlarmStatusReport,
  AppSettings,
  AuthStatus,
  CombinedSnapshot,
  CredentialStatus,
  ManualCredentialContext,
  ManualTokenResult,
  QuotaSnapshot,
  ScrapeResult,
  SessionStats,
  ServiceType,
  WaterCupSizeMl
} from "@shared/types";
import { CLAUDE_MANUAL_TOKEN_MASK } from "@shared/types";
import { t } from "@shared/i18n";
import { resolveTrayValueColor } from "@shared/tray-value-color";
import { alarmService } from "@main/alarm-service";
import { destroyAlarmWindow, closeAlarmPopup, getAlarmPayload, snoozeAlarmPopup } from "@main/alarm-window";
import { closeSessionSummary, destroySessionWindow, showSessionSummary } from "@main/session-window";
import { sessionTracker } from "@main/session-tracker";
import { waterReminder } from "@main/water-reminder";
import { runClaudeSetupToken, SetupTokenError } from "@main/claude-setup-token";
import { validateClaudeOAuthToken } from "@main/collectors/claude-code";
import { credentialMonitor } from "@main/credential-monitor";
import {
  peekClaudeKeychainCredential,
  setManualClaudeTokenProvider,
  writeClaudeSetupTokenToKeychain
} from "@main/credential-provider";
import { closeManualCredentialWindow, getManualCredentialContext } from "@main/credential-window";
import { applyIdeLaunchHelper } from "@main/ide-launch-helper";
import { IdePresenceMonitor, probeIdeRunning } from "@main/ide-presence";
import { MonitorEngine } from "@main/monitor-engine";
import { settingsStore, snapshotStore } from "@main/store";
import { destroyTrayRenderer, renderTrayImage } from "@main/tray-icon-renderer";

const isMac = process.platform === "darwin";
const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);

if (process.platform === "win32") {
  app.setAppUserModelId("com.xiaochen26wyl.usagepulse");
}

// The "wake app" system alarm fires by launching this binary again. Without a
// single-instance lock that would start a second copy instead of alerting the
// one already sitting in the menu bar.
const isAlarmLaunch = (argv: string[]): boolean => argv.some((arg) => arg.startsWith("--alarm-fired="));

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const monitor = new MonitorEngine();

let sessionReady = false;
let quitConfirmed = false;

const collectSessionStats = (): SessionStats =>
  sessionTracker.getStats(monitor.getLatestSnapshot() ?? snapshotStore.get(), Date.now(), waterReminder.getNextAt());

const emitSessionStats = (): void => {
  const stats = collectSessionStats();
  if (trayApp.window && !trayApp.window.isDestroyed()) {
    trayApp.window.webContents.send("session:stats", stats);
  }
};

const confirmQuit = (): void => {
  quitConfirmed = true;
  closeSessionSummary();
  app.quit();
};

const cancelQuit = (): void => {
  closeSessionSummary();
};

// Wired before anything can read a credential: the hand-entered token has to be
// visible to the provider from the very first sweep, not only after the first
// settings save.
setManualClaudeTokenProvider(() => settingsStore.get().claudeManualOAuthToken);

// Explicit icon path: menubar's own default-icon fallback resolves via a
// __dirname-relative lookup that breaks once menubar is bundled into
// dist/main/index.js by electron-vite (the path ends up pointing at
// dist/assets instead of node_modules/menubar/assets).
const trayIconPath = join(app.getAppPath(), "assets/tray/icon.png");

let trayApp = menubar({
  preloadWindow: true,
  tooltip: "Usage-Pulse",
  icon: trayIconPath,
  index: isDev
    ? process.env.ELECTRON_RENDERER_URL
    : `file://${join(app.getAppPath(), "dist/renderer/index.html")}`,
  browserWindow: {
    width: 460,
    height: 700,
    show: false,
    autoHideMenuBar: true,
    resizable: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  }
});

const valueText = (snapshot: QuotaSnapshot): string => {
  if (snapshot.unit === "usd") {
    if (snapshot.remaining === null) {
      return "?";
    }
    return `$${snapshot.remaining.toFixed(1)}`;
  }

  if (snapshot.unit === "percent") {
    const value = snapshot.remaining ?? snapshot.percent;
    if (value === null) {
      return "?";
    }
    return `${Math.round(value)}%`;
  }

  return snapshot.remaining === null ? "?" : `${snapshot.remaining}`;
};

// Once the 5-hour session window is exhausted (0%), showing "0%" is dead
// information — the countdown to the next reset is what's actually useful,
// so switch to "X.x小時" (or "xx分" under an hour) until it refills.
const sessionCountdownText = (session: QuotaSnapshot["windows"][number]): string | null => {
  if (!session.resetsAt) {
    return null;
  }
  const msRemaining = new Date(session.resetsAt).getTime() - Date.now();
  if (msRemaining <= 0) {
    return null;
  }
  const hoursRemaining = msRemaining / (60 * 60 * 1000);
  if (hoursRemaining >= 1) {
    return `${hoursRemaining.toFixed(1)}小時`;
  }
  const minutesRemaining = Math.max(1, Math.round(msRemaining / 60000));
  return `${minutesRemaining}分`;
};

// Claude Code's top-level `remaining` is the max of the 5-hour session and
// weekly windows; the tray specifically wants the 5-hour figure, so read it
// straight from the session window instead of falling back to that combined value.
const sessionValueText = (snapshot: QuotaSnapshot): string => {
  const session = snapshot.windows.find((window) => window.key === "session");
  if (session && session.remaining !== null) {
    if (Math.round(session.remaining) <= 0) {
      return sessionCountdownText(session) ?? "0%";
    }
    return `${Math.round(session.remaining)}%`;
  }
  return valueText(snapshot);
};

const trayTitleLine1 = "Cursor Claude";
const trayTitleLine2 = (snapshot: CombinedSnapshot): string =>
  `${valueText(snapshot.cursor)} ${sessionValueText(snapshot.claude)}`;

const updateTrayText = async (snapshot: CombinedSnapshot): Promise<void> => {
  if (!trayApp.tray) {
    return;
  }

  const lang = settingsStore.get().language;
  const toolTipLines = [
    "Usage-Pulse",
    `Cursor: ${valueText(snapshot.cursor)}`,
    `Claude Code: ${valueText(snapshot.claude)}`,
  ];
  if (snapshot.claude.resetsAt) {
    const date = new Date(snapshot.claude.resetsAt);
    if (!Number.isNaN(date.getTime())) {
      const timeStr = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
      toolTipLines.push(t(lang, "tray.tooltip.claudeReset", { time: timeStr }));
    }
  }
  toolTipLines.push(t(lang, "tray.tooltip.updated", { time: new Date(snapshot.fetchedAt).toLocaleTimeString() }));

  if (isMac) {
    await setTrayImage(trayTitleLine1, trayTitleLine2(snapshot));
  }
  trayApp.tray.setToolTip(toolTipLines.join("\n"));
};

const currentTrayValueColor = (): string =>
  resolveTrayValueColor(settingsStore.get().trayValueColorMode, nativeTheme.shouldUseDarkColors);

const setTrayImage = async (line1: string, line2: string): Promise<void> => {
  if (!trayApp.tray) {
    return;
  }
  try {
    const image = await renderTrayImage(line1, line2, currentTrayValueColor());
    trayApp.tray.setImage(image);
  } catch (error) {
    console.error("[Usage-Pulse] tray render failed", error);
  }
};

const refreshTrayFromLatest = async (): Promise<void> => {
  const latest = monitor.getLatestSnapshot();
  if (latest) {
    await updateTrayText(latest);
    return;
  }
  if (isMac && trayApp.tray) {
    await setTrayImage(trayTitleLine1, "? ?");
  }
};

let ideQuitPromptParent: BrowserWindow | null = null;
let ideQuitPromptCancelled = false;

const destroyIdeQuitPromptWindow = (): void => {
  if (ideQuitPromptParent && !ideQuitPromptParent.isDestroyed()) {
    ideQuitPromptParent.destroy();
  }
  ideQuitPromptParent = null;
};

const closeIdeQuitPrompt = (): void => {
  ideQuitPromptCancelled = true;
  destroyIdeQuitPromptWindow();
};

const askIdeQuitPrompt = async (): Promise<"quit" | "stay" | "cancelled"> => {
  ideQuitPromptCancelled = false;
  destroyIdeQuitPromptWindow();
  const lang = settingsStore.get().language;
  ideQuitPromptParent = new BrowserWindow({
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true
  });
  try {
    const { response } = await dialog.showMessageBox(ideQuitPromptParent, {
      type: "question",
      buttons: [t(lang, "dialog.ideClosed.quit"), t(lang, "dialog.ideClosed.stay")],
      defaultId: 1,
      cancelId: 1,
      title: t(lang, "dialog.ideClosed.title"),
      message: t(lang, "dialog.ideClosed.message")
    });
    if (ideQuitPromptCancelled) {
      return "cancelled";
    }
    return response === 0 ? "quit" : "stay";
  } catch {
    return "cancelled";
  } finally {
    destroyIdeQuitPromptWindow();
  }
};

const idePresenceMonitor = new IdePresenceMonitor({
  probe: () => probeIdeRunning(),
  ask: askIdeQuitPrompt,
  cancelAsk: closeIdeQuitPrompt,
  quit: () => app.quit()
});

const syncIdePresenceMonitor = (enabled: boolean): void => {
  if (enabled) {
    idePresenceMonitor.start();
    return;
  }
  idePresenceMonitor.stop();
};

// Built lazily on each right-click (instead of via tray.setContextMenu) so
// the menu only appears when explicitly requested. setContextMenu attaches
// the menu as the tray icon's permanent native menu on macOS, which makes
// *every* click - left or right - pop it up on top of menubar's own
// left-click-to-toggle-window behavior, leaving it stuck over the popup.
const buildTrayMenu = (): Menu =>
  Menu.buildFromTemplate([
    {
      label: t(settingsStore.get().language, "tray.menu.open"),
      click: () => trayApp.showWindow()
    },
    { type: "separator" },
    {
      label: t(settingsStore.get().language, "tray.menu.quit"),
      click: () => app.quit()
    }
  ]);

// The manual Claude Code token is the one secret a renderer never gets to see.
// It is a working credential for the usage API, and the UI only ever needs to
// know whether one is stored, so it leaves the main process as a placeholder.
const maskSecrets = (settings: AppSettings): AppSettings => ({
  ...settings,
  claudeManualOAuthToken: settings.claudeManualOAuthToken ? CLAUDE_MANUAL_TOKEN_MASK : ""
});

// ...and a patch carrying the placeholder back is a no-op, not an instruction
// to overwrite the real token with the mask.
const stripMaskedSecrets = (patch: Partial<AppSettings>): Partial<AppSettings> => {
  if (patch.claudeManualOAuthToken !== CLAUDE_MANUAL_TOKEN_MASK) {
    return patch;
  }
  const { claudeManualOAuthToken: _masked, ...rest } = patch;
  return rest;
};

const setupIpcHandlers = (): void => {
  ipcMain.handle("settings:get", () => maskSecrets(settingsStore.get()));
  ipcMain.handle("settings:save", (_event, patch: Partial<AppSettings>) => {
    const next = settingsStore.update(stripMaskedSecrets(patch));
    void applyIdeLaunchHelper(next.launchWithIde).catch((error) => {
      console.error("[Usage-Pulse] failed to apply IDE launch helper", error);
    });
    syncIdePresenceMonitor(next.launchWithIde);
    monitor.reschedule();
    waterReminder.reschedule();
    emitSessionStats();
    const latest = monitor.getLatestSnapshot();
    if (latest) {
      updateTrayText(latest);
    }
    return maskSecrets(next);
  });

  ipcMain.handle("auth:status", (): AuthStatus => credentialMonitor.getStatus());
  // Per-service on purpose: each quota card re-detects only its own credential,
  // so a failing Cursor login can be retried without touching Claude Code.
  ipcMain.handle("auth:check", (_event, service: ServiceType): Promise<CredentialStatus> =>
    credentialMonitor.check(service)
  );

  // Claude "re-detect": Keychain first. Only if that item is missing do we
  // open a terminal for `claude setup-token`, recover the printed token, and
  // write it back to the same Keychain service (plus the encrypted app store).
  ipcMain.handle("credential:run-setup-token", async (): Promise<ManualTokenResult> => {
    const lang = settingsStore.get().language;
    const setupTokenMessage = (code: SetupTokenError["code"]): string => {
      const keys = {
        notFound: "setupToken.claudeNotFound",
        timeout: "setupToken.timeout",
        inProgress: "setupToken.inProgress",
        noToken: "setupToken.noToken",
        launchFailed: "setupToken.launchFailed"
      } as const;
      return t(lang, keys[code]);
    };

    const persistClaudeToken = async (token: string, savedMessage: string): Promise<ManualTokenResult> => {
      let scrapeResult: ScrapeResult;
      try {
        scrapeResult = await validateClaudeOAuthToken(token);
      } catch (error) {
        const detail = error instanceof Error ? error.message : t(lang, "scrape.unknownError");
        return { ok: false, message: detail };
      }

      try {
        await writeClaudeSetupTokenToKeychain(token);
      } catch (error) {
        console.error("[Usage-Pulse] Keychain write for setup-token failed", error);
      }
      settingsStore.update({ claudeManualOAuthToken: token });
      credentialMonitor.resetFailureStreak("claude");
      closeManualCredentialWindow();
      try {
        monitor.applyScrapeResult("claude", scrapeResult);
      } catch (error) {
        console.error("[Usage-Pulse] apply usage after setup-token failed", error);
      }
      await credentialMonitor.check("claude");
      return { ok: true, message: savedMessage };
    };

    const fromKeychain = await peekClaudeKeychainCredential();
    const keychainExpiryMs = fromKeychain?.expiresAt ? Date.parse(fromKeychain.expiresAt) : Number.NaN;
    const keychainUsable =
      Boolean(fromKeychain) && (Number.isNaN(keychainExpiryMs) || keychainExpiryMs > Date.now());
    if (keychainUsable) {
      await monitor.runServiceCheck("claude", "manual").catch((error) => {
        console.error("[Usage-Pulse] refresh after Keychain re-detect failed", error);
      });
      await credentialMonitor.check("claude");
      return { ok: true, message: t(lang, "setupToken.keychainFound") };
    }

    try {
      const token = await runClaudeSetupToken({
        userDataDir: app.getPath("userData"),
        onAuthUrl: (url) => {
          void shell.openExternal(url);
        }
      });
      return persistClaudeToken(token, t(lang, "setupToken.saved"));
    } catch (error) {
      if (error instanceof SetupTokenError) {
        return { ok: false, message: setupTokenMessage(error.code) };
      }
      const detail = error instanceof Error ? error.message : t(lang, "app.authRefreshFailed");
      return { ok: false, message: detail };
    }
  });

  // The manual-token flow. Only reachable after automatic detection has failed
  // twice, or when the user asks for it from Settings.
  ipcMain.handle("credential:open-manual", (_event, service: ServiceType) => {
    credentialMonitor.openManualEntry(service);
  });
  ipcMain.handle(
    "credential:request-manual-context",
    (): ManualCredentialContext | null => getManualCredentialContext()
  );
  ipcMain.handle("credential:dismiss-manual", () => {
    closeManualCredentialWindow();
  });
  ipcMain.handle("credential:clear-manual", async (_event, service: ServiceType) => {
    if (service !== "claude") {
      return;
    }
    settingsStore.update({ claudeManualOAuthToken: "" });
    await credentialMonitor.check("claude");
  });
  // Validate first, store second: a token that cannot fetch is never written,
  // so a typo can never outrank the automatic sources.
  ipcMain.handle("credential:submit-manual-token", async (_event, token: string): Promise<ManualTokenResult> => {
    const lang = settingsStore.get().language;
    const trimmed = typeof token === "string" ? token.trim() : "";
    if (!trimmed) {
      return { ok: false, message: t(lang, "manualToken.error.empty") };
    }

    let scrapeResult: ScrapeResult;
    try {
      scrapeResult = await validateClaudeOAuthToken(trimmed);
    } catch (error) {
      const detail = error instanceof Error ? error.message : t(lang, "scrape.unknownError");
      return { ok: false, message: detail };
    }

    settingsStore.update({ claudeManualOAuthToken: trimmed });
    credentialMonitor.resetFailureStreak("claude");
    closeManualCredentialWindow();
    try {
      monitor.applyScrapeResult("claude", scrapeResult);
    } catch (error) {
      console.error("[Usage-Pulse] apply usage after manual token failed", error);
    }
    await credentialMonitor.check("claude");
    return { ok: true, message: t(lang, "manualToken.saved") };
  });

  ipcMain.handle("monitor:get-latest", () => monitor.getLatestSnapshot());
  ipcMain.handle("app:quit", () => {
    app.quit();
  });
  ipcMain.handle("session:get-stats", (): SessionStats => collectSessionStats());
  ipcMain.handle("session:log-cup", (_event, sizeMl?: WaterCupSizeMl): SessionStats => {
    const cup = sizeMl ?? settingsStore.get().waterCupSizeMl;
    sessionTracker.logCup(cup);
    const stats = collectSessionStats();
    emitSessionStats();
    return stats;
  });
  ipcMain.handle("session:request-stats", (): SessionStats => collectSessionStats());
  ipcMain.handle("session:continue", () => {
    cancelQuit();
  });
  ipcMain.handle("session:confirm-quit", () => {
    confirmQuit();
  });
  ipcMain.handle("water:drink", (): SessionStats => {
    sessionTracker.logCup(settingsStore.get().waterCupSizeMl);
    closeAlarmPopup();
    const stats = collectSessionStats();
    emitSessionStats();
    return stats;
  });
  ipcMain.handle("water:skip", () => {
    closeAlarmPopup();
  });
  ipcMain.handle("app:open-external", (_event, url: string) => {
    if (typeof url === "string" && /^https:\/\//.test(url)) {
      return shell.openExternal(url);
    }
  });
  ipcMain.handle("app:clear-clipboard", () => {
    clipboard.clear();
  });
  ipcMain.handle("app:copy-to-clipboard", (_event, text: string) => {
    clipboard.writeText(text);
  });

  ipcMain.handle("alarm:get-status", async (): Promise<AlarmStatusReport> => alarmService.getReport());
  ipcMain.handle("alarm:rearm", async (): Promise<AlarmStatusReport> => {
    alarmService.rearm("manual");
    return alarmService.getReport();
  });
  ipcMain.handle("alarm:test-popup", () => {
    alarmService.showTestPopup();
  });
  ipcMain.handle("alarm:request-payload", () => getAlarmPayload());
  ipcMain.handle("alarm:dismiss", () => {
    closeAlarmPopup();
  });
  ipcMain.handle("alarm:snooze", () => {
    snoozeAlarmPopup();
  });
};

app.whenReady().then(async () => {
  const settings = settingsStore.get();
  await applyIdeLaunchHelper(settings.launchWithIde).catch((error) => {
    console.error("[Usage-Pulse] failed to apply IDE launch helper", error);
  });
  sessionTracker.start(Date.now(), snapshotStore.get());
  sessionReady = true;
  waterReminder.start();
  setupIpcHandlers();

  monitor.on("snapshot", (snapshot: CombinedSnapshot) => {
    sessionTracker.observeSnapshot(snapshot);
    updateTrayText(snapshot);
    if (trayApp.window && !trayApp.window.isDestroyed()) {
      trayApp.window.webContents.send("snapshot:updated", snapshot);
    }
  });

  monitor.on("error", (error: Error) => {
    console.error("[Usage-Pulse]", error.message);
  });

  // Lets the periodic sweep reach an already-open window; without it the
  // credential rows would only ever refresh on mount or on a manual re-detect.
  credentialMonitor.on("auth", (status: AuthStatus) => {
    if (trayApp.window && !trayApp.window.isDestroyed()) {
      trayApp.window.webContents.send("auth:updated", status);
    }
  });

  credentialMonitor.on("error", (error: Error) => {
    console.error("[Usage-Pulse] credential check failed", error.message);
  });

  // A rotated or dead credential gets one immediate quota check before anyone
  // is notified — hitting the API is what normally prompts the IDE to refresh.
  credentialMonitor.setQuotaRefresher((service) => monitor.runServiceCheck(service, "credential"));

  // Chromium timers do not advance while the machine sleeps, so a timer armed
  // before a sleep comes back late — or, for an alarm already past, not at all.
  // Re-arming on wake is what lets the catch-up window replay it.
  powerMonitor.on("resume", () => {
    alarmService.rearm("resume");
    void credentialMonitor.checkIfDue();
  });
  powerMonitor.on("unlock-screen", () => {
    alarmService.rearm("unlock");
    void credentialMonitor.checkIfDue();
  });

  // Menu-bar value colour follows OS appearance when trayValueColorMode is "system".
  nativeTheme.on("updated", () => {
    if (settingsStore.get().trayValueColorMode !== "system") {
      return;
    }
    void refreshTrayFromLatest();
  });

  app.on("second-instance", (_event, argv) => {
    if (isAlarmLaunch(argv)) {
      alarmService.rearm("manual");
      return;
    }
    trayApp.showWindow();
  });

  trayApp.on("ready", async () => {
    trayApp.tray?.on("right-click", () => {
      trayApp.tray?.popUpContextMenu(buildTrayMenu());
    });

    const latest = monitor.getLatestSnapshot();
    if (latest) {
      await updateTrayText(latest);
    } else if (trayApp.tray) {
      const lang = settingsStore.get().language;
      trayApp.tray.setToolTip(t(lang, "tray.tooltip.noData"));
      if (isMac) {
        await setTrayImage(trayTitleLine1, "? ?");
      }
    }

    // Before the refresh, not after: a successful check moves resetsAt forward
    // to the next cycle, which would erase the very firing we need to catch up.
    alarmService.rearm("startup");
    if (isAlarmLaunch(process.argv)) {
      console.log("[Usage-Pulse] launched by a system alarm");
    }

    await monitor.runCheck("startup").catch((error) => {
      console.error("[Usage-Pulse] startup check failed", error);
    });
    monitor.start();

    await credentialMonitor.checkAll().catch((error) => {
      console.error("[Usage-Pulse] startup credential check failed", error);
    });
    credentialMonitor.start();
    syncIdePresenceMonitor(settingsStore.get().launchWithIde);
  });
});

app.on("before-quit", () => {
  idePresenceMonitor.stop();
  monitor.stop();
  credentialMonitor.stop();
  destroyAlarmWindow();
  destroyTrayRenderer();
});

app.on("window-all-closed", () => {});
