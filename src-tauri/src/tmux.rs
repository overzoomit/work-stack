// Tmux backend: session and window orchestration for projects and agent teams.
use serde::{Deserialize, Serialize};
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TmuxWindow {
    pub id: String,
    pub name: String,
    pub active: bool,
    pub path: String,
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

// Checks if a given session exists.
pub fn has_session(session: &str) -> bool {
    run_tmux(&["has-session", "-t", session]).is_ok()
}

// Ensures a session exists for the given project path, creating a detached session if needed.
pub fn ensure_session(session: &str, cwd: &Path) -> Result<(), String> {
    if has_session(session) {
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

// Parses raw output of `tmux list-windows -F "#{window_id}\t#{window_name}\t#{window_active}\t#{pane_current_path}"`.
pub fn parse_windows(raw: &str) -> Vec<TmuxWindow> {
    raw.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            let mut parts = line.split('\t');
            let id = parts.next()?.trim().to_string();
            let name = parts.next().unwrap_or("").trim().to_string();
            let active = parts.next().map(|a| a.trim() == "1").unwrap_or(false);
            let path = parts.next().unwrap_or("").trim().to_string();
            Some(TmuxWindow {
                id,
                name,
                active,
                path,
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
        "#{window_id}\t#{window_name}\t#{window_active}\t#{pane_current_path}",
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

// Closes a tmux session.
pub fn kill_session(session: &str) -> Result<(), String> {
    run_tmux(&["kill-session", "-t", session])?;
    Ok(())
}

// Creates an isolated grouped session linked to base_session and focused on window_id.
pub fn attach_client_session(
    base_session: &str,
    client_session: &str,
    window_id: &str,
) -> Result<(), String> {
    let _ = kill_session(client_session);
    run_tmux(&[
        "new-session",
        "-d",
        "-t",
        base_session,
        "-s",
        client_session,
    ])?;
    let target = format!("{client_session}:{window_id}");
    let _ = run_tmux(&["select-window", "-t", &target]);
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

// ── IPC Commands ─────────────────────────────────────────────

#[tauri::command]
pub fn tmux_is_available() -> bool {
    is_available()
}

#[tauri::command]
pub fn tmux_session_for_project(path: String) -> String {
    session_name_for_path(Path::new(&path))
}

#[tauri::command]
pub fn tmux_ensure_session(session: String, cwd: String) -> Result<(), String> {
    ensure_session(&session, Path::new(&cwd))
}

#[tauri::command]
pub fn tmux_list_windows(session: String) -> Result<Vec<TmuxWindow>, String> {
    list_windows(&session)
}

#[tauri::command]
pub fn tmux_new_window(
    session: String,
    name: Option<String>,
    cwd: String,
    command: Option<String>,
) -> Result<String, String> {
    new_window(
        &session,
        name.as_deref(),
        Path::new(&cwd),
        command.as_deref(),
    )
}

#[tauri::command]
pub fn tmux_kill_window(session: String, window_id: String) -> Result<(), String> {
    kill_window(&session, &window_id)
}

#[tauri::command]
pub fn tmux_kill_session(session: String) -> Result<(), String> {
    kill_session(&session)
}

#[tauri::command]
pub fn tmux_send_keys(session: String, target: String, keys: String) -> Result<(), String> {
    send_keys(&session, &target, &keys)
}

#[tauri::command]
pub fn tmux_capture_pane(
    session: String,
    target: String,
    lines: Option<u32>,
) -> Result<String, String> {
    capture_pane(&session, &target, lines)
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
@0\tpm\t1\t/home/flavio/workspace/work-stack\n\
@1\tdev1\t0\t/home/flavio/workspace/work-stack\n\
@2\tqa\t0\t/home/flavio/workspace/work-stack\n";

        let windows = parse_windows(raw);
        assert_eq!(windows.len(), 3);
        assert_eq!(windows[0].id, "@0");
        assert_eq!(windows[0].name, "pm");
        assert!(windows[0].active);
        assert_eq!(windows[0].path, "/home/flavio/workspace/work-stack");

        assert_eq!(windows[1].id, "@1");
        assert_eq!(windows[1].name, "dev1");
        assert!(!windows[1].active);

        assert_eq!(windows[2].id, "@2");
        assert_eq!(windows[2].name, "qa");
        assert!(!windows[2].active);
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
}
