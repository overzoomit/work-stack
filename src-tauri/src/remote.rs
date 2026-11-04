// Remote projects: validated SSH settings, remote tmux orchestration and the
// script a PTY runs over `ssh -t`. Everything that reaches the remote shell is
// single-quoted: a host, path or session name can never inject commands.
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

const CONNECT_TIMEOUT_SECS: u32 = 10;
const STATUS_TIMEOUT: Duration = Duration::from_secs(12);
const POLL_INTERVAL: Duration = Duration::from_millis(20);
const MAX_PATH_LEN: usize = 4096;
const MAX_SESSION_LEN: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProject {
    pub host: String,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    pub remote_path: String,
    #[serde(default)]
    pub session_name: Option<String>,
}

fn is_simple_name(s: &str, allow_dot: bool) -> bool {
    !s.is_empty()
        && s.len() <= 255
        && !s.starts_with('-')
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || (allow_dot && c == '.'))
}

fn is_session_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= MAX_SESSION_LEN
        && !s.starts_with('-')
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

impl RemoteProject {
    pub fn validate(&self) -> Result<(), String> {
        if !is_simple_name(self.host.trim(), true) {
            return Err(
                "Host non valido: usa un alias SSH o un indirizzo IP senza spazi o caratteri di shell."
                    .into(),
            );
        }
        if let Some(user) = self.user.as_deref().filter(|u| !u.is_empty()) {
            if !is_simple_name(user, false) {
                return Err(
                    "Utente SSH non valido: sono ammessi lettere, numeri, '-' e '_'.".into(),
                );
            }
        }
        if self.port == Some(0) {
            return Err("Porta SSH non valida: usa un valore tra 1 e 65535.".into());
        }
        if !self.remote_path.starts_with('/') {
            return Err("Il percorso remoto deve essere assoluto (iniziare con '/').".into());
        }
        if self.remote_path.len() > MAX_PATH_LEN || self.remote_path.chars().any(char::is_control) {
            return Err(
                "Percorso remoto non valido: caratteri di controllo o lunghezza eccessiva.".into(),
            );
        }
        if let Some(session) = self.session_name.as_deref().filter(|s| !s.is_empty()) {
            if !is_session_name(session) {
                return Err(
                    "Nome sessione tmux non valido: lettere, numeri, '-' e '_' (massimo 64)."
                        .into(),
                );
            }
        }
        Ok(())
    }

    fn user(&self) -> Option<&str> {
        self.user
            .as_deref()
            .map(str::trim)
            .filter(|u| !u.is_empty())
    }

    fn port(&self) -> u16 {
        self.port.unwrap_or(22)
    }

    pub fn target(&self) -> String {
        match self.user() {
            Some(user) => format!("{user}@{}", self.host.trim()),
            None => self.host.trim().to_string(),
        }
    }
}

// Shell-quote one argument for the remote POSIX shell. Always quoted, so even
// a harmless-looking path is never re-interpreted by the shell.
pub fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn check_session(session: &str) -> Result<(), String> {
    if is_session_name(session) {
        Ok(())
    } else {
        Err(format!("Nome sessione tmux non valido: {session}"))
    }
}

// A tmux window target is `<session>:<window>`: the name may contain spaces
// (team roles or a readable title), but never a colon, a control character or
// a leading '-' that tmux could read as an option.
fn check_target(target: &str) -> Result<(), String> {
    let valid = !target.is_empty()
        && target.len() <= 128
        && !target.starts_with('-')
        && !target.chars().any(|c| c == ':' || c.is_control());
    if valid {
        Ok(())
    } else {
        Err(format!("Finestra tmux remota non valida: {target}"))
    }
}

// Deterministic session name from the remote identity. The same project keeps
// the same session across app restarts, including after a reboot of the VM.
// FNV-1a over the remote identity, with a separator between fields. Unlike
// DefaultHasher it is part of this source, so a future Rust version cannot
// silently change the session name and orphan the agents already running.
fn stable_hash(parts: &[&str]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for part in parts {
        for byte in part.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        hash ^= 0xff;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

pub fn session_name(remote: &RemoteProject) -> String {
    if let Some(custom) = remote
        .session_name
        .as_deref()
        .map(str::trim)
        .filter(|s| is_session_name(s))
    {
        return custom.to_string();
    }
    let folder = remote
        .remote_path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("remote");
    let base: String = folder
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let base = base.trim_matches('_');
    let base = if base.is_empty() { "remote" } else { base };
    let identity = format!(
        "{}@{}:{}",
        remote.user().unwrap_or(""),
        remote.host.trim(),
        remote.port()
    );
    let hash = stable_hash(&[&identity, &remote.remote_path]);
    format!("work_{base}_{:06x}", hash & 0xffffff)
}

// ssh options shared by the PTY attach (tty) and the tmux management calls.
// `BatchMode` on management calls makes a missing key fail fast instead of
// waiting forever for a password on a tty the backend does not have.
pub fn ssh_args(remote: &RemoteProject, tty: bool) -> Vec<String> {
    let mut args = vec![
        "-o".to_string(),
        format!("ConnectTimeout={CONNECT_TIMEOUT_SECS}"),
        "-o".to_string(),
        "ServerAliveInterval=15".to_string(),
        "-o".to_string(),
        "ServerAliveCountMax=3".to_string(),
    ];
    if tty {
        args.push("-t".into());
    } else {
        args.push("-o".into());
        args.push("BatchMode=yes".into());
    }
    if let Some(port) = remote.port {
        args.push("-p".into());
        args.push(port.to_string());
    }
    if let Some(user) = remote.user() {
        args.push("-l".into());
        args.push(user.to_string());
    }
    args.push(remote.target());
    args
}

fn wait_with_timeout(child: &mut Child, timeout: Duration) -> std::io::Result<Option<ExitStatus>> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

// Runs one remote script and returns its stdout. A dead or unreachable host
// ends in an Italian error after STATUS_TIMEOUT instead of holding a UI call.
fn run_script(remote: &RemoteProject, script: &str, timeout: Duration) -> Result<String, String> {
    remote.validate()?;
    let mut command = Command::new("ssh");
    command
        .args(ssh_args(remote, false))
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "ssh non è installato sul sistema.".to_string()
        } else {
            format!("Impossibile avviare ssh: {e}")
        }
    })?;
    let mut stdout = child.stdout.take().expect("stdout piped");
    let mut stderr = child.stderr.take().expect("stderr piped");
    let out = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        text
    });
    let err = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text);
        text
    });
    let status = wait_with_timeout(&mut child, timeout)
        .map_err(|e| format!("Errore durante l'esecuzione di ssh: {e}"))?;
    let out = out.join().unwrap_or_default();
    let err = err.join().unwrap_or_default();
    match status {
        None => Err(format!(
            "Timeout della connessione SSH verso {} ({} s).",
            remote.target(),
            timeout.as_secs()
        )),
        Some(s) if s.success() => Ok(out.trim_end().to_string()),
        Some(s) => {
            let err = err.trim();
            if err.is_empty() {
                Err(format!("Comando remoto fallito con codice {:?}.", s.code()))
            } else {
                Err(err.to_string())
            }
        }
    }
}

pub fn ensure_session(remote: &RemoteProject, session: &str, cwd: &str) -> Result<(), String> {
    check_session(session)?;
    let script = format!(
        "tmux has-session -t {} 2>/dev/null || tmux new-session -d -s {} -c {} -n shell",
        quote(&format!("={session}")),
        quote(session),
        quote(cwd)
    );
    run_script(remote, &script, STATUS_TIMEOUT).map(|_| ())
}

// A tab is a control character: under a POSIX locale tmux rewrites it to '_'
// before the bytes ever reach SSH. Use a printable separator instead; the
// window name cannot contain ':' (check_target rejects it) and the path is the
// last field, so a ':' inside it is preserved by splitn(4).
const REMOTE_WINDOW_FORMAT: &str =
    "#{window_id}:#{window_name}:#{window_active}:#{pane_current_path}";

pub fn parse_remote_windows(raw: &str) -> Vec<crate::tmux::TmuxWindow> {
    raw.lines()
        .filter_map(|line| {
            let line = line.trim_end_matches('\r');
            if line.is_empty() {
                return None;
            }
            let mut parts = line.splitn(4, ':');
            let id = parts.next()?.trim().to_string();
            let name = parts.next().unwrap_or("").trim().to_string();
            let active = parts.next().map(|a| a.trim() == "1").unwrap_or(false);
            let path = parts.next().unwrap_or("").trim().to_string();
            Some(crate::tmux::TmuxWindow {
                id,
                name,
                active,
                path,
                // Remote sessions do not carry the commands yet: dogwatch and
                // the local pane detection fill the agent badge instead.
                start_command: String::new(),
                current_command: String::new(),
            })
        })
        .collect()
}

pub fn list_windows(
    remote: &RemoteProject,
    session: &str,
) -> Result<Vec<crate::tmux::TmuxWindow>, String> {
    check_session(session)?;
    let script = format!(
        "tmux list-windows -t {} -F '{}'",
        quote(session),
        REMOTE_WINDOW_FORMAT
    );
    let out = run_script(remote, &script, STATUS_TIMEOUT)?;
    Ok(parse_remote_windows(&out))
}

pub fn new_window(
    remote: &RemoteProject,
    session: &str,
    name: Option<&str>,
    cwd: &str,
    command: Option<&str>,
) -> Result<String, String> {
    check_session(session)?;
    if let Some(name) = name {
        check_target(name)?;
    }
    let mut script = format!(
        "tmux new-window -P -F '#{{window_id}}' -t {} -c {}",
        quote(session),
        quote(cwd)
    );
    if let Some(name) = name {
        script.push_str(&format!(" -n {}", quote(name)));
    }
    if let Some(command) = command {
        if command.contains('\0') {
            return Err("Comando non valido: contiene un byte nullo.".into());
        }
        script.push(' ');
        script.push_str(&quote(command));
    }
    let out = run_script(remote, &script, STATUS_TIMEOUT)?;
    let id = out.trim().to_string();
    if !id.starts_with('@') || !id[1..].chars().all(|c| c.is_ascii_digit()) {
        return Err(format!(
            "tmux remoto non ha restituito una finestra valida: {id}"
        ));
    }
    Ok(id)
}

pub fn kill_window(remote: &RemoteProject, session: &str, window: &str) -> Result<(), String> {
    check_session(session)?;
    check_target(window)?;
    let script = format!(
        "tmux kill-window -t {}",
        quote(&format!("{session}:{window}"))
    );
    run_script(remote, &script, STATUS_TIMEOUT).map(|_| ())
}

pub fn kill_session(remote: &RemoteProject, session: &str) -> Result<(), String> {
    check_session(session)?;
    let script = format!("tmux kill-session -t {}", quote(&format!("={session}")));
    run_script(remote, &script, STATUS_TIMEOUT).map(|_| ())
}

fn remote_pane_target(session: &str, target: &str) -> Result<String, String> {
    check_target(target)?;
    if target.starts_with('%') {
        Ok(target.to_string())
    } else {
        Ok(format!("{session}:{target}"))
    }
}

// A new tmux window after the source one: one window per Work rectangle keeps
// each xterm attached to its own pane (see tmux::split_window).
pub fn split_window(
    remote: &RemoteProject,
    session: &str,
    window: &str,
    direction: &str,
) -> Result<crate::tmux::TmuxPaneInfo, String> {
    check_session(session)?;
    check_target(window)?;
    crate::tmux::normalize_direction(direction)?;
    let source = format!("{session}:{window}");
    let script = format!(
        "cwd=$(tmux display-message -p -t {} '#{{pane_current_path}}' 2>/dev/null); tmux new-window -P -F '#{{window_id}}\t#{{pane_id}}\t#{{pane_width}}\t#{{pane_height}}' -a -t {} -c \"$cwd\"",
        quote(&source),
        quote(&source)
    );
    let out = run_script(remote, &script, STATUS_TIMEOUT)?;
    crate::tmux::parse_pane_info(&out, "")
}

pub fn resize_pane(
    remote: &RemoteProject,
    session: &str,
    target: &str,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    check_session(session)?;
    if cols == 0 || rows == 0 {
        return Err("Dimensioni del pannello non valide.".into());
    }
    let target = remote_pane_target(session, target)?;
    let script = format!(
        "tmux resize-pane -t {} -x {} -y {}",
        quote(&target),
        cols,
        rows
    );
    run_script(remote, &script, STATUS_TIMEOUT).map(|_| ())
}

pub fn zoom_pane(remote: &RemoteProject, session: &str, target: &str) -> Result<(), String> {
    check_session(session)?;
    let target = remote_pane_target(session, target)?;
    let script = format!("tmux resize-pane -Z -t {}", quote(&target));
    run_script(remote, &script, STATUS_TIMEOUT).map(|_| ())
}

pub fn kill_pane(remote: &RemoteProject, session: &str, target: &str) -> Result<(), String> {
    check_session(session)?;
    let target = remote_pane_target(session, target)?;
    let script = format!("tmux kill-pane -t {}", quote(&target));
    run_script(remote, &script, STATUS_TIMEOUT).map(|_| ())
}

pub fn send_keys(
    remote: &RemoteProject,
    session: &str,
    target: &str,
    keys: &str,
) -> Result<(), String> {
    check_session(session)?;
    check_target(target)?;
    if keys.contains('\0') {
        return Err("Testo non valido: contiene un byte nullo.".into());
    }
    let script = format!(
        "tmux send-keys -t {} {} C-m",
        quote(&format!("{session}:{target}")),
        quote(keys)
    );
    run_script(remote, &script, STATUS_TIMEOUT).map(|_| ())
}

pub fn capture_pane(
    remote: &RemoteProject,
    session: &str,
    target: &str,
    lines: Option<u32>,
) -> Result<String, String> {
    check_session(session)?;
    check_target(target)?;
    let mut script = format!(
        "tmux capture-pane -p -t {}",
        quote(&format!("{session}:{target}"))
    );
    if let Some(lines) = lines {
        script.push_str(&format!(" -S {}", quote(&format!("-{lines}"))));
    }
    run_script(remote, &script, STATUS_TIMEOUT)
}

// The script a PTY runs after `ssh -t`. It creates the project session if
// needed, opens the requested window (or a new one), attaches through an
// isolated grouped client and removes that client on detach. The base session
// is never killed: agents keep running after Work closes.
pub fn attach_script(
    remote: &RemoteProject,
    session: &str,
    window: Option<&str>,
    window_name: Option<&str>,
    cwd: &str,
    command: Option<&str>,
    client: &str,
) -> Result<String, String> {
    remote.validate()?;
    check_session(session)?;
    check_session(client)?;
    if let Some(window) = window {
        check_target(window)?;
    }
    if let Some(name) = window_name {
        check_target(name)?;
    }
    if command.is_some_and(|c| c.contains('\0')) {
        return Err("Comando non valido: contiene un byte nullo.".into());
    }
    let mut script = format!(
        "if ! tmux has-session -t {} 2>/dev/null; then tmux new-session -d -s {} -c {} -n shell 2>/dev/null || {{ echo 'Impossibile creare la sessione tmux remota {}' >&2; exit 1; }}; fi; ",
        quote(&format!("={session}")),
        quote(session),
        quote(cwd),
        session
    );
    script.push_str(&format!(
        "tmux kill-session -t {} 2>/dev/null; tmux new-session -d -t {} -s {} 2>/dev/null; ",
        quote(&format!("={client}")),
        quote(session),
        quote(client)
    ));
    if let Some(window) = window {
        script.push_str(&format!(
            "tmux select-window -t {} 2>/dev/null; ",
            quote(&format!("{client}:{window}"))
        ));
    } else {
        let name = window_name.unwrap_or("shell");
        if name == "shell" {
            // Reuse the single shell window the session was created with,
            // exactly as the local tmux path does.
            script.push_str(&format!(
                "win=; set -- $(tmux list-windows -t {} -F '#{{window_id}}|#{{window_name}}' 2>/dev/null); if [ \"$#\" -eq 1 ] && [ \"${{1#*|}}\" = 'shell' ]; then win=\"${{1%%|*}}\"; fi; ",
                quote(client)
            ));
            script.push_str(&format!(
                "if [ -z \"$win\" ]; then tmux new-window -t {} -n {} -c {}",
                quote(client),
                quote(name),
                quote(cwd)
            ));
            if let Some(command) = command {
                script.push(' ');
                script.push_str(&quote(command));
            }
            script.push_str(&format!(" 2>/dev/null; win={}; fi; ", quote(name)));
            script.push_str(&format!(
                "tmux select-window -t {}:\"$win\" 2>/dev/null; ",
                quote(client)
            ));
        } else {
            script.push_str(&format!(
                "tmux new-window -t {} -n {} -c {}",
                quote(client),
                quote(name),
                quote(cwd)
            ));
            if let Some(command) = command {
                script.push(' ');
                script.push_str(&quote(command));
            }
            script.push_str(" 2>/dev/null; ");
            script.push_str(&format!(
                "tmux select-window -t {} 2>/dev/null; ",
                quote(&format!("{client}:{name}"))
            ));
        }
    }
    script.push_str(&format!(
        "tmux set-option -t {} status off 2>/dev/null; ",
        quote(client)
    ));
    script.push_str(&format!("tmux attach-session -t {}; ", quote(client)));
    script.push_str(&format!(
        "tmux kill-session -t {} 2>/dev/null",
        quote(&format!("={client}"))
    ));
    Ok(script)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remote() -> RemoteProject {
        RemoteProject {
            host: "server-vps".into(),
            user: Some("deploy".into()),
            port: Some(2222),
            remote_path: "/srv/app".into(),
            session_name: None,
        }
    }

    #[test]
    fn rejects_values_that_could_reach_the_shell() {
        for host in ["", "-oProxyCommand=x", "a b", "a;rm", "host/name", "$HOME"] {
            let mut r = remote();
            r.host = host.into();
            assert!(r.validate().is_err(), "host {host:?}");
        }
        for user in ["-oProxyCommand=x", "a b", "a;rm", "a/b"] {
            let mut r = remote();
            r.user = Some(user.into());
            assert!(r.validate().is_err(), "user {user:?}");
        }
        for session in ["a:b", "a b", "a;rm", "-oX"] {
            let mut r = remote();
            r.session_name = Some(session.into());
            assert!(r.validate().is_err(), "session {session:?}");
        }
        let mut relative = remote();
        relative.remote_path = "srv/app".into();
        assert!(relative.validate().is_err());
        let mut control = remote();
        control.remote_path = "/srv/\napp".into();
        assert!(control.validate().is_err());
        assert!(remote().validate().is_ok());
    }

    #[test]
    fn quotes_a_single_argument_without_leaving_the_shell() {
        assert_eq!(quote("plain"), "'plain'");
        assert_eq!(quote("a'b"), "'a'\\''b'");
        assert_eq!(quote("a; rm -rf /"), "'a; rm -rf /'");
        assert_eq!(quote("$HOME"), "'$HOME'");
    }

    #[test]
    fn the_attach_script_quotes_paths_names_and_commands() {
        let mut r = remote();
        r.remote_path = "/srv/a'; touch /tmp/pwn; echo '".into();
        let script = attach_script(
            &r,
            "work_app_123456",
            None,
            Some("dev1"),
            &r.remote_path,
            Some("echo 'hello'; whoami"),
            "work_app_123456_pty_1",
        )
        .unwrap();
        assert!(
            script.contains("'/srv/a'\\''; touch /tmp/pwn; echo '\\'''"),
            "{script}"
        );
        assert!(
            script.contains("'echo '\\''hello'\\''; whoami'"),
            "{script}"
        );
        assert!(script.contains("tmux attach-session -t 'work_app_123456_pty_1'"));
    }

    #[test]
    fn a_plain_remote_terminal_reuses_the_single_shell_window() {
        let r = remote();
        let script = attach_script(
            &r,
            "work_app_123456",
            None,
            None,
            "/srv/app",
            None,
            "work_app_123456_pty_1",
        )
        .unwrap();
        assert!(
            script.contains("win=; set -- $(tmux list-windows"),
            "{script}"
        );
        assert!(
            script.contains("tmux select-window -t 'work_app_123456_pty_1':\"$win\""),
            "{script}"
        );
        assert!(script.contains("tmux attach-session -t 'work_app_123456_pty_1'"));
    }

    #[test]
    fn the_generated_shell_has_valid_syntax_even_with_quotes() {
        for (window, name, command) in [
            (None, None, None),
            (Some("@4"), Some("dev1"), None),
            (None, Some("Sign in to GitHub"), Some("gh auth login")),
        ] {
            let mut r = remote();
            r.remote_path = "/srv/a'; touch /tmp/pwn; echo '".into();
            let script = attach_script(
                &r,
                "work_app_123456",
                window,
                name,
                &r.remote_path,
                command,
                "work_app_123456_pty_1",
            )
            .unwrap();
            let status = Command::new("sh")
                .args(["-n", "-c", &script])
                .status()
                .unwrap();
            assert!(status.success(), "{script}");
        }
    }

    #[test]
    fn a_readable_window_name_with_spaces_is_allowed() {
        let r = remote();
        let script = attach_script(
            &r,
            "work_app_123456",
            None,
            Some("Sign in to GitHub"),
            "/srv/app",
            Some("gh auth login"),
            "work_app_123456_pty_1",
        )
        .unwrap();
        assert!(script.contains("-n 'Sign in to GitHub'"), "{script}");
    }

    #[test]
    fn an_invalid_remote_never_builds_an_attach_script() {
        let r = RemoteProject {
            host: "vps".into(),
            user: None,
            port: None,
            remote_path: "/srv/app".into(),
            session_name: Some("bad:name".into()),
        };
        assert!(attach_script(
            &r,
            "work_app_1",
            None,
            None,
            "/srv/app",
            None,
            "work_app_1_pty_1"
        )
        .is_err());
    }

    #[test]
    fn remote_window_listing_does_not_depend_on_tabs_or_the_remote_locale() {
        // A POSIX locale makes tmux replace tab/control separators with '_';
        // the printable format keeps the fields intact.
        assert!(!REMOTE_WINDOW_FORMAT.contains('\t'));
        assert!(REMOTE_WINDOW_FORMAT.chars().all(|c| !c.is_control()));
        let raw =
            "@261:shell:0:/tmp/qa33\n@262:pm:1:/srv/app\n@263:dev1:0:/srv/app\n@264::0:/srv/a:b\n";
        let windows = parse_remote_windows(raw);
        assert_eq!(windows.len(), 4);
        assert_eq!(windows[0].id, "@261");
        assert_eq!(windows[0].name, "shell");
        assert!(!windows[0].active);
        assert_eq!(windows[0].path, "/tmp/qa33");
        assert!(windows[1].active);
        assert_eq!(windows[2].name, "dev1");
        assert_eq!(windows[3].name, "");
        assert_eq!(
            windows[3].path, "/srv/a:b",
            "colons in the last field are preserved"
        );
    }

    #[test]
    fn session_name_is_stable_and_uses_the_custom_one_when_given() {
        let r = remote();
        assert_eq!(session_name(&r), session_name(&r));
        assert_eq!(session_name(&r), "work_app_b2b91f");
        let mut custom = r.clone();
        custom.session_name = Some("work-stack".into());
        assert_eq!(session_name(&custom), "work-stack");
    }

    #[test]
    fn ssh_options_keep_the_target_after_every_option() {
        let args = ssh_args(&remote(), false);
        let target = args.iter().position(|a| a == "deploy@server-vps").unwrap();
        assert!(args[..target].contains(&"-p".to_string()));
        assert!(args[..target].contains(&"2222".to_string()));
        assert!(args.contains(&"BatchMode=yes".to_string()));
        let tty = ssh_args(&remote(), true);
        assert!(tty.contains(&"-t".to_string()));
        assert!(!tty.contains(&"BatchMode=yes".to_string()));
    }

    #[test]
    fn a_hanging_ssh_is_killed_at_the_timeout() {
        let mut child = Command::new("sh")
            .args(["-c", "sleep 30"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let start = Instant::now();
        let status = wait_with_timeout(&mut child, Duration::from_millis(200)).unwrap();
        assert!(status.is_none(), "the process must be killed");
        assert!(start.elapsed() < Duration::from_secs(3));
    }
}
