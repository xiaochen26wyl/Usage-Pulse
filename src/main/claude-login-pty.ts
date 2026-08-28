import * as pty from "node-pty";
import type { IPty } from "node-pty";
import {
  extractAuthUrlFromOutput,
  extractSetupTokenFromOutput,
  resolveClaudeBinary,
  SetupTokenError
} from "@main/claude-setup-token";

export interface ClaudeLoginPtySession {
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
}

export interface ClaudeLoginPtyOptions {
  onData: (chunk: string) => void;
  onAuthUrl: (url: string) => void;
  onTokenCaptured: (token: string) => void;
  onExit: (exitCode: number) => void;
}

const BUFFER_CAP = 32_000;
const BUFFER_KEEP = 16_000;

/**
 * Runs `claude setup-token` inside a real pseudo-terminal that this process
 * owns, so its output reaches us the moment it's written — unlike piping
 * through a shell `tee` into a visible Terminal.app window, where the CLI's
 * own stdout buffering (it detects a non-TTY once piped) made capture
 * unreliable. Usage-Pulse is now the only thing that ever sees this output;
 * the visible "terminal" the user watches is the claude-login BrowserWindow,
 * fed this same data over IPC.
 */
export const startClaudeLoginPty = async (options: ClaudeLoginPtyOptions): Promise<ClaudeLoginPtySession> => {
  const claudePath = await resolveClaudeBinary();

  let ptyProcess: IPty;
  try {
    ptyProcess = pty.spawn(claudePath, ["setup-token"], {
      name: "xterm-color",
      cols: 100,
      rows: 30,
      cwd: process.env.HOME || process.env.USERPROFILE,
      env: process.env as { [key: string]: string }
    });
  } catch {
    throw new SetupTokenError("launchFailed");
  }

  let buffer = "";
  let urlSeen = false;
  let tokenSeen = false;

  ptyProcess.onData((chunk) => {
    options.onData(chunk);
    buffer += chunk;
    if (buffer.length > BUFFER_CAP) {
      buffer = buffer.slice(-BUFFER_KEEP);
    }

    if (!urlSeen) {
      const url = extractAuthUrlFromOutput(buffer);
      if (url) {
        urlSeen = true;
        options.onAuthUrl(url);
      }
    }

    if (!tokenSeen) {
      const token = extractSetupTokenFromOutput(buffer);
      if (token) {
        tokenSeen = true;
        options.onTokenCaptured(token);
      }
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    options.onExit(exitCode);
  });

  return {
    write: (data) => {
      try {
        ptyProcess.write(data);
      } catch {
        // The process has already exited; nothing to write to.
      }
    },
    resize: (cols, rows) => {
      if (cols > 0 && rows > 0) {
        try {
          ptyProcess.resize(cols, rows);
        } catch {
          // The process has already exited.
        }
      }
    },
    kill: () => {
      try {
        ptyProcess.kill();
      } catch {
        // Already exited.
      }
    }
  };
};
