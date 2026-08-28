import { join } from "node:path";
import { app, BrowserWindow, screen } from "electron";
import { SetupTokenError } from "@main/claude-setup-token";
import { startClaudeLoginPty, type ClaudeLoginPtySession } from "@main/claude-login-pty";

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);

const WINDOW_WIDTH = 720;
const WINDOW_HEIGHT = 440;

export interface ClaudeLoginWindowOptions {
  onAuthUrl: (url: string) => void;
  onTokenCaptured: (token: string) => void;
  // The claude binary couldn't be found, or the PTY itself failed to spawn —
  // there is no terminal for the user to watch at all. Distinct from the PTY
  // process later exiting normally (e.g. the user finished or cancelled the
  // login inside it), which is not an error.
  onSpawnError: (error: SetupTokenError) => void;
}

const claudeLoginUrl = (): string =>
  isDev
    ? `${process.env.ELECTRON_RENDERER_URL}/claude-login.html`
    : `file://${join(app.getAppPath(), "dist/renderer/claude-login.html")}`;

const centeredPosition = (): { x: number; y: number } => {
  const workArea = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(workArea.x + (workArea.width - WINDOW_WIDTH) / 2),
    y: Math.round(workArea.y + (workArea.height - WINDOW_HEIGHT) / 2)
  };
};

let window: BrowserWindow | null = null;
let session: ClaudeLoginPtySession | null = null;

const startSession = (options: ClaudeLoginWindowOptions): void => {
  startClaudeLoginPty({
    onData: (chunk) => {
      if (window && !window.isDestroyed()) {
        window.webContents.send("claude-login:data", chunk);
      }
    },
    onAuthUrl: options.onAuthUrl,
    onTokenCaptured: options.onTokenCaptured,
    onExit: (exitCode) => {
      if (window && !window.isDestroyed()) {
        window.webContents.send("claude-login:exit", exitCode);
      }
      session = null;
    }
  })
    .then((started) => {
      session = started;
    })
    .catch((error) => {
      options.onSpawnError(error instanceof SetupTokenError ? error : new SetupTokenError("launchFailed"));
      if (window && !window.isDestroyed()) {
        window.close();
      }
    });
};

const createWindow = (options: ClaudeLoginWindowOptions): BrowserWindow => {
  const { x, y } = centeredPosition();

  const created = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x,
    y,
    resizable: true,
    show: false,
    fullscreenable: false,
    title: "Claude Code 登入",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  created.on("closed", () => {
    window = null;
    session?.kill();
    session = null;
  });

  created.webContents.on("did-finish-load", () => {
    startSession(options);
  });

  void created.loadURL(claudeLoginUrl());
  return created;
};

/**
 * Opens the node-pty-backed login window, or just focuses it if a login is
 * already in progress — never runs two `claude setup-token` PTYs at once.
 */
export const openClaudeLoginWindow = (options: ClaudeLoginWindowOptions): void => {
  if (window && !window.isDestroyed()) {
    window.show();
    window.focus();
    return;
  }

  window = createWindow(options);
  window.once("ready-to-show", () => {
    window?.show();
    window?.focus();
  });
};

export const writeClaudeLoginPtyInput = (data: string): void => {
  session?.write(data);
};

export const resizeClaudeLoginPty = (cols: number, rows: number): void => {
  session?.resize(cols, rows);
};

export const destroyClaudeLoginWindow = (): void => {
  session?.kill();
  session = null;
  if (window && !window.isDestroyed()) {
    window.close();
  }
  window = null;
};
