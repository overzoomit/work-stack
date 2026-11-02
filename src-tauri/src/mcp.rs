// MCP and browser plumbing for the agents Work starts: the graphical
// environment their MCP servers need, what ~/.claude.json configures, and a
// quick health check with a launcher for the debug browsers.
use serde::Serialize;
use serde_json::Value;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

// What a browser MCP server needs to open a window or reach the user's bus.
pub const GRAPHICAL_VARS: [&str; 4] = [
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
];
const CHROME_PORT: u16 = 9222;
const FIREFOX_PROFILE: &str = ".firefox-mcp-profile";
const CHROME_PROFILE: &str = ".chrome-mcp-profile";
const CONNECT_TIMEOUT: Duration = Duration::from_millis(1500);
const LOCAL_TIMEOUT: Duration = Duration::from_millis(300);

pub(crate) fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
}

// The four variables with what is missing filled in from the session's
// runtime dir (Work started by a launcher that stripped them). DISPLAY has
// no safe guess: it is passed on only when set.
pub fn graphical_env(
    get: impl Fn(&str) -> Option<String>,
    runtime_root: &Path,
    uid: u32,
) -> Vec<(&'static str, String)> {
    let set = |k: &str| get(k).filter(|v| !v.is_empty());
    let runtime = set("XDG_RUNTIME_DIR").or_else(|| {
        let dir = runtime_root.join(uid.to_string());
        dir.is_dir().then(|| dir.to_string_lossy().into_owned())
    });
    let in_runtime = |name: &str| runtime.as_ref().map(|r| Path::new(r).join(name));
    let dbus = set("DBUS_SESSION_BUS_ADDRESS").or_else(|| {
        let bus = in_runtime("bus").filter(|b| b.exists())?;
        Some(format!("unix:path={}", bus.display()))
    });
    let wayland = set("WAYLAND_DISPLAY").or_else(|| {
        let mut sockets: Vec<String> = std::fs::read_dir(in_runtime("")?)
            .ok()?
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .filter(|n| n.starts_with("wayland-") && !n.ends_with(".lock"))
            .collect();
        sockets.sort();
        sockets.into_iter().next()
    });
    [
        ("DISPLAY", set("DISPLAY")),
        ("WAYLAND_DISPLAY", wayland),
        ("DBUS_SESSION_BUS_ADDRESS", dbus),
        ("XDG_RUNTIME_DIR", runtime),
    ]
    .into_iter()
    .filter_map(|(k, v)| Some((k, v?)))
    .collect()
}

pub fn graphical_env_now() -> Vec<(&'static str, String)> {
    let uid = unsafe { libc::getuid() };
    graphical_env(|k| std::env::var(k).ok(), Path::new("/run/user"), uid)
}

// ── Configured servers ───────────────────────────────────────

#[derive(Debug, PartialEq, Serialize)]
pub struct Server {
    pub name: String,
    pub transport: String,
    // The command, or the origin of a remote URL: never its arguments or query,
    // which can carry tokens.
    pub target: String,
    // Names only: the values are secrets.
    pub env_keys: Vec<String>,
    pub endpoint: Option<String>,
}

fn origin(url: &str) -> Option<&str> {
    let after_scheme = url.find("://")? + 3;
    let end = url[after_scheme..]
        .find(['/', '?', '#'])
        .map_or(url.len(), |i| after_scheme + i);
    Some(&url[..end])
}

pub fn servers_in(config: &Value) -> Vec<Server> {
    let Some(map) = config["mcpServers"].as_object() else {
        return vec![];
    };
    map.iter()
        .map(|(name, s)| {
            let url = s["url"].as_str();
            let env = s["env"].as_object();
            let transport =
                s["type"]
                    .as_str()
                    .unwrap_or(if url.is_some() { "http" } else { "stdio" });
            let target = match url {
                Some(u) => origin(u).unwrap_or("").to_string(),
                None => s["command"].as_str().unwrap_or("").to_string(),
            };
            let endpoint = url.and_then(origin).map(String::from).or_else(|| {
                env?.iter()
                    .find(|(k, _)| k.ends_with("_BASE_URL"))
                    .and_then(|(_, v)| origin(v.as_str()?).map(String::from))
            });
            Server {
                name: name.clone(),
                transport: transport.to_string(),
                target,
                env_keys: env.map(|e| e.keys().cloned().collect()).unwrap_or_default(),
                endpoint,
            }
        })
        .collect()
}

// The folder firefox-devtools keeps its profile in: its --profilePath, else the default.
pub fn firefox_profile(config: &Value, home: &Path) -> PathBuf {
    let args = config["mcpServers"]["firefox-devtools"]["args"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    let from_flag =
        args.iter()
            .enumerate()
            .find_map(|(i, a)| match a.strip_prefix("--profilePath=") {
                Some(p) => Some(p),
                None => (*a == "--profilePath")
                    .then(|| args.get(i + 1).copied())
                    .flatten(),
            });
    from_flag.map_or_else(|| home.join(FIREFOX_PROFILE), PathBuf::from)
}

fn read_config() -> Value {
    std::fs::read_to_string(home().join(".claude.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

// ── Probes ───────────────────────────────────────────────────

pub fn on_path(command: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;
    let is_exec = |p: &Path| {
        p.metadata()
            .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    };
    if command.contains('/') {
        return is_exec(Path::new(command));
    }
    std::env::var_os("PATH")
        .is_some_and(|path| std::env::split_paths(&path).any(|d| is_exec(&d.join(command))))
}

fn reachable(addr: SocketAddr, timeout: Duration) -> bool {
    TcpStream::connect_timeout(&addr, timeout).is_ok()
}

// "https://host[:port]" answers a TCP connect.
fn endpoint_up(endpoint: &str) -> bool {
    let Some((scheme, host)) = endpoint.split_once("://") else {
        return false;
    };
    let host = host.trim_end_matches('/');
    let with_port = if host.contains(':') {
        host.to_string()
    } else {
        format!("{host}:{}", if scheme == "http" { 80 } else { 443 })
    };
    with_port
        .to_socket_addrs()
        .ok()
        .and_then(|mut a| a.next())
        .is_some_and(|a| reachable(a, CONNECT_TIMEOUT))
}

fn port_open(port: u16) -> bool {
    reachable(SocketAddr::from(([127, 0, 0, 1], port)), LOCAL_TIMEOUT)
}

fn process_args() -> String {
    Command::new("ps")
        .args(["-axww", "-o", "args="])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

fn first_found(candidates: &[&str]) -> Option<String> {
    candidates
        .iter()
        .find(|c| on_path(c))
        .map(|c| c.to_string())
}

fn firefox_binary() -> Option<String> {
    first_found(&[
        "firefox",
        "/Applications/Firefox.app/Contents/MacOS/firefox",
    ])
}

fn chrome_binary() -> Option<String> {
    first_found(&[
        "google-chrome-stable",
        "google-chrome",
        "chromium",
        "chromium-browser",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ])
}

// ── Status ───────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ServerStatus {
    #[serde(flatten)]
    pub server: Server,
    // A stdio server's command is installed (None: remote server).
    pub command_found: Option<bool>,
    // Its endpoint answers (None: it has none).
    pub endpoint_up: Option<bool>,
}

#[derive(Serialize)]
pub struct Browser {
    pub id: &'static str,
    pub label: &'static str,
    pub installed: bool,
    pub running: bool,
    pub detail: String,
}

#[derive(Serialize)]
pub struct EnvVar {
    pub name: &'static str,
    pub present: bool,
}

#[derive(Serialize)]
pub struct Status {
    pub servers: Vec<ServerStatus>,
    pub browsers: Vec<Browser>,
    pub env: Vec<EnvVar>,
}

fn status() -> Status {
    let config = read_config();
    let home = home();
    let servers = servers_in(&config)
        .into_iter()
        .map(|server| ServerStatus {
            command_found: (server.transport == "stdio").then(|| on_path(&server.target)),
            endpoint_up: server.endpoint.as_deref().map(endpoint_up),
            server,
        })
        .collect();

    let profile = firefox_profile(&config, &home);
    let firefox_running = process_args()
        .lines()
        .any(|l| l.contains("firefox") && l.contains(profile.to_string_lossy().as_ref()));
    let browsers = vec![
        Browser {
            id: "firefox",
            label: "Firefox (firefox-devtools)",
            installed: firefox_binary().is_some(),
            running: firefox_running,
            detail: format!("profile {}", profile.display()),
        },
        Browser {
            id: "chrome",
            label: "Chrome (claude-in-chrome)",
            installed: chrome_binary().is_some(),
            running: port_open(CHROME_PORT),
            detail: format!("debug port {CHROME_PORT}"),
        },
    ];

    let present: Vec<_> = graphical_env_now().into_iter().map(|(k, _)| k).collect();
    let env = GRAPHICAL_VARS
        .iter()
        .map(|&name| EnvVar {
            name,
            present: present.contains(&name),
        })
        .collect();
    Status {
        servers,
        browsers,
        env,
    }
}

// ── Launcher ─────────────────────────────────────────────────

pub fn browser_command(
    browser: &str,
    config: &Value,
    home: &Path,
) -> Result<(String, Vec<String>), String> {
    match browser {
        "firefox" => {
            let bin = firefox_binary().ok_or("Firefox is not installed")?;
            let profile = firefox_profile(config, home);
            Ok((
                bin,
                vec![
                    "--profile".into(),
                    profile.to_string_lossy().into_owned(),
                    "--no-remote".into(),
                ],
            ))
        }
        "chrome" => {
            let bin = chrome_binary().ok_or("Chrome or Chromium is not installed")?;
            // Chrome ignores the debug port on its default profile.
            let dir = home.join(CHROME_PROFILE);
            Ok((
                bin,
                vec![
                    format!("--remote-debugging-port={CHROME_PORT}"),
                    format!("--user-data-dir={}", dir.display()),
                    "--no-first-run".into(),
                ],
            ))
        }
        other => Err(format!("Unknown browser: {other}")),
    }
}

fn launch(browser: &str) -> Result<String, String> {
    let status = status();
    if status.browsers.iter().any(|b| b.id == browser && b.running) {
        return Err("Already running".into());
    }
    let (bin, args) = browser_command(browser, &read_config(), &home())?;
    let mut child = Command::new(&bin)
        .args(&args)
        .envs(graphical_env_now())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Cannot start {bin}: {e}"))?;
    std::thread::spawn(move || child.wait());
    Ok(format!("Started {browser}"))
}

// ── IPC Commands ─────────────────────────────────────────────

// Probing touches the network and the process list: off the main thread.
#[tauri::command]
pub async fn mcp_status() -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(status)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mcp_launch_browser(browser: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || launch(&browser))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    fn getter<'a>(vars: &'a HashMap<&str, &str>) -> impl Fn(&str) -> Option<String> + 'a {
        |k| vars.get(k).map(|v| v.to_string())
    }

    #[test]
    fn the_graphical_variables_pass_through_as_they_are() {
        let vars = HashMap::from([
            ("DISPLAY", ":1"),
            ("WAYLAND_DISPLAY", "wayland-1"),
            ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus"),
            ("XDG_RUNTIME_DIR", "/run/user/1000"),
        ]);
        let env = graphical_env(getter(&vars), Path::new("/nowhere"), 1000);
        assert_eq!(env.len(), 4);
        assert!(env.contains(&("WAYLAND_DISPLAY", "wayland-1".to_string())));
    }

    #[test]
    fn missing_ones_are_recovered_from_the_runtime_dir() {
        let root = tempfile::tempdir().unwrap();
        let runtime = root.path().join("1000");
        std::fs::create_dir(&runtime).unwrap();
        for name in ["bus", "wayland-0", "wayland-0.lock"] {
            std::fs::write(runtime.join(name), "").unwrap();
        }
        let env = graphical_env(|_| None, root.path(), 1000);
        let get = |k: &str| env.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone());
        assert_eq!(
            get("XDG_RUNTIME_DIR"),
            Some(runtime.to_string_lossy().into_owned())
        );
        assert_eq!(
            get("DBUS_SESSION_BUS_ADDRESS"),
            Some(format!("unix:path={}/bus", runtime.display()))
        );
        assert_eq!(
            get("WAYLAND_DISPLAY"),
            Some("wayland-0".into()),
            "the lock file is not a socket"
        );
        assert_eq!(get("DISPLAY"), None, "no safe guess for DISPLAY");
    }

    #[test]
    fn empty_values_count_as_missing_and_nothing_is_invented() {
        let vars = HashMap::from([("DISPLAY", "")]);
        assert!(graphical_env(getter(&vars), Path::new("/nowhere"), 1000).is_empty());
    }

    #[test]
    fn servers_are_read_without_their_secrets() {
        let config = json!({"mcpServers": {
            "plane": {
                "type": "stdio", "command": "npx", "args": ["-y", "x"],
                "env": {"PLANE_API_KEY": "secret", "PLANE_BASE_URL": "https://plane.example.it/api?k=1"}
            },
            "remote": {"type": "http", "url": "https://mcp.example.com/v1?token=abc"},
            "bare": {"command": "tool"}
        }});
        let servers = servers_in(&config);
        let by = |n: &str| servers.iter().find(|s| s.name == n).unwrap();

        assert_eq!(by("plane").target, "npx");
        assert_eq!(by("plane").env_keys, ["PLANE_API_KEY", "PLANE_BASE_URL"]);
        assert_eq!(
            by("plane").endpoint.as_deref(),
            Some("https://plane.example.it")
        );
        assert_eq!(by("remote").transport, "http");
        assert_eq!(by("remote").target, "https://mcp.example.com");
        assert_eq!(by("bare").transport, "stdio");
        let json = serde_json::to_string(&servers).unwrap();
        assert!(!json.contains("secret") && !json.contains("token=abc"));
        assert!(servers_in(&json!({})).is_empty());
    }

    #[test]
    fn the_firefox_profile_comes_from_the_server_arguments() {
        let home = Path::new("/home/u");
        let with = |args: Value| json!({"mcpServers": {"firefox-devtools": {"args": args}}});
        let spaced = with(json!(["-y", "pkg", "--profilePath", "/p/one"]));
        let joined = with(json!(["--profilePath=/p/two"]));
        assert_eq!(firefox_profile(&spaced, home), PathBuf::from("/p/one"));
        assert_eq!(firefox_profile(&joined, home), PathBuf::from("/p/two"));
        assert_eq!(
            firefox_profile(&json!({}), home),
            home.join(".firefox-mcp-profile")
        );
        assert_eq!(
            firefox_profile(&with(json!(["--profilePath"])), home),
            home.join(".firefox-mcp-profile"),
            "a flag without a value falls back"
        );
    }

    #[test]
    fn chrome_is_started_with_the_debug_port_and_its_own_profile() {
        if chrome_binary().is_none() {
            return;
        }
        let (_, args) = browser_command("chrome", &json!({}), Path::new("/home/u")).unwrap();
        assert!(args.contains(&"--remote-debugging-port=9222".to_string()));
        assert!(args.contains(&"--user-data-dir=/home/u/.chrome-mcp-profile".to_string()));
        assert!(browser_command("netscape", &json!({}), Path::new("/")).is_err());
    }

    #[test]
    fn a_listening_local_port_is_seen_and_a_closed_one_is_not() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(port_open(port));
        drop(listener);
        assert!(!port_open(port));
        assert!(!endpoint_up(&format!("http://127.0.0.1:{port}")));
    }

    #[test]
    fn commands_are_looked_up_on_the_path() {
        assert!(on_path("sh"));
        assert!(on_path("/bin/sh") || on_path("/usr/bin/sh"));
        assert!(!on_path("no-such-command-work-test"));
    }
}
