import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { resolveClaudeBinary, SetupTokenError } from "@main/claude-setup-token";

export interface ClaudeLoginPtySession {
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
}

export interface ClaudeLoginPtyOptions {
  onData: (chunk: string) => void;
  onExit: (exitCode: number) => void;
}

/**
 * Runs `claude setup-token` inside a real pseudo-terminal so the user can
 * complete the official login without leaving the app. The official CLI opens
 * its own browser page; the printed setup-token stays a manual copy/paste step.
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

  ptyProcess.onData((chunk) => {
    options.onData(chunk);
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
