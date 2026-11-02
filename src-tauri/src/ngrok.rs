// ngrok tunnels, at most one per project: the ngrok CLI started with direct
// arguments (no shell), its public URL read from the agent's own inspection
// API. Each agent picks a free port for that API (4040, 4041…), so the port
// comes from the agent's JSON log, never assumed.
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const PROTOCOLS: [&str; 3] = ["http", "tcp", "tls"];
const START_TIMEOUT: Duration = Duration::from_secs(20);
const POLL: Duration = Duration::from_millis(250);

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct NgrokStatus {
    pub active: bool,
    pub port: Option<u16>,
    pub protocol: Option<String>,
    pub domain: Option<String>,
    pub public_url: Option<String>,
    pub inspect_url: Option<String>,
    // Why a tunnel that was open is gone: reported once, then cleared.
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Spec {
    port: u16,
    protocol: String,
    domain: Option<String>,
}

impl Spec {
    pub fn new(port: u16, protocol: &str, domain: Option<String>) -> Result<Spec, String> {
        if port == 0 {
            return Err("The local port must be between 1 and 65535.".into());
        }
        let protocol = protocol.trim().to_ascii_lowercase();
        if !PROTOCOLS.contains(&protocol.as_str()) {
            return Err(format!(
                "Unsupported protocol \"{protocol}\": use http, tcp or tls."
            ));
        }
        let domain = domain
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty());
        if let Some(d) = &domain {
            let allowed = |c: char| c.is_ascii_alphanumeric() || ".-:/".contains(c);
            if d.len() > 253 || d.starts_with('-') || !d.chars().all(allowed) {
                return Err(format!(
                    "Invalid custom domain \"{d}\": use a host name like my-app.ngrok-free.app."
                ));
            }
        }
        Ok(Spec {
            port,
            protocol,
            domain,
        })
    }

    // `--url=<domain>` in one argument: the value can never be read as a flag.
    fn args(&self) -> Vec<String> {
        let mut args = vec![
            self.protocol.clone(),
            "--log=stdout".into(),
            "--log-format=json".into(),
        ];
        if let Some(d) = &self.domain {
            args.push(format!("--url={d}"));
        }
        args.push(self.port.to_string());
        args
    }

    fn status(&self) -> NgrokStatus {
        NgrokStatus {
            port: Some(self.port),
            protocol: Some(self.protocol.clone()),
            domain: self.domain.clone(),
            ..Default::default()
        }
    }
}

// What the agent said about itself on stdout/stderr.
// The JSON log carries the reason of a failure; stderr only repeats it, one
// "ERROR:" line per line of text, so only its first line is kept, as a
// fallback for failures before the log starts (a bad flag).
#[derive(Default, Debug)]
struct Log {
    web: Option<SocketAddr>,
    error: Option<String>,
    stderr: Option<String>,
    closed: bool,
}

impl Log {
    fn reason(&self) -> Option<String> {
        self.error.clone().or_else(|| self.stderr.clone())
    }
}

// ngrok may exit before its last line is read: that line is the reason.
fn wait_closed(log: &Mutex<Log>) {
    let deadline = Instant::now() + Duration::from_secs(1);
    while !log.lock().unwrap().closed && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
}

// The first line of ngrok's error, with its ERR_NGROK_ code when the code
// sits further down (the login hint usually comes first).
fn short_error(err: &str) -> String {
    let first = err
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("ngrok error");
    match err.split_whitespace().find(|w| w.starts_with("ERR_NGROK_")) {
        Some(code) if !first.contains(code) => format!("{first} ({code})"),
        _ => first.to_string(),
    }
}

// The inspection API is only ever asked on this machine: an address from a
// config with web_addr 0.0.0.0 is reached through the loopback.
fn local_addr(text: &str) -> Option<SocketAddr> {
    let mut addr: SocketAddr = text.trim().parse().ok()?;
    if addr.ip().is_unspecified() {
        addr.set_ip(IpAddr::V4(Ipv4Addr::LOCALHOST));
    }
    addr.ip().is_loopback().then_some(addr)
}

fn read_line(line: &str, log: &mut Log) {
    let line = line.trim();
    if let Some(rest) = line.strip_prefix("ERROR:") {
        if log.stderr.is_none() && !rest.trim().is_empty() {
            log.stderr = Some(short_error(rest));
        }
        return;
    }
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return;
    };
    if v["msg"] == "starting web service" {
        if let Some(addr) = v["addr"].as_str().and_then(local_addr) {
            log.web = Some(addr);
        }
    }
    let serious = matches!(v["lvl"].as_str(), Some("eror" | "crit" | "warn"));
    if let (true, Some(err)) = (serious, v["err"].as_str()) {
        log.error = Some(short_error(err));
    }
}

// Keeps reading until ngrok exits: a full pipe would block its logging.
fn drain(
    out: impl Read + Send + 'static,
    log: Arc<Mutex<Log>>,
    at_end: impl FnOnce() + Send + 'static,
) {
    std::thread::spawn(move || {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            read_line(&line, &mut log.lock().unwrap());
        }
        at_end();
    });
}

// ngrok v2 opened an http and an https tunnel side by side: https wins.
fn public_url(body: &Value) -> Option<String> {
    let schemes = ["https://", "http://", "tcp://", "tls://"];
    let urls: Vec<&str> = body["tunnels"]
        .as_array()?
        .iter()
        .filter_map(|t| t["public_url"].as_str())
        .filter(|u| schemes.iter().any(|s| u.starts_with(s)))
        .collect();
    urls.iter()
        .find(|u| u.starts_with("https://"))
        .or(urls.first())
        .map(|u| u.to_string())
}

fn fetch_public_url(client: &reqwest::blocking::Client, web: SocketAddr) -> Option<String> {
    let body: Value = client
        .get(format!("http://{web}/api/tunnels"))
        .send()
        .ok()?
        .json()
        .ok()?;
    public_url(&body)
}

// SIGTERM lets ngrok close its session with the server; SIGKILL after 2 s.
fn terminate(mut child: Child) {
    if let Ok(Some(_)) = child.try_wait() {
        return;
    }
    unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if !matches!(child.try_wait(), Ok(None)) {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn spawn_error(e: std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        return "ngrok is not installed: get it from https://ngrok.com/download, then run `ngrok config add-authtoken <token>`.".into();
    }
    format!("Cannot start ngrok: {e}")
}

fn exit_error(log: &Mutex<Log>, code: std::process::ExitStatus) -> String {
    match log.lock().unwrap().reason() {
        Some(e) => format!("ngrok stopped: {e}"),
        None => format!("ngrok stopped unexpectedly ({code})."),
    }
}

struct Tunnel {
    id: u64,
    child: Child,
    status: NgrokStatus,
    log: Arc<Mutex<Log>>,
}

pub struct Tunnels {
    list: Mutex<HashMap<String, Tunnel>>,
    next: AtomicU64,
    on_exit: Arc<dyn Fn(&str) + Send + Sync>,
}

impl Tunnels {
    // on_exit: an agent ended (stopped, crashed, killed); its project is passed.
    pub fn new(on_exit: impl Fn(&str) + Send + Sync + 'static) -> Tunnels {
        Tunnels {
            list: Mutex::default(),
            next: AtomicU64::new(1),
            on_exit: Arc::new(on_exit),
        }
    }

    // A tunnel already open for the project is replaced. Stopped while
    // starting, the start answers with an inactive status.
    pub fn start(
        &self,
        project: &str,
        spec: Spec,
        bin: &str,
        timeout: Duration,
    ) -> Result<NgrokStatus, String> {
        let mut child = Command::new(bin)
            .args(spec.args())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(spawn_error)?;
        let log = Arc::new(Mutex::new(Log::default()));
        if let Some(err) = child.stderr.take() {
            drain(err, Arc::clone(&log), || {});
        }
        if let Some(out) = child.stdout.take() {
            let (on_exit, name, closed) = (
                Arc::clone(&self.on_exit),
                project.to_string(),
                Arc::clone(&log),
            );
            drain(out, Arc::clone(&log), move || {
                closed.lock().unwrap().closed = true;
                on_exit(&name);
            });
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let tunnel = Tunnel {
            id,
            child,
            status: spec.status(),
            log: Arc::clone(&log),
        };
        let old = self
            .list
            .lock()
            .unwrap()
            .insert(project.to_string(), tunnel);
        if let Some(old) = old {
            terminate(old.child);
        }
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(2))
            .no_proxy()
            .build()
            .map_err(|e| e.to_string())?;
        let deadline = Instant::now() + timeout;
        loop {
            let exited = {
                let mut list = self.list.lock().unwrap();
                let Some(t) = list.get_mut(project).filter(|t| t.id == id) else {
                    return Ok(NgrokStatus::default());
                };
                let code = t.child.try_wait().ok().flatten();
                if code.is_some() {
                    list.remove(project);
                }
                code
            };
            if let Some(code) = exited {
                wait_closed(&log);
                return Err(exit_error(&log, code));
            }
            let web = log.lock().unwrap().web;
            if let Some(url) = web.and_then(|w| fetch_public_url(&client, w)) {
                let mut list = self.list.lock().unwrap();
                let Some(t) = list.get_mut(project).filter(|t| t.id == id) else {
                    return Ok(NgrokStatus::default());
                };
                t.status.active = true;
                t.status.public_url = Some(url);
                t.status.inspect_url = web.map(|w| format!("http://{w}"));
                return Ok(t.status.clone());
            }
            if Instant::now() >= deadline {
                let mine = {
                    let mut list = self.list.lock().unwrap();
                    list.get(project)
                        .is_some_and(|t| t.id == id)
                        .then(|| list.remove(project))
                        .flatten()
                };
                if let Some(t) = mine {
                    terminate(t.child);
                }
                let why = log
                    .lock()
                    .unwrap()
                    .reason()
                    .map(|e| format!(": {e}"))
                    .unwrap_or_default();
                return Err(format!(
                    "ngrok did not open the tunnel within {} s{why}",
                    timeout.as_secs()
                ));
            }
            std::thread::sleep(POLL);
        }
    }

    pub fn stop(&self, project: &str) -> NgrokStatus {
        let t = self.list.lock().unwrap().remove(project);
        if let Some(t) = t {
            terminate(t.child);
        }
        NgrokStatus::default()
    }

    // An agent that died on its own is dropped here, with its reason.
    pub fn status(&self, project: &str) -> NgrokStatus {
        let mut list = self.list.lock().unwrap();
        let Some(t) = list.get_mut(project) else {
            return NgrokStatus::default();
        };
        match t.child.try_wait() {
            Ok(None) => t.status.clone(),
            Ok(Some(code)) => {
                let error = Some(exit_error(&t.log, code));
                list.remove(project);
                NgrokStatus {
                    error,
                    ..Default::default()
                }
            }
            Err(e) => NgrokStatus {
                error: Some(e.to_string()),
                ..t.status.clone()
            },
        }
    }

    // Quitting Work closes every tunnel: none stays public behind its back.
    pub fn stop_all(&self) {
        let all: Vec<Tunnel> = self.list.lock().unwrap().drain().map(|(_, t)| t).collect();
        for t in all {
            terminate(t.child);
        }
    }
}

// ── IPC Commands ─────────────────────────────────────────────

#[tauri::command]
pub async fn ngrok_start(
    tunnels: tauri::State<'_, Arc<Tunnels>>,
    project: String,
    port: u16,
    protocol: String,
    custom_domain: Option<String>,
) -> Result<NgrokStatus, String> {
    let spec = Spec::new(port, &protocol, custom_domain)?;
    let tunnels = Arc::clone(&tunnels);
    tauri::async_runtime::spawn_blocking(move || {
        tunnels.start(&project, spec, "ngrok", START_TIMEOUT)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ngrok_stop(
    tunnels: tauri::State<'_, Arc<Tunnels>>,
    project: String,
) -> Result<NgrokStatus, String> {
    let tunnels = Arc::clone(&tunnels);
    tauri::async_runtime::spawn_blocking(move || tunnels.stop(&project))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ngrok_status(
    tunnels: tauri::State<'_, Arc<Tunnels>>,
    project: String,
) -> Result<NgrokStatus, String> {
    Ok(tunnels.status(&project))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;
    use std::net::TcpListener;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::AtomicUsize;

    const AUTH_FAILED: &str = r#"{"err":"authentication failed: Usage of ngrok requires a verified account and authtoken.\n\nSign up for an account: https://dashboard.ngrok.com/signup\r\n\r\nERR_NGROK_4018\r\n","lvl":"eror","msg":"session closing","obj":"tunnels.session","t":"2026-11-02T17:00:00+01:00"}"#;

    fn tunnels() -> (Tunnels, Arc<Mutex<Vec<String>>>) {
        let ended = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&ended);
        (
            Tunnels::new(move |p| seen.lock().unwrap().push(p.to_string())),
            ended,
        )
    }

    // The inspection API: an empty list first (the tunnel is still opening), then the tunnel.
    fn api(body: Value) -> (SocketAddr, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&hits);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut line = String::new();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                while reader.read_line(&mut line).is_ok_and(|n| n > 2) {
                    line.clear();
                }
                let reply = if count.fetch_add(1, Ordering::SeqCst) == 0 {
                    json!({ "tunnels": [] })
                } else {
                    body.clone()
                };
                let text = reply.to_string();
                let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}", text.len());
            }
        });
        (addr, hits)
    }

    // A stand-in for the ngrok binary: records its arguments, runs `body`.
    fn fake_ngrok(dir: &Path, body: &str) -> PathBuf {
        let bin = dir.join("ngrok");
        let args = dir.join("args");
        std::fs::write(
            &bin,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\n{body}\n",
                args.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        bin
    }

    fn web_log(addr: SocketAddr) -> String {
        format!(
            r#"echo '{{"addr":"{addr}","lvl":"info","msg":"starting web service","obj":"web"}}'"#
        )
    }

    fn running(pid: u32) -> bool {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    fn pid_of(t: &Tunnels, project: &str) -> u32 {
        t.list.lock().unwrap()[project].child.id()
    }

    #[test]
    fn spec_accepts_only_known_protocols_ports_and_plain_domains() {
        let ok = Spec::new(3000, "HTTP", Some("  mia-app.ngrok-free.app ".into())).unwrap();
        assert_eq!(
            ok,
            Spec {
                port: 3000,
                protocol: "http".into(),
                domain: Some("mia-app.ngrok-free.app".into())
            }
        );
        assert_eq!(
            Spec::new(22, "tcp", Some("".into())).unwrap().domain,
            None,
            "empty domain: none"
        );
        assert!(Spec::new(5432, "tcp", Some("1.tcp.ngrok.io:27210".into())).is_ok());
        assert!(Spec::new(443, "tls", Some("tls://example.com".into())).is_ok());
        assert!(Spec::new(0, "http", None)
            .unwrap_err()
            .contains("between 1 and 65535"));
        assert!(Spec::new(80, "ssh", None)
            .unwrap_err()
            .contains("Unsupported protocol"));
        for bad in [
            "--config=/etc/x",
            "a b.dev",
            "x.dev;rm -rf ~",
            "$(id).dev",
            "a\nb",
            &"a".repeat(254),
        ] {
            assert!(Spec::new(80, "http", Some(bad.into())).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn args_are_separate_and_the_domain_cannot_become_a_flag() {
        let spec = Spec::new(3000, "http", Some("mia-app.ngrok-free.app".into())).unwrap();
        assert_eq!(
            spec.args(),
            [
                "http",
                "--log=stdout",
                "--log-format=json",
                "--url=mia-app.ngrok-free.app",
                "3000"
            ]
        );
        assert_eq!(
            Spec::new(22, "tcp", None).unwrap().args(),
            ["tcp", "--log=stdout", "--log-format=json", "22"]
        );
    }

    #[test]
    fn the_log_gives_the_inspection_address_only_on_this_machine() {
        let mut log = Log::default();
        read_line(
            r#"{"addr":"127.0.0.1:4041","lvl":"info","msg":"starting web service","obj":"web"}"#,
            &mut log,
        );
        assert_eq!(log.web, Some("127.0.0.1:4041".parse().unwrap()));
        read_line(
            r#"{"addr":"0.0.0.0:4042","lvl":"info","msg":"starting web service","obj":"web"}"#,
            &mut log,
        );
        assert_eq!(
            log.web,
            Some("127.0.0.1:4042".parse().unwrap()),
            "0.0.0.0 is asked on the loopback"
        );
        read_line(
            r#"{"addr":"10.0.0.5:4040","lvl":"info","msg":"starting web service","obj":"web"}"#,
            &mut log,
        );
        assert_eq!(
            log.web,
            Some("127.0.0.1:4042".parse().unwrap()),
            "another host is ignored"
        );
        read_line("t=2026 lvl=info msg=\"not json\"", &mut log);
        read_line(
            r#"{"lvl":"info","msg":"started tunnel","url":"https://x.ngrok-free.app"}"#,
            &mut log,
        );
        assert_eq!(log.error, None);
    }

    #[test]
    fn errors_keep_their_first_line_and_ngrok_code() {
        let mut log = Log::default();
        read_line(AUTH_FAILED, &mut log);
        assert_eq!(
            log.error.as_deref(),
            Some("authentication failed: Usage of ngrok requires a verified account and authtoken. (ERR_NGROK_4018)")
        );
        read_line(
            r#"{"lvl":"info","msg":"open config file","path":"/c.yml","err":null}"#,
            &mut log,
        );
        assert!(
            log.error.is_some(),
            "an info line with err: null is no error"
        );
    }

    // What ngrok 3 prints on stderr as it exits: the text again, one line at a time.
    #[test]
    fn stderr_lends_only_its_first_line_and_only_when_the_log_has_no_reason() {
        let mut log = Log::default();
        for line in [
            "ERROR:  unknown flag: --bogus",
            "ERROR:  ",
            "ERROR:  https://ngrok.com/docs/errors/err_ngrok_105",
            "ERROR:",
        ] {
            read_line(line, &mut log);
        }
        assert_eq!(log.reason().as_deref(), Some("unknown flag: --bogus"));
        read_line(AUTH_FAILED, &mut log);
        assert!(log.reason().unwrap().starts_with("authentication failed"));
    }

    #[test]
    fn the_tunnels_api_prefers_https_and_ignores_odd_urls() {
        let both = json!({ "tunnels": [
            { "public_url": "http://a.ngrok.io", "proto": "http" },
            { "public_url": "https://a.ngrok.io", "proto": "https" },
        ] });
        assert_eq!(public_url(&both).as_deref(), Some("https://a.ngrok.io"));
        let tcp = json!({ "tunnels": [{ "public_url": "tcp://0.tcp.eu.ngrok.io:12345", "proto": "tcp" }] });
        assert_eq!(
            public_url(&tcp).as_deref(),
            Some("tcp://0.tcp.eu.ngrok.io:12345")
        );
        assert_eq!(
            public_url(&json!({ "tunnels": [{ "public_url": "javascript:alert(1)" }] })),
            None
        );
        assert_eq!(public_url(&json!({ "tunnels": [] })), None);
        assert_eq!(public_url(&json!({ "error": "x" })), None);
    }

    #[test]
    fn start_reads_the_public_url_then_stop_ends_the_agent() {
        let dir = tempfile::tempdir().unwrap();
        let (addr, hits) = api(
            json!({ "tunnels": [{ "public_url": "https://mia-app.ngrok-free.app", "proto": "https" }] }),
        );
        let bin = fake_ngrok(dir.path(), &format!("{}\nexec sleep 30", web_log(addr)));
        let (t, ended) = tunnels();
        let spec = Spec::new(3000, "http", Some("mia-app.ngrok-free.app".into())).unwrap();
        let s = t
            .start("/p", spec, bin.to_str().unwrap(), Duration::from_secs(10))
            .unwrap();
        assert!(s.active);
        assert_eq!(
            s.public_url.as_deref(),
            Some("https://mia-app.ngrok-free.app")
        );
        assert_eq!(s.inspect_url, Some(format!("http://{addr}")));
        assert_eq!(
            (s.port, s.protocol.as_deref(), s.domain.as_deref()),
            (Some(3000), Some("http"), Some("mia-app.ngrok-free.app"))
        );
        assert!(
            hits.load(Ordering::SeqCst) >= 2,
            "retried while the tunnel list was empty"
        );
        let args = std::fs::read_to_string(dir.path().join("args")).unwrap();
        assert_eq!(
            args,
            "http\n--log=stdout\n--log-format=json\n--url=mia-app.ngrok-free.app\n3000\n"
        );
        assert_eq!(t.status("/p"), s);
        assert_eq!(t.status("/other"), NgrokStatus::default());

        let pid = pid_of(&t, "/p");
        assert_eq!(t.stop("/p"), NgrokStatus::default());
        assert!(!running(pid), "the agent is gone");
        assert_eq!(t.status("/p"), NgrokStatus::default());
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(*ended.lock().unwrap(), ["/p"]);
    }

    #[test]
    fn an_agent_that_is_not_logged_in_fails_with_its_reason() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_ngrok(dir.path(), &format!(
                "echo 'ERROR:  Instructions to install your authtoken' >&2\necho '{AUTH_FAILED}'\necho 'ERROR:  ERR_NGROK_4018' >&2\nexit 1"
            ));
        let (t, _) = tunnels();
        let e = t
            .start(
                "/p",
                Spec::new(3000, "http", None).unwrap(),
                bin.to_str().unwrap(),
                Duration::from_secs(10),
            )
            .unwrap_err();
        assert!(
            e.contains("authentication failed") && e.contains("ERR_NGROK_4018"),
            "{e}"
        );
        assert_eq!(
            t.status("/p"),
            NgrokStatus::default(),
            "nothing left behind"
        );
    }

    #[test]
    fn a_missing_binary_says_how_to_install_ngrok() {
        let (t, _) = tunnels();
        let e = t
            .start(
                "/p",
                Spec::new(3000, "http", None).unwrap(),
                "/nonexistent/ngrok",
                Duration::from_secs(1),
            )
            .unwrap_err();
        assert!(
            e.contains("ngrok is not installed") && e.contains("add-authtoken"),
            "{e}"
        );
    }

    #[test]
    fn a_tunnel_that_never_opens_times_out_and_is_killed() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_ngrok(
            dir.path(),
            "echo \"$$\" > \"$(dirname \"$0\")/pid\"\nexec sleep 30",
        );
        let (t, _) = tunnels();
        let e = t
            .start(
                "/p",
                Spec::new(3000, "http", None).unwrap(),
                bin.to_str().unwrap(),
                Duration::from_millis(600),
            )
            .unwrap_err();
        assert!(e.contains("did not open the tunnel"), "{e}");
        let pid: u32 = std::fs::read_to_string(dir.path().join("pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert!(!running(pid));
        assert_eq!(t.status("/p"), NgrokStatus::default());
    }

    #[test]
    fn a_tunnel_that_dies_reports_why_once() {
        let dir = tempfile::tempdir().unwrap();
        let (addr, _) = api(json!({ "tunnels": [{ "public_url": "https://x.ngrok-free.app" }] }));
        let bin = fake_ngrok(dir.path(), &format!("{}\nexec sleep 30", web_log(addr)));
        let (t, ended) = tunnels();
        t.start(
            "/p",
            Spec::new(3000, "http", None).unwrap(),
            bin.to_str().unwrap(),
            Duration::from_secs(10),
        )
        .unwrap();
        unsafe { libc::kill(pid_of(&t, "/p") as i32, libc::SIGKILL) };
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(*ended.lock().unwrap(), ["/p"], "the exit is announced");
        let s = t.status("/p");
        assert!(!s.active);
        assert!(
            s.error
                .as_deref()
                .is_some_and(|e| e.contains("stopped unexpectedly")),
            "{s:?}"
        );
        assert_eq!(t.status("/p"), NgrokStatus::default(), "reported once");
    }

    #[test]
    fn starting_again_replaces_the_open_tunnel_and_stop_all_closes_every_one() {
        let dir = tempfile::tempdir().unwrap();
        let (addr, _) = api(json!({ "tunnels": [{ "public_url": "https://x.ngrok-free.app" }] }));
        let bin = fake_ngrok(dir.path(), &format!("{}\nexec sleep 30", web_log(addr)));
        let bin = bin.to_str().unwrap();
        let (t, _) = tunnels();
        let spec = || Spec::new(3000, "http", None).unwrap();
        t.start("/a", spec(), bin, Duration::from_secs(10)).unwrap();
        let first = pid_of(&t, "/a");
        t.start(
            "/a",
            Spec::new(4000, "tcp", None).unwrap(),
            bin,
            Duration::from_secs(10),
        )
        .unwrap();
        assert!(!running(first), "the old agent was stopped");
        assert_eq!(t.status("/a").port, Some(4000));
        t.start("/b", spec(), bin, Duration::from_secs(10)).unwrap();
        let pids = [pid_of(&t, "/a"), pid_of(&t, "/b")];
        t.stop_all();
        assert!(pids.iter().all(|&p| !running(p)));
        assert_eq!(t.status("/a"), NgrokStatus::default());
    }
}
