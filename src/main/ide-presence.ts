import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const IDE_POLL_INTERVAL_MS = 1_800_000;
export const IDLE_POLLS_BEFORE_PROMPT = 2;

const CURSOR_NAMES: Record<"darwin" | "win32", readonly string[]> = {
  darwin: ["Cursor"],
  win32: ["Cursor.exe"]
};

const CLAUDE_CODE_NAMES: Record<"darwin" | "win32", readonly string[]> = {
  darwin: ["claude"],
  win32: ["claude.exe", "claude"]
};

const CODEX_NAMES: Record<"darwin" | "win32", readonly string[]> = {
  darwin: ["codex"],
  win32: ["codex.exe", "codex"]
};

const CLAUDE_CODE_COMMAND_NEEDLES = ["claude-code", "@anthropic-ai/claude-code"] as const;
const CODEX_COMMAND_NEEDLES = ["@openai/codex", "openai-codex"] as const;

const processPlatform = (platform: NodeJS.Platform): "darwin" | "win32" | null => {
  if (platform === "win32") {
    return "win32";
  }
  if (platform === "darwin") {
    return "darwin";
  }
  return null;
};

const equalsIgnoreCase = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const nameMatches = (name: string, expected: readonly string[], ignoreCase: boolean): boolean =>
  expected.some((candidate) => (ignoreCase ? equalsIgnoreCase(name, candidate) : name === candidate));

export const isCursorProcessName = (name: string, platform: NodeJS.Platform): boolean => {
  const key = processPlatform(platform);
  if (!key) {
    return name === "Cursor";
  }
  return nameMatches(name, CURSOR_NAMES[key], key === "win32");
};

// Exact `claude` / `claude.exe` only. Claude Desktop's process is `Claude` and
// is intentionally excluded — that login never produces the CLI credential.
export const isClaudeCodeProcessName = (name: string, platform: NodeJS.Platform): boolean => {
  const key = processPlatform(platform);
  if (!key) {
    return name === "claude";
  }
  // Case-sensitive on purpose: Claude Desktop is `Claude` / `Claude.exe`.
  return nameMatches(name, CLAUDE_CODE_NAMES[key], false);
};

export const commandLineLooksLikeClaudeCode = (commandLine: string): boolean => {
  const lower = commandLine.toLowerCase();
  return CLAUDE_CODE_COMMAND_NEEDLES.some((needle) => lower.includes(needle));
};

export const isCodexProcessName = (name: string, platform: NodeJS.Platform): boolean => {
  const key = processPlatform(platform);
  if (!key) {
    return name === "codex";
  }
  return nameMatches(name, CODEX_NAMES[key], key === "win32");
};

export const commandLineLooksLikeCodex = (commandLine: string): boolean => {
  const lower = commandLine.toLowerCase();
  return CODEX_COMMAND_NEEDLES.some((needle) => lower.includes(needle)) || /(^|[\\/\s])codex(\.exe)?(\s|$)/i.test(commandLine);
};

export const processLooksLikeIde = (input: {
  name: string;
  commandLine?: string;
  platform: NodeJS.Platform;
}): boolean => {
  if (isCursorProcessName(input.name, input.platform)) {
    return true;
  }
  if (isClaudeCodeProcessName(input.name, input.platform)) {
    return true;
  }
  if (isCodexProcessName(input.name, input.platform)) {
    return true;
  }
  return Boolean(
    input.commandLine &&
      (commandLineLooksLikeClaudeCode(input.commandLine) || commandLineLooksLikeCodex(input.commandLine))
  );
};

// Older stores only had launchAtLogin. A value already written for
// launchWithIde wins so a later disable is not overwritten by the leftover key.
export const migrateLaunchWithIde = (stored: {
  launchWithIde?: unknown;
  launchAtLogin?: unknown;
}): boolean => {
  if (typeof stored.launchWithIde === "boolean") {
    return stored.launchWithIde;
  }
  return stored.launchAtLogin === true;
};

export interface IdeQuitPromptState {
  seenIde: boolean;
  idleStreak: number;
  promptOpen: boolean;
  holdUntilIdeReturns: boolean;
}

export const initialIdeQuitPromptState = (): IdeQuitPromptState => ({
  seenIde: false,
  idleStreak: 0,
  promptOpen: false,
  holdUntilIdeReturns: false
});

export type IdeQuitPromptEvent =
  | { type: "poll"; running: boolean }
  | { type: "choseStay" }
  | { type: "promptClosed" };

export type IdeQuitPromptAction = "none" | "showPrompt" | "cancelPrompt";

export const reduceIdeQuitPrompt = (
  state: IdeQuitPromptState,
  event: IdeQuitPromptEvent
): { state: IdeQuitPromptState; action: IdeQuitPromptAction } => {
  if (event.type === "choseStay") {
    return {
      state: {
        ...state,
        promptOpen: false,
        holdUntilIdeReturns: true,
        idleStreak: 0
      },
      action: "none"
    };
  }

  if (event.type === "promptClosed") {
    return {
      state: { ...state, promptOpen: false },
      action: "none"
    };
  }

  if (event.running) {
    return {
      state: {
        seenIde: true,
        idleStreak: 0,
        promptOpen: false,
        holdUntilIdeReturns: false
      },
      action: state.promptOpen ? "cancelPrompt" : "none"
    };
  }

  if (!state.seenIde || state.holdUntilIdeReturns || state.promptOpen) {
    return { state, action: "none" };
  }

  const idleStreak = state.idleStreak + 1;
  if (idleStreak >= IDLE_POLLS_BEFORE_PROMPT) {
    return {
      state: { ...state, idleStreak, promptOpen: true },
      action: "showPrompt"
    };
  }

  return { state: { ...state, idleStreak }, action: "none" };
};

const pgrepExact = async (name: string): Promise<boolean> => {
  try {
    await execFileAsync("pgrep", ["-x", name], { timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
};

const probeDarwin = async (): Promise<boolean> => {
  if (await pgrepExact("Cursor")) {
    return true;
  }
  if (await pgrepExact("claude")) {
    return true;
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-ax", "-o", "command="], { timeout: 3_000 });
    return stdout.split("\n").some((line) => commandLineLooksLikeClaudeCode(line));
  } catch {
    return false;
  }
};

const probeWindows = async (): Promise<boolean> => {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        [
          "$p = Get-Process -Name 'Cursor' -ErrorAction SilentlyContinue;",
          "if ($p) { Write-Output '1'; exit 0 };",
          "$c = Get-Process -Name 'claude' -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -ceq 'claude' };",
          "if ($c) { Write-Output '1'; exit 0 };",
          "$hit = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |",
          "  Where-Object { $_.CommandLine -and ($_.CommandLine -match 'claude-code|@anthropic-ai/claude-code') };",
          "if ($hit) { Write-Output '1' }"
        ].join(" ")
      ],
      { timeout: 8_000, windowsHide: true }
    );
    return stdout.includes("1");
  } catch {
    return false;
  }
};

export const probeIdeRunning = async (platform: NodeJS.Platform = process.platform): Promise<boolean> => {
  if (platform === "win32") {
    return probeWindows();
  }
  if (platform === "darwin") {
    return probeDarwin();
  }
  return false;
};

export type IdeQuitAnswer = "quit" | "stay" | "cancelled";

export class IdePresenceMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private state = initialIdeQuitPromptState();
  private asking = false;

  constructor(
    private readonly deps: {
      probe: () => Promise<boolean>;
      ask: () => Promise<IdeQuitAnswer>;
      cancelAsk: () => void;
      quit: () => void;
    }
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, IDE_POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.deps.cancelAsk();
    this.state = initialIdeQuitPromptState();
    this.asking = false;
  }

  private async tick(): Promise<void> {
    let running = false;
    try {
      running = await this.deps.probe();
    } catch {
      return;
    }

    const { state, action } = reduceIdeQuitPrompt(this.state, { type: "poll", running });
    this.state = state;

    if (action === "cancelPrompt") {
      this.deps.cancelAsk();
      this.state = reduceIdeQuitPrompt(this.state, { type: "promptClosed" }).state;
      return;
    }

    if (action !== "showPrompt" || this.asking) {
      return;
    }

    this.asking = true;
    const answer = await this.deps.ask();
    this.asking = false;

    if (answer === "quit") {
      let stillRunning = false;
      try {
        stillRunning = await this.deps.probe();
      } catch {
        stillRunning = false;
      }
      if (stillRunning) {
        this.state = reduceIdeQuitPrompt(this.state, { type: "promptClosed" }).state;
        return;
      }
      this.deps.quit();
      return;
    }
    if (answer === "stay") {
      this.state = reduceIdeQuitPrompt(this.state, { type: "choseStay" }).state;
      return;
    }
    this.state = reduceIdeQuitPrompt(this.state, { type: "promptClosed" }).state;
  }
}
