import { join } from "node:path";
import { app, BrowserWindow, screen } from "electron";
import { SetupTokenError } from "@main/claude-setup-token";
import { startClaudeLoginPty, type ClaudeLoginPtySession } from "@main/claude-login-pty";

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);

const WINDOW_WIDTH = 720;
const WINDOW_HEIGHT = 440;

export interface ClaudeLoginWindowOptions {
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
let pendingOptions: ClaudeLoginWindowOptions | null = null;
let rendererReady = false;
// Chunks that arrived before the renderer finished wiring its listeners.
let earlyOutput: string[] = [];

const flushEarlyOutput = (): void => {
  if (!window || window.isDestroyed() || earlyOutput.length === 0) {
    return;
  }
  for (const chunk of earlyOutput) {
    window.webContents.send("claude-login:data", chunk);
  }
  earlyOutput = [];
};

const startSession = (options: ClaudeLoginWindowOptions): void => {
  if (session) {
    session.kill();
    session = null;
  }
  earlyOutput = [];

  startClaudeLoginPty({
    onData: (chunk) => {
      if (window && !window.isDestroyed() && rendererReady) {
        window.webContents.send("claude-login:data", chunk);
      } else {
        earlyOutput.push(chunk);
      }
    },
    onExit: (exitCode) => {
      if (window && !window.isDestroyed()) {
        flushEarlyOutput();
        window.webContents.send("claude-login:exit", exitCode);
      }
      session = null;
    }
  })
    .then((started) => {
      session = started;
      if (rendererReady) {
        flushEarlyOutput();
      }
    })
    .catch((error) => {
      options.onSpawnError(error instanceof SetupTokenError ? error : new SetupTokenError("launchFailed"));
      if (window && !window.isDestroyed()) {
        window.close();
      }
    });
};

const createWindow = (): BrowserWindow => {
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
    rendererReady = false;
    earlyOutput = [];
    session?.kill();
    session = null;
  });

  void created.loadURL(claudeLoginUrl());
  return created;
};

/**
 * Opens the node-pty-backed login window. Always (re)starts `claude setup-token`
 * so a previous dead/blank session cannot leave the user staring at silence.
 * PTY output is buffered until the renderer signals ready, avoiding the race
 * where early CLI output is sent before xterm has subscribed.
 */
export const openClaudeLoginWindow = (options: ClaudeLoginWindowOptions): void => {
  pendingOptions = options;

  if (window && !window.isDestroyed()) {
    rendererReady = false;
    window.show();
    window.focus();
    // Reload so the terminal clears and React re-subscribes, then wait for ready.
    void window.loadURL(claudeLoginUrl());
    return;
  }

  rendererReady = false;
  window = createWindow();
  window.once("ready-to-show", () => {
    window?.show();
    window?.focus();
  });
};

/**
 * Called once the login window's xterm listeners are wired. Flushes any early
 * PTY output and starts (or restarts) the session if needed.
 */
export const notifyClaudeLoginRendererReady = (): void => {
  rendererReady = true;
  flushEarlyOutput();
  if (!session && pendingOptions) {
    startSession(pendingOptions);
  }
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
  rendererReady = false;
  earlyOutput = [];
  pendingOptions = null;
  if (window && !window.isDestroyed()) {
    window.close();
  }
  window = null;
};
