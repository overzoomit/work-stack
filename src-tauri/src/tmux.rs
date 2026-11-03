// Tmux backend: session and window orchestration for projects and agent teams.
use crate::remote::RemoteProject;
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
fn sync_agent_env(session: Option<&str>) {
    let mut vars = crate::mcp::graphical_env_now();
    vars.push(crate::plugins::env());
    let run = |scope: &[&str]| {
        let args = set_environment_args(&vars, scope);
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
    let _ = run_tmux(&["set-option", "-t", client_session, "status", "off"]);
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
        Some(remote) => crate::remote::new_window(
            &remote,
            &session,
            name.as_deref(),
            &cwd,
            command.as_deref(),
        ),
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

    #[test]
    fn client_session_hides_status_bar_but_base_session_keeps_it() {
        if !is_available() {
            return;
        }
        let base = unique("wsstatus_");
        let client = format!("{base}_client");
        ensure_session(&base, Path::new("/tmp")).unwrap();
        let attached = attach_client_session(&base, &client, "0");

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
        let vars = [("DISPLAY", ":1".to_string()), ("XDG_RUNTIME_DIR", "/run/user/1".to_string())];
        assert_eq!(
            set_environment_args(&vars, &["-g"]),
            ["set-environment", "-g", "DISPLAY", ":1", ";", "set-environment", "-g", "XDG_RUNTIME_DIR", "/run/user/1"]
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
        let window = new_window(&session, Some("probe"), Path::new("/tmp"), Some(&command)).unwrap();
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
        assert_eq!(session_for_project(&path), session_name_for_path(&path), "no session yet: Work's own name");

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
        assert!(!killed && survived, "killing a missing session leaves the longer one alone");
    }

    #[test]
    fn a_folder_name_tmux_cannot_use_as_is_falls_back_to_the_canonical_name() {
        for name in ["my.app", "a:b", "con spazi", ""] {
            let path = PathBuf::from("/tmp").join(name);
            assert_eq!(session_for_project(&path), session_name_for_path(&path), "{name:?}");
        }
    }
}
