// Is Cursor / Claude Code / Codex running? A port of src/main/ide-presence.ts.
// Two users: the "quit when the IDE has been gone for an hour" prompt below,
// and the history cleaner, which refuses to touch Codex's databases while Codex
// is up. Only process names and command lines are read.
use std::{
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::{i18n, settings::SettingsState};

const IDE_POLL_INTERVAL: Duration = Duration::from_secs(1800);
const IDLE_POLLS_BEFORE_PROMPT: u32 = 2;

const CLAUDE_CODE_NEEDLES: [&str; 2] = ["claude-code", "@anthropic-ai/claude-code"];
const CODEX_NEEDLES: [&str; 2] = ["@openai/codex", "openai-codex"];
// The Codex desktop app runs inside ChatGPT.app; the process that holds the
// SQLite files is a bare lowercase `codex … app-server` binary.
const CODEX_DESKTOP_NEEDLES: [&str; 2] = ["codex framework.framework", "codex-code-mode-host"];
// Lives under the same framework but holds none of the databases and can outlive
// the app for days.
const CODEX_IGNORED_HELPERS: [&str; 1] = ["crashpad_handler"];

pub fn command_line_looks_like_claude_code(command_line: &str) -> bool {
    let lower = command_line.to_lowercase();
    CLAUDE_CODE_NEEDLES.iter().any(|needle| lower.contains(needle))
}

// `^(?:\S*[\\/])?codex(?:\.exe)?(?:\s|$)`: the first word is a path ending in codex.
fn is_bare_codex_binary(command_line: &str) -> bool {
    let first = command_line.trim().split_whitespace().next().unwrap_or("");
    let name = first.rsplit(['/', '\\']).next().unwrap_or("");
    name == "codex" || name == "codex.exe"
}

pub fn command_line_looks_like_codex_process(command_line: &str) -> bool {
    let lower = command_line.to_lowercase();
    if CODEX_IGNORED_HELPERS.iter().any(|needle| lower.contains(needle)) {
        return false;
    }
    CODEX_DESKTOP_NEEDLES.iter().any(|needle| lower.contains(needle))
        || CODEX_NEEDLES.iter().any(|needle| lower.contains(needle))
        || is_bare_codex_binary(command_line)
}

fn run(program: &str, args: &[&str]) -> Option<String> {
    let mut command = Command::new(program);
    command.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let output = command.output().ok()?;
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn command_lines() -> Option<Vec<String>> {
    run("ps", &["-ax", "-o", "command="]).map(|text| text.lines().map(str::to_string).collect())
}

#[cfg(target_os = "macos")]
fn pgrep_exact(name: &str) -> bool {
    Command::new("pgrep").args(["-x", name]).output().is_ok_and(|output| output.status.success())
}

fn probe_ide_blocking() -> bool {
    #[cfg(target_os = "macos")]
    {
        if pgrep_exact("Cursor") || pgrep_exact("claude") {
            return true;
        }
        return command_lines().is_some_and(|lines| lines.iter().any(|line| command_line_looks_like_claude_code(line)));
    }
    #[cfg(windows)]
    {
        let script = [
            "$p = Get-Process -Name 'Cursor' -ErrorAction SilentlyContinue;",
            "if ($p) { Write-Output '1'; exit 0 };",
            "$c = Get-Process -Name 'claude' -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -ceq 'claude' };",
            "if ($c) { Write-Output '1'; exit 0 };",
            "$hit = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |",
            "  Where-Object { $_.CommandLine -and ($_.CommandLine -match 'claude-code|@anthropic-ai/claude-code') };",
            "if ($hit) { Write-Output '1' }",
        ]
        .join(" ");
        return run("powershell.exe", &["-NoProfile", "-Command", &script]).is_some_and(|out| out.contains('1'));
    }
    #[allow(unreachable_code)]
    false
}

pub async fn probe_ide_running() -> bool {
    tauri::async_runtime::spawn_blocking(probe_ide_blocking).await.unwrap_or(false)
}

fn probe_codex_blocking() -> Result<bool, String> {
    #[cfg(windows)]
    {
        let script = [
            "$hit = Get-CimInstance Win32_Process -ErrorAction Stop |",
            "  Where-Object { ($_.Name -ieq 'codex.exe') -or",
            "    ($_.CommandLine -and ($_.CommandLine -match 'codex-code-mode-host|@openai/codex|openai-codex')) };",
            "if ($hit) { Write-Output '1' }",
        ]
        .join(" ");
        return run("powershell.exe", &["-NoProfile", "-Command", &script])
            .map(|out| out.contains('1'))
            .ok_or_else(|| "powershell failed".to_string());
    }
    #[cfg(not(windows))]
    {
        let lines = command_lines().ok_or_else(|| "ps failed".to_string())?;
        Ok(lines.iter().any(|line| command_line_looks_like_codex_process(line)))
    }
}

// Unlike probe_ide_running, a failed probe is an error rather than "no": the
// caller decides whether it is safe to edit Codex's databases, and "could not
// tell" must not read as "safe".
pub async fn probe_codex_running() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(probe_codex_blocking)
        .await
        .map_err(|error| error.to_string())?
}

// ---------------------------------------------------------------------------
// "Quit when the IDE is gone" prompt
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Default, Debug, PartialEq)]
pub struct PromptState {
    seen_ide: bool,
    idle_streak: u32,
    prompt_open: bool,
    hold_until_ide_returns: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Event {
    Poll { running: bool },
    ChoseStay,
    PromptClosed,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Action {
    None,
    ShowPrompt,
    CancelPrompt,
}

pub fn reduce(state: PromptState, event: Event) -> (PromptState, Action) {
    match event {
        Event::ChoseStay => (
            PromptState { prompt_open: false, hold_until_ide_returns: true, idle_streak: 0, ..state },
            Action::None,
        ),
        Event::PromptClosed => (PromptState { prompt_open: false, ..state }, Action::None),
        Event::Poll { running: true } => (
            PromptState { seen_ide: true, idle_streak: 0, prompt_open: false, hold_until_ide_returns: false },
            if state.prompt_open { Action::CancelPrompt } else { Action::None },
        ),
        Event::Poll { running: false } => {
            if !state.seen_ide || state.hold_until_ide_returns || state.prompt_open {
                return (state, Action::None);
            }
            let idle_streak = state.idle_streak + 1;
            if idle_streak >= IDLE_POLLS_BEFORE_PROMPT {
                (PromptState { idle_streak, prompt_open: true, ..state }, Action::ShowPrompt)
            } else {
                (PromptState { idle_streak, ..state }, Action::None)
            }
        }
    }
}

// Bumped on every sync so a loop started under an older setting stops itself.
static GENERATION: AtomicU64 = AtomicU64::new(0);

// Mirrors dialog.ideClosed.* in src/shared/i18n.ts. True = "quit".
async fn ask_quit(app: &AppHandle) -> bool {
    let language = app.state::<SettingsState>().language();
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .message(i18n::tr(&language, "dialog.ideClosed.message"))
            .title(i18n::tr(&language, "dialog.ideClosed.title"))
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCancelCustom(
                i18n::tr(&language, "dialog.ideClosed.quit").to_string(),
                i18n::tr(&language, "dialog.ideClosed.stay").to_string(),
            ))
            .blocking_show()
    })
    .await
    .unwrap_or(false)
}

// Starts or stops the watch to match the "launch with IDE" setting. Safe to call
// on every settings save.
pub fn sync(app: &AppHandle) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    if !app.state::<SettingsState>().flag("launchWithIde") {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut state = PromptState::default();
        loop {
            if GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }
            let (next, action) = reduce(state, Event::Poll { running: probe_ide_running().await });
            state = next;
            if action == Action::ShowPrompt {
                if ask_quit(&app).await {
                    // The IDE may have come back while the dialog was open.
                    if GENERATION.load(Ordering::SeqCst) == generation && !probe_ide_running().await {
                        app.exit(0);
                        return;
                    }
                    state = reduce(state, Event::PromptClosed).0;
                } else {
                    state = reduce(state, Event::ChoseStay).0;
                }
            }
            tokio::time::sleep(IDE_POLL_INTERVAL).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn poll(state: PromptState, running: bool) -> (PromptState, Action) {
        reduce(state, Event::Poll { running })
    }

    #[test]
    fn never_prompts_before_an_ide_was_seen() {
        let (state, action) = poll(PromptState::default(), false);
        assert_eq!(action, Action::None);
        assert_eq!(poll(state, false).1, Action::None);
    }

    #[test]
    fn prompts_after_two_idle_polls_and_stays_quiet_while_open() {
        let (state, _) = poll(PromptState::default(), true);
        let (state, first) = poll(state, false);
        let (state, second) = poll(state, false);
        assert_eq!((first, second), (Action::None, Action::ShowPrompt));
        assert_eq!(poll(state, false).1, Action::None);
    }

    #[test]
    fn ide_returning_cancels_the_open_prompt() {
        let (state, _) = poll(PromptState::default(), true);
        let (state, _) = poll(state, false);
        let (state, _) = poll(state, false);
        assert_eq!(poll(state, true).1, Action::CancelPrompt);
    }

    #[test]
    fn choosing_to_stay_holds_until_the_ide_returns() {
        let (state, _) = poll(PromptState::default(), true);
        let (state, _) = poll(state, false);
        let (state, _) = poll(state, false);
        let (state, _) = reduce(state, Event::ChoseStay);
        assert_eq!(poll(state, false).1, Action::None);
        let (state, _) = poll(state, true);
        let (state, _) = poll(state, false);
        assert_eq!(poll(state, false).1, Action::ShowPrompt);
    }

    #[test]
    fn codex_matchers() {
        assert!(command_line_looks_like_codex_process("/Applications/ChatGPT.app/Contents/Resources/codex app-server"));
        assert!(command_line_looks_like_codex_process("node /usr/lib/@openai/codex/bin/codex.js"));
        assert!(!command_line_looks_like_codex_process("/x/Codex Framework.framework/Helpers/crashpad_handler --db"));
        assert!(!command_line_looks_like_codex_process("/usr/bin/vim notes-codex.txt"));
        assert!(command_line_looks_like_claude_code("node /x/@anthropic-ai/claude-code/cli.js"));
    }
}
