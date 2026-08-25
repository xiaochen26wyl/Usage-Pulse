import { join } from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, powerMonitor, shell } from "electron";
import { menubar } from "menubar";
import type {
  AlarmStatusReport,
  AppSettings,
  AuthStatus,
  CombinedSnapshot,
  CredentialStatus,
  ManualTokenResult,
  ScrapeResult,
  SessionStats,
  ServiceType,
  WaterCupSizeMl
} from "@shared/types";
import { CLAUDE_MANUAL_TOKEN_MASK, LINE_TOKEN_MASK } from "@shared/types";
import { localeForLanguage, t } from "@shared/i18n";
import { isSupportLink } from "@shared/support-links";
import { resolveTrayValueColor } from "@shared/tray-value-color";
import {
  claudeCountdownTargetAt,
  claudeTrayValueText,
  cursorCountdownTargetAt,
  cursorTrayValueText,
  snapshotValueText
} from "@shared/tray-display";
import { alarmService } from "@main/alarm-service";
import { destroyAlarmWindow, closeAlarmPopup, getAlarmPayload, snoozeAlarmPopup } from "@main/alarm-window";
import { closeSessionSummary, destroySessionWindow, showSessionSummary } from "@main/session-window";
import { sessionTracker } from "@main/session-tracker";
import { waterReminder } from "@main/water-reminder";
import { clearStaleSetupTokenCapture, runClaudeSetupToken, SetupTokenError } from "@main/claude-setup-token";
import { validateClaudeOAuthToken } from "@main/collectors/claude-code";
import { credentialMonitor } from "@main/credential-monitor";
import {
  peekClaudeKeychainCredential,
  setManualClaudeTokenProvider,
  writeClaudeSetupTokenToKeychain
} from "@main/credential-provider";
import { applyAppLoginItem } from "@main/app-login-item";
import { applyIdeLaunchHelper } from "@main/ide-launch-helper";
import { IdePresenceMonitor, probeIdeRunning } from "@main/ide-presence";
import {
  asClipboardText,
  asServiceType,
  asSettingsPatch,
  asWaterCupSize
} from "@main/ipc-validation";
import { redact } from "@main/log-redaction";
import { isSecretStorageAvailable } from "@main/secure-store";
import { sendLineBroadcast } from "@main/line-notifier";
import { MonitorEngine } from "@main/monitor-engine";
import { installWebContentsHardening } from "@main/window-hardening";
import { settingsStore, snapshotStore } from "@main/store";
import { destroyTrayRenderer, renderTrayImage } from "@main/tray-icon-renderer";

const isMac = process.platform === "darwin";
const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);

// This is a tray app whose entire value is staying alive silently for hours —
// a reset alarm it never watched fire (because the process died) does not get
// a second chance. Node's default behaviour for either of these is to print a
// trace and exit, which takes the whole app down over one unguarded rejection
// anywhere in this event-driven codebase, with no crash report to explain it
// (a clean process exit, not a fault). Log and keep running instead.
process.on("uncaughtException", (error) => {
  console.error("[Usage-Pulse] uncaught exception (main process kept alive)", redact(error));
});
process.on("unhandledRejection", (reason) => {
  console.error("[Usage-Pulse] unhandled rejection (main process kept alive)", redact(reason));
});

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

// Registered here, at module scope, so it is already in place when menubar
// builds its preloaded window a few lines below.
installWebContentsHardening();

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
      sandbox: true,
      nodeIntegration: false
    }
  }
});

const trayTitleLine1 = "Cursor Claude";
const trayTitleLine2 = (snapshot: CombinedSnapshot): string =>
  `${cursorTrayValueText(snapshot.cursor, Date.now())} ${claudeTrayValueText(snapshot.claude, Date.now())}`;

// The Cursor and/or Claude slot counts down once its quota window is spent,
// so re-render the tray from the cached snapshot on a timer. Purely local: it
// never triggers a quota fetch, and it only runs while a countdown is on
// screen. Claude's countdown is minute-scale (5-hour window), so tick every
// minute when it's active; Cursor's is day-scale (billing cycle), so an
// hourly tick is plenty when only that one is showing.
const TRAY_COUNTDOWN_TICK_MS = 60 * 1000;
const TRAY_DAY_COUNTDOWN_TICK_MS = 60 * 60 * 1000;
let trayCountdownTimer: NodeJS.Timeout | null = null;

const clearTrayCountdownTick = (): void => {
  if (trayCountdownTimer) {
    clearTimeout(trayCountdownTimer);
    trayCountdownTimer = null;
  }
};

const scheduleTrayCountdownTick = (snapshot: CombinedSnapshot): void => {
  clearTrayCountdownTick();
  if (!isMac) {
    return;
  }
  const claudeTarget = claudeCountdownTargetAt(snapshot.claude);
  const cursorTarget = cursorCountdownTargetAt(snapshot.cursor);
  if (!claudeTarget && !cursorTarget) {
    return;
  }
  const nowMs = Date.now();
  const remainingMsList = [claudeTarget, cursorTarget]
    .filter((target): target is string => target !== null)
    .map((target) => new Date(target).getTime() - nowMs)
    .filter((ms) => Number.isFinite(ms) && ms > 0);
  if (remainingMsList.length === 0) {
    return;
  }
  const tickMs = claudeTarget ? TRAY_COUNTDOWN_TICK_MS : TRAY_DAY_COUNTDOWN_TICK_MS;
  trayCountdownTimer = setTimeout(() => {
    trayCountdownTimer = null;
    void refreshTrayFromLatest();
  }, Math.min(tickMs, Math.min(...remainingMsList) + 1000));
};

const updateTrayText = async (snapshot: CombinedSnapshot): Promise<void> => {
  if (!trayApp.tray) {
    return;
  }

  const lang = settingsStore.get().language;
  const toolTipLines = [
    "Usage-Pulse",
    `Cursor: ${snapshotValueText(snapshot.cursor)}`,
    `Claude Code: ${snapshotValueText(snapshot.claude)}`,
  ];
  if (snapshot.claude.resetsAt) {
    const date = new Date(snapshot.claude.resetsAt);
    if (!Number.isNaN(date.getTime())) {
      const timeStr = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
      toolTipLines.push(t(lang, "tray.tooltip.claudeReset", { time: timeStr }));
    }
  }
  toolTipLines.push(
    t(lang, "tray.tooltip.updated", {
      time: new Date(snapshot.fetchedAt).toLocaleTimeString(localeForLanguage(lang))
    })
  );

  if (isMac) {
    await setTrayImage(trayTitleLine1, trayTitleLine2(snapshot));
  }
  trayApp.tray.setToolTip(toolTipLines.join("\n"));
  scheduleTrayCountdownTick(snapshot);
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
    console.error("[Usage-Pulse] tray render failed", redact(error));
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

// No renderer ever gets to see a stored secret. Both of these are working
// credentials — the Claude token against the usage API, the LINE token against
// the user's own official account — and the UI only ever needs to know whether
// one is set, so each leaves the main process as a placeholder.
const maskSecrets = (settings: AppSettings): AppSettings => ({
  ...settings,
  claudeManualOAuthToken: settings.claudeManualOAuthToken ? CLAUDE_MANUAL_TOKEN_MASK : "",
  lineChannelAccessToken: settings.lineChannelAccessToken ? LINE_TOKEN_MASK : ""
});

// ...and a patch carrying a placeholder back is a no-op, not an instruction to
// overwrite the real secret with the mask.
const stripMaskedSecrets = (patch: Partial<AppSettings>): Partial<AppSettings> => {
  const result = { ...patch };
  if (result.claudeManualOAuthToken === CLAUDE_MANUAL_TOKEN_MASK) {
    delete result.claudeManualOAuthToken;
  }
  if (result.lineChannelAccessToken === LINE_TOKEN_MASK) {
    delete result.lineChannelAccessToken;
  }
  return result;
};

const setupIpcHandlers = (): void => {
  ipcMain.handle("settings:get", () => maskSecrets(settingsStore.get()));
  ipcMain.handle("settings:save", (_event, patch: unknown) => {
    const next = settingsStore.update(stripMaskedSecrets(asSettingsPatch(patch)));
    void applyIdeLaunchHelper(next.launchWithIde).catch((error) => {
      console.error("[Usage-Pulse] failed to apply IDE launch helper", redact(error));
    });
    syncIdePresenceMonitor(next.launchWithIde);
    applyAppLoginItem(next.launchAtStartup);
    monitor.reschedule();
    waterReminder.reschedule();
    emitSessionStats();
    const latest = monitor.getLatestSnapshot();
    if (latest) {
      updateTrayText(latest);
    }
    return maskSecrets(next);
  });

  // Lets the settings panel confirm a freshly pasted token actually works,
  // independent of enableLineNotification (a disabled toggle must not make
  // the test button lie about a broken token).
  ipcMain.handle("line:send-test", async (): Promise<boolean> => {
    const settings = settingsStore.get();
    const accessToken = settings.lineChannelAccessToken.trim();
    if (!accessToken) {
      return false;
    }
    const lang = settings.language;
    return sendLineBroadcast(
      { type: "text", text: t(lang, "line.testMessage", { time: new Date().toLocaleString(localeForLanguage(lang)) }) },
      { force: true }
    );
  });

  // Lets Settings warn when a stored token would sit on disk unencrypted.
  ipcMain.handle("app:secret-storage-available", (): boolean => isSecretStorageAvailable());

  ipcMain.handle("auth:status", (): AuthStatus => credentialMonitor.getStatus());
  // Per-service on purpose: each quota card re-detects only its own credential,
  // so a failing Cursor login can be retried without touching Claude Code.
  ipcMain.handle("auth:check", (_event, service: unknown): Promise<CredentialStatus | null> => {
    const target = asServiceType(service);
    return target ? credentialMonitor.check(target) : Promise.resolve(null);
  });

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
      // Unlike a hand-pasted token, this one just came straight from the
      // official CLI after a real login, so there is no typo risk to guard
      // against. A quota scrape can still fail right after issuance (e.g. no
      // usage window recorded yet) — that must not throw the token away and
      // send the user back to log in again; store it regardless.
      let scrapeResult: ScrapeResult | null = null;
      try {
        scrapeResult = await validateClaudeOAuthToken(token);
      } catch (error) {
        console.error("[Usage-Pulse] setup-token quota scrape failed, storing token anyway", redact(error));
      }

      try {
        await writeClaudeSetupTokenToKeychain(token);
      } catch (error) {
        console.error("[Usage-Pulse] Keychain write for setup-token failed", redact(error));
      }
      settingsStore.update({ claudeManualOAuthToken: token });
      if (scrapeResult) {
        try {
          monitor.applyScrapeResult("claude", scrapeResult);
        } catch (error) {
          console.error("[Usage-Pulse] apply usage after setup-token failed", redact(error));
        }
      } else {
        // The validation scrape above failed, so the card is still showing
        // whatever it showed before this login (often the very "expired"
        // reading that sent the user through this flow). credentialMonitor's
        // own re-probe below re-reads the credential, not the quota — and its
        // self-heal path funnels through the *scheduled* rate floor, which a
        // login that just happened moments after a failed scheduled poll would
        // still be inside. Retry the quota read directly with the "manual"
        // trigger, the same way the keychainUsable branch below does, so a
        // fresh login is never left showing stale numbers.
        try {
          await monitor.runServiceCheck("claude", "manual");
        } catch (error) {
          console.error("[Usage-Pulse] post-login quota retry failed", redact(error));
        }
      }
      await credentialMonitor.check("claude");
      return { ok: true, message: savedMessage };
    };

    const fromKeychain = await peekClaudeKeychainCredential();
    const keychainExpiryMs = fromKeychain?.expiresAt ? Date.parse(fromKeychain.expiresAt) : Number.NaN;
    const keychainUsable =
      Boolean(fromKeychain) && (Number.isNaN(keychainExpiryMs) || keychainExpiryMs > Date.now());
    if (keychainUsable) {
      // A captured token from an earlier run of this flow outranks the Keychain
      // in readClaudeCredential's priority (it's the fallback for when a
      // Keychain write couldn't be confirmed) — so a stale one left over from
      // before would silently shadow the Keychain entry just confirmed above,
      // and the quota fetch below would use the wrong credential. Since the
      // Keychain checked out here, it's authoritative; drop the fallback.
      settingsStore.update({ claudeManualOAuthToken: "" });
      // scrapeQuota() never rejects — a failed fetch resolves as an
      // isError snapshot — so success is read off the result, not a catch.
      const checkResult = await monitor.runServiceCheck("claude", "manual").catch((error) => {
        console.error("[Usage-Pulse] refresh after Keychain re-detect failed", redact(error));
        return null;
      });
      await credentialMonitor.check("claude");
      if (checkResult && checkResult.snapshot.claude.status !== "error") {
        return { ok: true, message: t(lang, "setupToken.keychainFound") };
      }
      // The Keychain entry looked usable (often because it carries no expiry
      // we could read at all) but the API just rejected it anyway. Don't dead-end
      // here — fall through to a fresh `claude setup-token` login so a terminal
      // and the login URL actually open instead of silently retrying the same
      // dead token.
      console.error(
        "[Usage-Pulse] Keychain credential rejected by API on re-detect, falling back to setup-token login"
      );
    }

    try {
      const token = await runClaudeSetupToken({
        userDataDir: app.getPath("userData"),
        onAuthUrl: (url) => {
          shell.openExternal(url).catch((error) => {
            console.error("[Usage-Pulse] failed to open the setup-token login URL", redact(error));
          });
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

  // Clears the token the re-detect flow captured, so a stuck/bad one can be
  // dropped without waiting for it to expire on its own.
  ipcMain.handle("credential:clear-manual", async (_event, service: unknown) => {
    if (asServiceType(service) !== "claude") {
      return;
    }
    settingsStore.update({ claudeManualOAuthToken: "" });
    await credentialMonitor.check("claude");
  });

  ipcMain.handle("monitor:get-latest", () => monitor.getLatestSnapshot());
  ipcMain.handle("app:quit", () => {
    app.quit();
  });
  ipcMain.handle("session:get-stats", (): SessionStats => collectSessionStats());
  ipcMain.handle("session:log-cup", (_event, sizeMl?: unknown): SessionStats => {
    const cup = asWaterCupSize(sizeMl) ?? settingsStore.get().waterCupSizeMl;
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
  // Allowlist, not a protocol check: the renderer only ever needs the handful
  // of support links it renders in the footer, so anything else is refused
  // rather than handed to the OS.
  ipcMain.handle("app:open-external", (_event, url: unknown) => {
    if (isSupportLink(url)) {
      return shell.openExternal(url);
    }
    console.warn("[Usage-Pulse] refused openExternal for a non-allowlisted URL");
  });
  ipcMain.handle("app:clear-clipboard", () => {
    clipboard.clear();
  });
  ipcMain.handle("app:copy-to-clipboard", (_event, text: unknown) => {
    const safe = asClipboardText(text);
    if (safe !== null) {
      clipboard.writeText(safe);
    }
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
  // A previous run that died mid-login can leave the setup-token capture file
  // on disk with a live token in it.
  await clearStaleSetupTokenCapture(app.getPath("userData")).catch(() => undefined);

  const settings = settingsStore.get();
  await applyIdeLaunchHelper(settings.launchWithIde).catch((error) => {
    console.error("[Usage-Pulse] failed to apply IDE launch helper", redact(error));
  });
  applyAppLoginItem(settings.launchAtStartup);
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
    console.error("[Usage-Pulse]", redact(error));
  });

  // Lets the periodic sweep reach an already-open window; without it the
  // credential rows would only ever refresh on mount or on a manual re-detect.
  credentialMonitor.on("auth", (status: AuthStatus) => {
    if (trayApp.window && !trayApp.window.isDestroyed()) {
      trayApp.window.webContents.send("auth:updated", status);
    }
  });

  credentialMonitor.on("error", (error: Error) => {
    console.error("[Usage-Pulse] credential check failed", redact(error));
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
      console.error("[Usage-Pulse] startup check failed", redact(error));
    });
    monitor.start();

    await credentialMonitor.checkAll().catch((error) => {
      console.error("[Usage-Pulse] startup credential check failed", redact(error));
    });
    credentialMonitor.start();
    syncIdePresenceMonitor(settingsStore.get().launchWithIde);
  });
});

app.on("before-quit", () => {
  clearTrayCountdownTick();
  idePresenceMonitor.stop();
  monitor.stop();
  credentialMonitor.stop();
  destroyAlarmWindow();
  destroyTrayRenderer();
});

app.on("window-all-closed", () => {});
