// Tmux backend: session and window orchestration for projects and agent teams.
use crate::remote::RemoteProject;
use serde::{Deserialize, Serialize};
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxWindow {
    pub id: String,
    pub name: String,
    pub active: bool,
    pub path: String,
    // The command the window was started with and the foreground process now:
    // enough for the renderer to badge the real agent before dogwatch ticks.
    #[serde(default)]
    pub start_command: String,
    #[serde(default)]
    pub current_command: String,
}

// Generates a deterministic, valid tmux session name from a directory path.
// Tmux session names cannot contain periods, colons, or whitespace.
pub fn session_name_for_path(path: &Path) -> String {
    let raw_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("project");

    let sanitized: String = raw_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();

    // 6-character hex hash for uniqueness across paths with the same directory name
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.to_string_lossy().hash(&mut hasher);
    let hash = hasher.finish();
    format!(
        "work_{}_{:06x}",
        sanitized.trim_matches('_'),
        hash & 0xffffff
    )
}

// Checks if the tmux binary is executable in PATH.
pub fn is_available() -> bool {
    Command::new("tmux")
        .arg("-V")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// Executes a tmux command and returns stdout, or a localized Italian error message.
pub fn run_tmux(args: &[&str]) -> Result<String, String> {
    let output = Command::new("tmux")
        .args(args)
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "tmux non è installato sul sistema. Installalo con il gestore pacchetti (es. sudo pacman -S tmux o sudo apt install tmux).".to_string()
            } else {
                format!("Impossibile eseguire tmux: {e}")
            }
        })?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if err.is_empty() {
            Err(format!(
                "Comando tmux fallito con codice {:?}",
                output.status.code()
            ))
        } else {
            Err(err)
        }
    }
}

// Checks if a session with exactly this name exists ("=": no prefix match,
// so "work" does not find "work-stack").
pub fn has_session(session: &str) -> bool {
    run_tmux(&["has-session", "-t", &format!("={session}")]).is_ok()
}

// A session the user already runs under the folder's own name (e.g.
// "work-stack") is adopted; otherwise Work's own hashed session.
pub fn session_for_project(path: &Path) -> String {
    let folder = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    // tmux rewrites "." and ":" in session names: only a plain name can match.
    let plain = !folder.is_empty()
        && folder
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if plain && has_session(folder) {
        return folder.to_string();
    }
    session_name_for_path(path)
}

// `set-environment` commands chained with ";" (one tmux call) for each variable.
fn set_environment_args(vars: &[(&str, String)], scope: &[&str]) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    for (name, value) in vars {
        if !args.is_empty() {
            args.push(";".into());
        }
        args.push("set-environment".into());
        args.extend(scope.iter().map(|s| s.to_string()));
        args.extend([name.to_string(), value.clone()]);
    }
    args
}

// A tmux server outlives the app that started it: its environment and its
// sessions' keep the DISPLAY / Wayland / D-Bus values of that moment, and the
// agents started in new windows would reach no browser. Work's current ones
// are set before any session or window is created (windows already running
// keep theirs). The session scope matters too: it overrides the global one.
// The shared plugins folder travels the same way.
// The global settings credentials (Plane, Jev, custom environment) are also
// propagated so that every agent has access across projects and sessions.
pub fn sync_agent_env(session: Option<&str>) {
    let mut vars = crate::mcp::graphical_env_now();
    vars.push(crate::plugins::env());
    let agent_vars = crate::settings::agent_env_vars();
    let mut all_vars: Vec<(&str, String)> = vars;
    for (k, v) in &agent_vars {
        all_vars.push((k.as_str(), v.clone()));
    }
    let run = |scope: &[&str]| {
        let args = set_environment_args(&all_vars, scope);
        if !args.is_empty() {
            let _ = run_tmux(&args.iter().map(String::as_str).collect::<Vec<_>>());
        }
    };
    run(&["-g"]);
    if let Some(session) = session {
        run(&["-t", &format!("={session}")]);
    }
}

// Ensures a session exists for the given project path, creating a detached session if needed.
pub fn ensure_session(session: &str, cwd: &Path) -> Result<(), String> {
    let exists = has_session(session);
    sync_agent_env(exists.then_some(session));
    if exists {
        return Ok(());
    }
    let cwd_str = cwd.to_string_lossy();
    run_tmux(&[
        "new-session",
        "-d",
        "-s",
        session,
        "-c",
        &cwd_str,
        "-n",
        "shell",
    ])?;
    Ok(())
}

// Parses raw output of `tmux list-windows`.
pub fn parse_windows(raw: &str) -> Vec<TmuxWindow> {
    raw.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            let mut parts = line.splitn(6, '\t');
            let id = parts.next()?.trim().to_string();
            let name = parts.next().unwrap_or("").trim().to_string();
            let active = parts.next().map(|a| a.trim() == "1").unwrap_or(false);
            let path = parts.next().unwrap_or("").trim().to_string();
            // Older four-field output and remote tmux leave the commands empty.
            let start_command = parts.next().unwrap_or("").trim().to_string();
            let current_command = parts.next().unwrap_or("").trim().to_string();
            Some(TmuxWindow {
                id,
                name,
                active,
                path,
                start_command,
                current_command,
            })
        })
        .collect()
}

// Lists active windows in a tmux session.
pub fn list_windows(session: &str) -> Result<Vec<TmuxWindow>, String> {
    let out = run_tmux(&[
        "list-windows",
        "-t",
        session,
        "-F",
        "#{window_id}\t#{window_name}\t#{window_active}\t#{pane_current_path}\t#{pane_start_command}\t#{pane_current_command}",
    ])?;
    Ok(parse_windows(&out))
}

// Creates a new window in the session, returning the new window_id (e.g. "@1").
pub fn new_window(
    session: &str,
    name: Option<&str>,
    cwd: &Path,
    command: Option<&str>,
) -> Result<String, String> {
    sync_agent_env(Some(session));
    let cwd_str = cwd.to_string_lossy();
    let mut args = vec![
        "new-window",
        "-P",
        "-F",
        "#{window_id}",
        "-t",
        session,
        "-c",
        &cwd_str,
    ];
    let name_str;
    if let Some(n) = name {
        name_str = n;
        args.push("-n");
        args.push(name_str);
    }
    if let Some(cmd) = command {
        args.push(cmd);
    }
    let out = run_tmux(&args)?;
    Ok(out.trim().to_string())
}

// Closes a window in a session.
pub fn kill_window(session: &str, window_id: &str) -> Result<(), String> {
    let target = format!("{session}:{window_id}");
    run_tmux(&["kill-window", "-t", &target])?;
    Ok(())
}

// Closes the session with exactly this name: a missing "x_pty_1" must not
// fall back to a prefix match and kill "x_pty_12".
pub fn kill_session(session: &str) -> Result<(), String> {
    run_tmux(&["kill-session", "-t", &format!("={session}")])?;
    Ok(())
}

// Creates an isolated client session that links exactly one window of
// base_session. A grouped session (`new-session -t base`) shares the whole
// window list: when the selected window dies tmux falls back to another one of
// the group, so two rectangles would end up driving the same shell and the PTY
// would never report the exit. A standalone session with a single linked window
// has no fallback: when that window goes away the session loses its last window
// and tmux detaches the client, which ends the PTY and lets the renderer
// collapse the rectangle.
pub fn attach_client_session(
    base_session: &str,
    client_session: &str,
    window_id: &str,
) -> Result<(), String> {
    check_pane_target(window_id)?;
    let _ = kill_session(client_session);
    // A session cannot be created without a window: keep the throwaway one only
    // until the real window is linked in, then drop it.
    let initial = run_tmux(&[
        "new-session",
        "-d",
        "-P",
        "-F",
        "#{window_id}",
        "-s",
        client_session,
    ])?;
    let initial = initial.trim();
    if !initial.starts_with('@') {
        let _ = kill_session(client_session);
        return Err(format!(
            "tmux non ha creato la sessione client {client_session}: {initial}"
        ));
    }
    let source = format!("{base_session}:{window_id}");
    if let Err(err) = run_tmux(&["link-window", "-s", &source, "-t", client_session]) {
        let _ = kill_session(client_session);
        return Err(err);
    }
    let _ = run_tmux(&["kill-window", "-t", &format!("{client_session}:{initial}")]);
    let target = format!("{client_session}:{window_id}");
    let _ = run_tmux(&["select-window", "-t", &target]);
    let _ = run_tmux(&["set-option", "-t", client_session, "status", "off"]);
    Ok(())
}

// Sends keystrokes to a target window or pane, followed by Enter (C-m).
pub fn send_keys(session: &str, target: &str, keys: &str) -> Result<(), String> {
    let full_target = format!("{session}:{target}");
    run_tmux(&["send-keys", "-t", &full_target, keys, "C-m"])?;
    Ok(())
}

// Captures terminal scrollback buffer lines from a pane.
pub fn capture_pane(session: &str, target: &str, lines: Option<u32>) -> Result<String, String> {
    let full_target = format!("{session}:{target}");
    let lines_str;
    let mut args = vec!["capture-pane", "-p", "-t", &full_target];
    if let Some(l) = lines {
        lines_str = format!("-{l}");
        args.push("-S");
        args.push(&lines_str);
    }
    run_tmux(&args)
}

// ── Split panes ──────────────────────────────────────────────
//
// Every terminal rectangle in Work is backed by its own tmux *window*, each
// holding one pane. A tmux window shares its active pane with every client
// attached to it, so two clients on the same window would mirror each other;
// one window per rectangle is what keeps input, output and scrollback
// isolated. The split direction is a renderer concern (where the new
// rectangle goes); tmux places the new window right after the source one.

// The public directions the renderer may ask for; anything else is a bug and
// must never reach tmux as an option.
pub fn normalize_direction(direction: &str) -> Result<&'static str, String> {
    match direction {
        "horizontal" | "h" | "right" => Ok("horizontal"),
        "vertical" | "v" | "down" => Ok("vertical"),
        _ => Err(format!(
            "Direzione di split non valida: {direction}. Usa \"horizontal\" o \"vertical\"."
        )),
    }
}

// A pane/window target is passed to tmux as a single argv entry, but a leading
// '-' would still be read as an option and a control character could corrupt
// tmux's output.
fn check_pane_target(target: &str) -> Result<(), String> {
    let valid = !target.is_empty()
        && target.len() <= 128
        && !target.starts_with('-')
        && !target.chars().any(char::is_control);
    if valid {
        Ok(())
    } else {
        Err(format!("Target tmux non valido: {target}"))
    }
}

fn pane_target(session: &str, target: &str) -> Result<String, String> {
    check_pane_target(target)?;
    if target.starts_with('%') {
        // Pane ids are global: "session:%1" is not a valid tmux target.
        Ok(target.to_string())
    } else {
        Ok(format!("{session}:{target}"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxPaneInfo {
    pub pane_id: String,
    // The renderer creates the PTY after this call; kept in the contract so a
    // future backend-created pane can fill it.
    pub pty_id: String,
    pub width: u16,
    pub height: u16,
    // The tmux window the renderer must attach the new xterm to.
    pub window_id: String,
}

// Parses the `#{window_id}\t#{pane_id}\t#{pane_width}\t#{pane_height}` line.
pub fn parse_pane_info(raw: &str, pty_id: &str) -> Result<TmuxPaneInfo, String> {
    let line = raw.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        return Err("tmux non ha restituito una finestra per il nuovo pannello.".into());
    }
    let mut parts = line.split('\t');
    let window_id = parts.next().unwrap_or("").trim().to_string();
    let pane_id = parts.next().unwrap_or("").trim().to_string();
    let width = parts
        .next()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0);
    let height = parts
        .next()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0);
    if !window_id.starts_with('@') || !pane_id.starts_with('%') {
        return Err(format!("tmux non ha restituito un pannello valido: {line}"));
    }
    Ok(TmuxPaneInfo {
        pane_id,
        pty_id: pty_id.to_string(),
        width,
        height,
        window_id,
    })
}

// Opens a sibling window after `window`, in the source pane's current folder.
pub fn split_window(session: &str, window: &str, direction: &str) -> Result<TmuxPaneInfo, String> {
    normalize_direction(direction)?;
    check_pane_target(window)?;
    let source = format!("{session}:{window}");
    let cwd = run_tmux(&[
        "display-message",
        "-p",
        "-t",
        &source,
        "#{pane_current_path}",
    ])
    .map(|s| s.trim().to_string())
    .unwrap_or_default();
    let mut args = vec![
        "new-window",
        "-P",
        "-F",
        "#{window_id}\t#{pane_id}\t#{pane_width}\t#{pane_height}",
        "-t",
        &source,
        "-a",
    ];
    if !cwd.is_empty() {
        args.push("-c");
        args.push(&cwd);
    }
    let out = run_tmux(&args)?;
    parse_pane_info(&out, "")
}

// Resizes a pane (or the sole pane of a window) to an exact character grid.
pub fn resize_pane(session: &str, target: &str, cols: u16, rows: u16) -> Result<(), String> {
    if cols == 0 || rows == 0 {
        return Err(
            "Dimensioni del pannello non valide: righe e colonne devono essere maggiori di zero."
                .into(),
        );
    }
    let target = pane_target(session, target)?;
    let (cols, rows) = (cols.to_string(), rows.to_string());
    run_tmux(&["resize-pane", "-t", &target, "-x", &cols, "-y", &rows])?;
    Ok(())
}

// Toggles tmux's zoom for the pane: the same gesture as the renderer's
// maximize, applied to the native layout.
pub fn zoom_pane(session: &str, target: &str) -> Result<(), String> {
    let target = pane_target(session, target)?;
    run_tmux(&["resize-pane", "-Z", "-t", &target])?;
    Ok(())
}

// Closes a pane; a window whose last pane goes away disappears with it.
pub fn kill_pane(session: &str, target: &str) -> Result<(), String> {
    let target = pane_target(session, target)?;
    run_tmux(&["kill-pane", "-t", &target])?;
    Ok(())
}

// ── IPC Commands ─────────────────────────────────────────────

#[tauri::command]
pub fn tmux_is_available() -> bool {
    is_available()
}

#[tauri::command]
pub fn tmux_session_for_project(path: String, remote: Option<RemoteProject>) -> String {
    match remote {
        Some(remote) => crate::remote::session_name(&remote),
        None => session_for_project(Path::new(&path)),
    }
}

#[tauri::command(async)]
pub fn tmux_ensure_session(
    session: String,
    cwd: String,
    remote: Option<RemoteProject>,
) -> Result<(), String> {
    match remote {
        Some(remote) => crate::remote::ensure_session(&remote, &session, &cwd),
        None => ensure_session(&session, Path::new(&cwd)),
    }
}

#[tauri::command(async)]
pub fn tmux_list_windows(
    session: String,
    remote: Option<RemoteProject>,
) -> Result<Vec<TmuxWindow>, String> {
    match remote {
        Some(remote) => crate::remote::list_windows(&remote, &session),
        None => list_windows(&session),
    }
}

#[tauri::command(async)]
pub fn tmux_new_window(
    session: String,
    name: Option<String>,
    cwd: String,
    command: Option<String>,
    remote: Option<RemoteProject>,
) -> Result<String, String> {
    match remote {
        Some(remote) => {
            crate::remote::new_window(&remote, &session, name.as_deref(), &cwd, command.as_deref())
        }
        None => new_window(
            &session,
            name.as_deref(),
            Path::new(&cwd),
            command.as_deref(),
        ),
    }
}

#[tauri::command(async)]
pub fn tmux_kill_window(
    session: String,
    window_id: String,
    remote: Option<RemoteProject>,
) -> Result<(), String> {
    match remote {
        Some(remote) => crate::remote::kill_window(&remote, &session, &window_id),
        None => kill_window(&session, &window_id),
    }
}

#[tauri::command(async)]
pub fn tmux_kill_session(session: String, remote: Option<RemoteProject>) -> Result<(), String> {
    match remote {
        Some(remote) => crate::remote::kill_session(&remote, &session),
        None => kill_session(&session),
    }
}

#[tauri::command(async)]
pub fn tmux_send_keys(
    session: String,
    target: String,
    keys: String,
    remote: Option<RemoteProject>,
) -> Result<(), String> {
    match remote {
        Some(remote) => crate::remote::send_keys(&remote, &session, &target, &keys),
        None => send_keys(&session, &target, &keys),
    }
}

#[tauri::command(async)]
pub fn tmux_capture_pane(
    session: String,
    target: String,
    lines: Option<u32>,
    remote: Option<RemoteProject>,
) -> Result<String, String> {
    match remote {
        Some(remote) => crate::remote::capture_pane(&remote, &session, &target, lines),
        None => capture_pane(&session, &target, lines),
    }
}

#[tauri::command(async)]
pub fn tmux_split_pane(
    session: String,
    window: String,
    direction: String,
    remote: Option<RemoteProject>,
) -> Result<TmuxPaneInfo, String> {
    match remote {
        Some(remote) => crate::remote::split_window(&remote, &session, &window, &direction),
        None => split_window(&session, &window, &direction),
    }
}

#[tauri::command(async)]
pub fn tmux_resize_pane(
    session: String,
    target: String,
    cols: u16,
    rows: u16,
    remote: Option<RemoteProject>,
) -> Result<(), String> {
    match remote {
        Some(remote) => crate::remote::resize_pane(&remote, &session, &target, cols, rows),
        None => resize_pane(&session, &target, cols, rows),
    }
}

#[tauri::command(async)]
pub fn tmux_zoom_pane(
    session: String,
    target: String,
    remote: Option<RemoteProject>,
) -> Result<(), String> {
    match remote {
        Some(remote) => crate::remote::zoom_pane(&remote, &session, &target),
        None => zoom_pane(&session, &target),
    }
}

#[tauri::command(async)]
pub fn tmux_close_pane(
    session: String,
    target: String,
    remote: Option<RemoteProject>,
) -> Result<(), String> {
    match remote {
        Some(remote) => crate::remote::kill_pane(&remote, &session, &target),
        None => kill_pane(&session, &target),
    }
}

// ── Tests ────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_session_name_is_deterministic_and_sanitized() {
        let p1 = Path::new("/home/user/projects/my-app.v2");
        let name1 = session_name_for_path(p1);
        let name2 = session_name_for_path(p1);
        assert_eq!(name1, name2, "session name must be deterministic");

        assert!(name1.starts_with("work_my-app_v2_"));
        assert!(!name1.contains('.'));
        assert!(!name1.contains(':'));
        assert!(!name1.contains('/'));
        assert!(!name1.contains(' '));

        let p2 = Path::new("/var/workspace/my-app.v2");
        let name3 = session_name_for_path(p2);
        assert_ne!(
            name1, name3,
            "different paths with same folder name must yield different hash"
        );
    }

    #[test]
    fn test_parse_windows_output() {
        let raw = "\
@0\tpm\t1\t/home/flavio/workspace/work-stack\tagy --dangerously-skip-permissions\tagy\n\
@1\tdev1\t0\t/home/flavio/workspace/work-stack\tollama launch opencode --model x\tollama\n\
@2\tqa\t0\t/home/flavio/workspace/work-stack\tcodex --yolo\tcodex\n";

        let windows = parse_windows(raw);
        assert_eq!(windows.len(), 3);
        assert_eq!(windows[0].id, "@0");
        assert_eq!(windows[0].name, "pm");
        assert!(windows[0].active);
        assert_eq!(windows[0].path, "/home/flavio/workspace/work-stack");
        assert_eq!(
            windows[0].start_command,
            "agy --dangerously-skip-permissions"
        );
        assert_eq!(windows[0].current_command, "agy");

        assert_eq!(windows[1].id, "@1");
        assert_eq!(windows[1].name, "dev1");
        assert!(!windows[1].active);
        assert_eq!(windows[1].start_command, "ollama launch opencode --model x");

        assert_eq!(windows[2].id, "@2");
        assert_eq!(windows[2].name, "qa");
        assert!(!windows[2].active);
        assert_eq!(windows[2].current_command, "codex");
    }

    #[test]
    fn a_qa_window_running_opencode_carries_its_real_command_regression() {
        // The badge must follow the command, not the role default (qa -> codex).
        let raw = "@3\tqa1\t1\t/p\tollama launch opencode --model deepseek\tollama\n";
        let windows = parse_windows(raw);
        assert_eq!(
            windows[0].start_command,
            "ollama launch opencode --model deepseek"
        );
        assert_eq!(windows[0].current_command, "ollama");
    }

    #[test]
    fn test_parse_windows_empty_or_broken() {
        assert_eq!(parse_windows("").len(), 0);
        assert_eq!(parse_windows("   \n\n  ").len(), 0);

        let partial = "@5\tshell\n";
        let parsed = parse_windows(partial);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].id, "@5");
        assert_eq!(parsed[0].name, "shell");
        assert!(!parsed[0].active);
        assert_eq!(parsed[0].path, "");
    }

    #[test]
    fn test_tmux_availability_and_session_helpers() {
        if !is_available() {
            return;
        }
        let test_session = format!(
            "test_tmux_unit_{:x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/tmp"));
        let res = ensure_session(&test_session, &cwd);
        assert!(res.is_ok());
        assert!(has_session(&test_session));

        let client = format!("{test_session}_client");
        let attach_res = attach_client_session(&test_session, &client, "shell");
        assert!(attach_res.is_ok());
        assert!(has_session(&client));

        let _ = kill_session(&client);
        let _ = kill_session(&test_session);
        assert!(!has_session(&client));
        assert!(!has_session(&test_session));
    }

    #[test]
    fn client_session_hides_status_bar_but_base_session_keeps_it() {
        if !is_available() {
            return;
        }
        let base = unique("wsstatus_");
        let client = format!("{base}_client");
        ensure_session(&base, Path::new("/tmp")).unwrap();
        let window = list_windows(&base).unwrap().remove(0).id;
        let attached = attach_client_session(&base, &client, &window);

        let client_status = run_tmux(&["show-options", "-v", "-t", &client, "status"]);
        let base_status = run_tmux(&["show-options", "-v", "-t", &base, "status"]);
        let _ = kill_session(&client);
        let _ = kill_session(&base);

        assert!(attached.is_ok());
        assert_eq!(client_status.unwrap().trim(), "off");
        assert_ne!(base_status.unwrap_or_default().trim(), "off");
    }

    #[test]
    fn environment_commands_are_chained_in_one_call() {
        let vars = [
            ("DISPLAY", ":1".to_string()),
            ("XDG_RUNTIME_DIR", "/run/user/1".to_string()),
        ];
        assert_eq!(
            set_environment_args(&vars, &["-g"]),
            [
                "set-environment",
                "-g",
                "DISPLAY",
                ":1",
                ";",
                "set-environment",
                "-g",
                "XDG_RUNTIME_DIR",
                "/run/user/1"
            ]
        );
        assert!(set_environment_args(&[], &["-g"]).is_empty());
    }

    #[test]
    fn a_new_window_gets_works_environment_not_a_stale_session_one_regression() {
        let Some((name, current)) = crate::mcp::graphical_env_now().into_iter().next() else {
            return;
        };
        if !is_available() {
            return;
        }
        let session = unique("wsenv_");
        ensure_session(&session, Path::new("/tmp")).unwrap();
        let stale = [(name, "stale-value".to_string())];
        let args = set_environment_args(&stale, &["-t", &format!("={session}")]);
        run_tmux(&args.iter().map(String::as_str).collect::<Vec<_>>()).unwrap();

        let command = format!("echo \"got=${name}\"; sleep 30");
        let window =
            new_window(&session, Some("probe"), Path::new("/tmp"), Some(&command)).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        let shown = capture_pane(&session, &window, None).unwrap();
        let _ = kill_session(&session);
        assert!(shown.contains(&format!("got={current}")), "{shown}");
    }

    fn unique(prefix: &str) -> String {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        format!("{prefix}{nanos:x}")
    }

    #[test]
    fn a_session_named_like_the_project_folder_is_adopted() {
        if !is_available() {
            return;
        }
        let folder = unique("wsproj_");
        let path = PathBuf::from("/tmp/somewhere").join(&folder);
        assert_eq!(
            session_for_project(&path),
            session_name_for_path(&path),
            "no session yet: Work's own name"
        );

        ensure_session(&folder, Path::new("/tmp")).unwrap();
        let adopted = session_for_project(&path);
        let _ = kill_session(&folder);
        assert_eq!(adopted, folder);
    }

    #[test]
    fn session_lookups_and_kills_never_match_by_prefix_regression() {
        if !is_available() {
            return;
        }
        let folder = unique("wsprefix_");
        let longer = format!("{folder}-other");
        ensure_session(&longer, Path::new("/tmp")).unwrap();
        let path = PathBuf::from("/tmp").join(&folder);

        let found = has_session(&folder);
        let resolved = session_for_project(&path);
        let killed = kill_session(&folder).is_ok();
        let survived = has_session(&longer);
        let _ = kill_session(&longer);

        assert!(!found, "\"{folder}\" is not \"{longer}\"");
        assert_eq!(resolved, session_name_for_path(&path));
        assert!(
            !killed && survived,
            "killing a missing session leaves the longer one alone"
        );
    }

    #[test]
    fn a_folder_name_tmux_cannot_use_as_is_falls_back_to_the_canonical_name() {
        for name in ["my.app", "a:b", "con spazi", ""] {
            let path = PathBuf::from("/tmp").join(name);
            assert_eq!(
                session_for_project(&path),
                session_name_for_path(&path),
                "{name:?}"
            );
        }
    }

    #[test]
    fn split_direction_accepts_only_the_two_public_values() {
        assert_eq!(normalize_direction("horizontal").unwrap(), "horizontal");
        assert_eq!(normalize_direction("right").unwrap(), "horizontal");
        assert_eq!(normalize_direction("vertical").unwrap(), "vertical");
        assert_eq!(normalize_direction("down").unwrap(), "vertical");
        assert!(normalize_direction("diagonal").is_err());
        assert!(normalize_direction("-h").is_err());
    }

    #[test]
    fn pane_info_is_parsed_from_the_tmux_format() {
        let info = parse_pane_info("@4\t%9\t120\t36\n", "pty-7").unwrap();
        assert_eq!(info.window_id, "@4");
        assert_eq!(info.pane_id, "%9");
        assert_eq!(info.width, 120);
        assert_eq!(info.height, 36);
        assert_eq!(info.pty_id, "pty-7");

        assert!(parse_pane_info("", "").is_err());
        assert!(parse_pane_info("nonsense", "").is_err());
    }

    #[test]
    fn pane_targets_never_start_with_a_dash() {
        assert_eq!(pane_target("work_x", "@3").unwrap(), "work_x:@3");
        assert_eq!(pane_target("work_x", "%5").unwrap(), "%5");
        assert!(pane_target("work_x", "-h").is_err());
        assert!(pane_target("work_x", "").is_err());
    }

    fn client_windows(client: &str) -> Vec<String> {
        run_tmux(&["list-windows", "-t", client, "-F", "#{window_id}"])
            .unwrap_or_default()
            .lines()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty())
            .collect()
    }

    fn current_window(client: &str) -> String {
        run_tmux(&["display-message", "-p", "-t", client, "#{window_id}"])
            .unwrap_or_default()
            .trim()
            .to_string()
    }

    #[test]
    fn a_client_session_links_only_its_window_and_ends_when_it_exits_regression() {
        // QA regression: a grouped client stayed attached to the group and
        // switched to another window when its shell exited, so the rectangle
        // never collapsed and two terminals drove the same shell.
        if !is_available() {
            return;
        }
        let base = unique("wsclient_");
        ensure_session(&base, Path::new("/tmp")).unwrap();
        let first = list_windows(&base).unwrap().remove(0).id;
        let second = new_window(&base, Some("probe"), Path::new("/tmp"), Some("sh")).unwrap();
        let (c0, c1) = (format!("{base}_c0"), format!("{base}_c1"));

        attach_client_session(&base, &c0, &first).unwrap();
        attach_client_session(&base, &c1, &second).unwrap();

        assert_eq!(
            client_windows(&c0),
            vec![first.clone()],
            "no leftover window"
        );
        assert_eq!(
            client_windows(&c1),
            vec![second.clone()],
            "the client links one window only"
        );
        assert_eq!(current_window(&c0), first);
        assert_eq!(current_window(&c1), second);

        send_keys(&base, &second, "exit").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while has_session(&c1) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        assert!(
            !has_session(&c1),
            "the client session ends with its only window instead of switching"
        );
        assert!(has_session(&c0), "the other terminal stays isolated");
        assert_eq!(
            current_window(&c0),
            first,
            "it never follows another window"
        );
        assert!(
            !list_windows(&base).unwrap().iter().any(|w| w.id == second),
            "the shell's window is gone"
        );

        let _ = kill_session(&c0);
        let _ = kill_session(&base);
    }

    #[test]
    fn splitting_creates_a_sibling_window_that_resizes_and_closes() {
        if !is_available() {
            return;
        }
        let session = unique("wssplit_");
        ensure_session(&session, Path::new("/tmp")).unwrap();
        let source = list_windows(&session).unwrap().remove(0).id;

        let info = split_window(&session, &source, "horizontal").unwrap();
        assert_ne!(info.window_id, source, "a new independent window");
        assert!(info.pane_id.starts_with('%'));
        assert!(info.width > 0 && info.height > 0, "{info:?}");

        let windows = list_windows(&session).unwrap();
        assert_eq!(windows.len(), 2, "both rectangles stay alive");
        assert!(windows.iter().any(|w| w.id == info.window_id));

        // The renderer resizes through the PTY; these commands keep tmux in
        // sync when the user drags a splitter.
        assert!(resize_pane(&session, &info.window_id, 100, 30).is_ok());
        assert!(zoom_pane(&session, &info.window_id).is_ok());
        assert!(kill_pane(&session, &info.window_id).is_ok());
        assert!(!list_windows(&session)
            .unwrap()
            .iter()
            .any(|w| w.id == info.window_id));

        let _ = kill_session(&session);
    }
}
