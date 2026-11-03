// Plane dogwatch: delegates the Plane tickets of every open project to the
// agents of its tmux session. The same job as scripts/plane-dogwatch.py,
// built into Work: a watcher thread, two IPC commands and an event. Both share
// .claude/plane_dogwatch_state.json and hold .claude/plane_dogwatch.lock for a
// whole cycle, so running the script as well never delegates a ticket twice.
//
//   Re-open  first: back to the dev who had it (or the first free dev), moved
//            to "In Progress" with the QA rejection in the prompt;
//   Todo     to the first free dev, moved to "In Progress";
//   Test     to the QA agent, who moves it to "Done" or "Re-open";
//   Done     the PM is told on Telegram, for a ticket seen before it was done.
use crate::{dogwatch, store, tmux};
use reqwest::Method;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::State;

const POLL: Duration = Duration::from_secs(5);
const HTTP_TIMEOUT: Duration = Duration::from_secs(20);
const STATE_FILE: &str = ".claude/plane_dogwatch_state.json";
const LOCK_FILE: &str = ".claude/plane_dogwatch.lock";
const DEFAULT_BASE_URL: &str = "https://plane.overzoom.it";
const DEFAULT_WORKSPACE: &str = "overzoom";
const MAX_TEXT: usize = 3000;
const CAPTURE_LINES: &str = "-40";
// Windows in order of preference: dev1 and dev2 develop; qa1 and qa perform QA.
const DEVS: [&str; 2] = ["dev1", "dev2"];
const QA: [&str; 2] = ["qa1", "qa"];
// Agent TUIs show these while they run.
const BUSY: [&str; 4] = [
    "esc to interrupt",
    "esc to cancel",
    "ctrl+c to interrupt",
    "ctrl+c to stop",
];
// OpenCode's TUI starts a fresh session with /new (alias /clear). A short
// pause lets the new session open before the task is typed.
const OPENCODE_RESET: &str = "/new";
const RESET_SETTLE: Duration = Duration::from_millis(400);
const PRUNE_FILE: &str = ".claude/opencode_cleanup.json";
const PRUNE_INTERVAL_SECS: u64 = 6 * 3600;
const KEEP_SESSIONS: usize = 5;

// ── Configuration ────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    pub project_id: String,
    pub workspace: String,
    pub base_url: String,
    pub(crate) api_key: String,
}

// A path segment of the Plane API: never a separator or a query.
pub(crate) fn safe_segment(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn literals(line: &str) -> Vec<&str> {
    let mut out = vec![];
    let mut rest = line;
    while let Some(start) = rest.find(['"', '\'']) {
        let quote = &rest[start..start + 1];
        let after = &rest[start + 1..];
        let Some(end) = after.find(quote) else { break };
        out.push(&after[..end]);
        rest = &after[end + 1..];
    }
    out
}

// NAME = "value" or NAME = os.getenv("VAR", "default") in plane_cli.py: the
// literal is read, the script is never run.
pub fn py_string(source: &str, name: &str) -> Option<String> {
    let line = source.lines().find(|l| {
        l.strip_prefix(name)
            .is_some_and(|rest| rest.trim_start().starts_with('='))
    })?;
    let found = literals(line);
    let value = if line.contains("getenv(") || line.contains("environ.get(") {
        found.get(1)
    } else {
        found.first()
    };
    value.filter(|v| !v.is_empty()).map(|v| v.to_string())
}

// The key goes in a header: only over TLS, or to this machine. The host is
// compared exactly: "localhost.evil.test" and "localhost@evil.test" are not
// this machine (the second one's real host is after the "@").
pub(crate) fn trusted_url(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return false;
    }
    match parsed.scheme() {
        "https" => true,
        "http" => matches!(
            parsed.host_str(),
            Some("localhost" | "127.0.0.1" | "::1" | "[::1]")
        ),
        _ => false,
    }
}

#[cfg(test)]
pub fn load_config(
    root: &Path,
    var: &dyn Fn(&str) -> Option<String>,
    cli: &str,
) -> Result<Config, String> {
    load_config_with(root, var, cli, None)
}

// The global Settings… file fills in what the project and the environment do
// not set. Its API key wins over the environment, as configured in the UI;
// its URL and workspace only apply when they differ from the built-in defaults,
// so a project's own .plane.json keeps working.
pub fn load_config_with(
    root: &Path,
    var: &dyn Fn(&str) -> Option<String>,
    cli: &str,
    saved: Option<&crate::settings::AppSettings>,
) -> Result<Config, String> {
    let path = root.join(".plane.json");
    let text =
        std::fs::read_to_string(&path).map_err(|_| format!("{} not found", path.display()))?;
    let local: Value =
        serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    let local = |k: &str| {
        local[k]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(String::from)
    };
    let var = |k: &str| var(k).filter(|s| !s.is_empty());
    let project_id =
        local("project_id").ok_or_else(|| format!("{} has no project_id", path.display()))?;
    let saved_key = saved
        .map(|s| s.plane_api_key.trim())
        .filter(|s| !s.is_empty())
        .map(String::from);
    let saved_workspace = saved
        .map(|s| s.plane_workspace.trim())
        .filter(|s| !s.is_empty() && *s != DEFAULT_WORKSPACE)
        .map(String::from);
    let saved_url = saved
        .map(|s| s.plane_base_url.trim_end_matches('/'))
        .filter(|s| !s.is_empty() && *s != DEFAULT_BASE_URL)
        .map(String::from);
    let api_key = saved_key
        .or_else(|| var("PLANE_API_KEY"))
        .or_else(|| py_string(cli, "API_KEY"))
        .ok_or("no Plane API key: set PLANE_API_KEY")?;
    let workspace = local("workspace_slug")
        .or_else(|| var("PLANE_WORKSPACE_SLUG"))
        .or(saved_workspace)
        .or_else(|| py_string(cli, "WORKSPACE_SLUG"))
        .unwrap_or_else(|| DEFAULT_WORKSPACE.into());
    let base_url = var("PLANE_BASE_URL")
        .or_else(|| local("base_url"))
        .or(saved_url)
        .or_else(|| py_string(cli, "PLANE_BASE_URL"))
        .unwrap_or_else(|| DEFAULT_BASE_URL.into())
        .trim_end_matches('/')
        .to_string();
    if !safe_segment(&project_id) || !safe_segment(&workspace) {
        return Err(format!(
            "{}: invalid project_id or workspace_slug",
            path.display()
        ));
    }
    if !trusted_url(&base_url) {
        return Err(format!(
            "Plane URL {base_url} is not https or a local address"
        ));
    }
    Ok(Config {
        project_id,
        workspace,
        base_url,
        api_key,
    })
}

fn real_config(root: &Path) -> Result<Config, String> {
    let cli = std::env::var_os("PLANE_CLI")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::mcp::home().join(".claude/scripts/plane_cli.py"));
    let source = std::fs::read_to_string(cli).unwrap_or_default();
    let saved = crate::settings::plane_settings();
    load_config_with(root, &|k| std::env::var(k).ok(), &source, Some(&saved))
}

// ── Plane REST API ───────────────────────────────────────────

pub struct Plane {
    root: String,
    key: String,
    client: reqwest::blocking::Client,
}

fn id(issue: &Value) -> &str {
    issue["id"].as_str().unwrap_or_default()
}

impl Plane {
    pub fn new(c: &Config) -> Result<Self, String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(HTTP_TIMEOUT)
            .user_agent("work-plane-dogwatch/1.0")
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            root: format!(
                "{}/api/v1/workspaces/{}/projects/{}",
                c.base_url, c.workspace, c.project_id
            ),
            key: c.api_key.clone(),
            client,
        })
    }

    // Errors name the call and the status, never the key.
    fn request(
        &self,
        method: Method,
        endpoint: &str,
        body: Option<Value>,
    ) -> Result<Value, String> {
        let fail = |what: String| format!("Plane {method} {endpoint}: {what}");
        let mut req = self
            .client
            .request(method.clone(), format!("{}/{endpoint}", self.root))
            .header("X-API-Key", &self.key);
        if let Some(body) = body {
            req = req.json(&body);
        }
        let resp = req.send().map_err(|e| fail(e.without_url().to_string()))?;
        if !resp.status().is_success() {
            return Err(fail(format!("HTTP {}", resp.status().as_u16())));
        }
        let text = resp.text().map_err(|e| fail(e.without_url().to_string()))?;
        if text.trim().is_empty() {
            return Ok(json!({}));
        }
        serde_json::from_str(&text).map_err(|e| fail(format!("invalid JSON: {e}")))
    }

    fn results(&self, endpoint: &str) -> Result<Vec<Value>, String> {
        let data = self.request(Method::GET, endpoint, None)?;
        Ok(data
            .get("results")
            .unwrap_or(&data)
            .as_array()
            .cloned()
            .unwrap_or_default())
    }

    // id -> name ("Todo", "In Progress"…).
    fn state_names(&self) -> Result<HashMap<String, String>, String> {
        Ok(self
            .results("states/")?
            .iter()
            .filter_map(|s| Some((s["id"].as_str()?.into(), s["name"].as_str()?.into())))
            .collect())
    }

    fn issues(&self) -> Result<Vec<Value>, String> {
        let mut issues = self.results("issues/")?;
        issues.retain(|i| safe_segment(id(i)));
        issues.sort_by_key(|i| i["sequence_id"].as_u64().unwrap_or(0));
        Ok(issues)
    }

    fn last_comment(&self, issue: &str) -> Result<String, String> {
        let mut comments = self.results(&format!("issues/{issue}/comments/"))?;
        comments.sort_by(|a, b| a["created_at"].as_str().cmp(&b["created_at"].as_str()));
        Ok(comments
            .last()
            .map(|c| plain(c["comment_html"].as_str(), 1500))
            .unwrap_or_default())
    }

    fn move_issue(&self, issue: &str, state_id: &str, comment: &str) -> Result<(), String> {
        self.request(
            Method::PATCH,
            &format!("issues/{issue}/"),
            Some(json!({ "state": state_id })),
        )?;
        self.request(
            Method::POST,
            &format!("issues/{issue}/comments/"),
            Some(json!({ "comment_html": format!("<p>{}</p>", escape_html(comment)) })),
        )?;
        Ok(())
    }
}

// ── Text ─────────────────────────────────────────────────────

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#x27;")
}

// The same decoder as the script's html.unescape: Plane writes named entities
// (&egrave;, &mdash;, …) that must reach the agent as text, not as markup.
fn unescape(s: &str) -> String {
    html_escape::decode_html_entities(s).into_owned()
}

// Plane's HTML as one line of text: a prompt is typed as a single line.
pub fn plain(fragment: Option<&str>, limit: usize) -> String {
    let mut text = String::new();
    let mut rest = fragment.unwrap_or_default();
    while let Some(start) = rest.find('<') {
        let Some(len) = rest[start..].find('>') else {
            break;
        };
        text.push_str(&rest[..start]);
        let tag = &rest[start + 1..start + len];
        let item = tag
            .strip_prefix("li")
            .is_some_and(|r| r.is_empty() || r.starts_with(char::is_whitespace));
        text.push_str(if item { " - " } else { " " });
        rest = &rest[start + len + 1..];
    }
    text.push_str(rest);
    let text = unescape(&text)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if text.chars().count() <= limit {
        return text;
    }
    let mut cut: String = text.chars().take(limit.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

// The same SHA-256 as the script's, so either one sees the other's work.
pub fn fingerprint(issue: &Value, state: &str) -> String {
    let field = |k: &str| issue[k].as_str().unwrap_or_default();
    let raw = [
        state,
        field("updated_at"),
        field("name"),
        field("description_html"),
    ]
    .join("\x1f");
    Sha256::digest(raw.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn ticket(issue: &Value) -> String {
    format!("Ticket [{}] (UUID: {})", issue["sequence_id"], id(issue))
}

fn title(issue: &Value) -> String {
    plain(issue["name"].as_str(), 200)
}

fn description(issue: &Value) -> String {
    plain(issue["description_html"].as_str(), MAX_TEXT)
}

fn or_none(text: &str) -> &str {
    if text.is_empty() {
        "nessun commento"
    } else {
        text
    }
}

pub fn dev_prompt(issue: &Value) -> String {
    format!(
        "[plane-dogwatch] Prendi in carico il {}: {}. Descrizione e criteri: {} \
         Il ticket è già In Progress su Plane. Sviluppa con i test, verifica npm test e cargo clippy, \
         committa secondo le convenzioni del progetto e sposta il ticket in 'Test' con commento tecnico in italiano.",
        ticket(issue),
        title(issue),
        description(issue)
    )
}

pub fn reopen_prompt(issue: &Value, reason: &str) -> String {
    format!(
        "[plane-dogwatch] Re-open del {}: {}. Motivo del QA: {} Descrizione: {} \
         Il ticket è già In Progress su Plane. Correggi con test di regressione, verifica npm test e cargo clippy, \
         committa e sposta il ticket in 'Test' con commento tecnico in italiano.",
        ticket(issue),
        title(issue),
        or_none(reason),
        description(issue)
    )
}

pub fn qa_prompt(issue: &Value, notes: &str) -> String {
    format!(
        "[plane-dogwatch] Valida il {} in Test: {}. Criteri: {} Note del dev (file modificati e test): {} \
         Esegui le verifiche end-to-end. Se tutti i criteri passano sposta il ticket in 'Done' con report QA in italiano; \
         altrimenti in 'Re-open' con la descrizione dettagliata del problema.",
        ticket(issue),
        title(issue),
        description(issue),
        or_none(notes)
    )
}

// ── Agents ───────────────────────────────────────────────────

fn input_line(line: &str) -> bool {
    let start = line.trim_start();
    let start = start
        .strip_prefix(['│', '|', '┃'])
        .map_or(start, str::trim_start);
    start.starts_with(['>', '❯', '›'])
        || line.trim_end().ends_with(['$', '#', '%', '❯', '>'])
        || line.to_lowercase().contains("ctrl+p commands")
}

// Idle: no question pending, no agent running, an input line near the bottom.
// shortcut: guessed from the screen, like the script; a command that prints a
// prompt-like line while it runs looks idle.
pub fn is_idle(capture: &str) -> bool {
    if dogwatch::parse_prompt(capture).is_some() {
        return false;
    }
    let lines: Vec<&str> = capture.lines().filter(|l| !l.trim().is_empty()).collect();
    let tail = &lines[lines.len().saturating_sub(6)..];
    let running = tail.iter().any(|l| {
        let l = l.to_lowercase();
        BUSY.iter().any(|b| l.contains(b))
    });
    !running && tail.iter().any(|l| input_line(l))
}

pub trait Agents {
    fn idle(&self, window: &str) -> bool;
    fn send(&self, window: &str, text: &str) -> Result<(), String>;
    // Reset a fresh OpenCode session; unsupported agents keep their context.
    fn is_opencode(&self, _window: &str) -> bool {
        false
    }
    fn reset(&self, _window: &str) -> Result<(), String> {
        Ok(())
    }
}

struct Tmux {
    session: String,
    windows: HashSet<String>,
}

impl Tmux {
    fn open(session: &str) -> Result<Self, String> {
        let windows = tmux::list_windows(session)?
            .into_iter()
            .map(|w| w.name)
            .collect();
        Ok(Self {
            session: session.into(),
            windows,
        })
    }
}

impl Agents for Tmux {
    fn idle(&self, window: &str) -> bool {
        let target = format!("{}:{window}", self.session);
        self.windows.contains(window)
            && tmux::run_tmux(&[
                "capture-pane",
                "-p",
                "-J",
                "-t",
                &target,
                "-S",
                CAPTURE_LINES,
            ])
            .is_ok_and(|c| is_idle(&c))
    }

    fn send(&self, window: &str, text: &str) -> Result<(), String> {
        dogwatch::answer(&self.session, window, text)
    }

    fn is_opencode(&self, window: &str) -> bool {
        let target = format!("{}:{window}", self.session);
        tmux::run_tmux(&[
            "display-message",
            "-p",
            "-t",
            &target,
            "#{pane_start_command}\t#{pane_current_command}",
        ])
        .is_ok_and(|command| command.to_lowercase().contains("opencode"))
    }

    fn reset(&self, window: &str) -> Result<(), String> {
        dogwatch::answer(&self.session, window, OPENCODE_RESET)?;
        std::thread::sleep(RESET_SETTLE);
        Ok(())
    }
}

// ── State file and lock ──────────────────────────────────────

fn load_state(path: &Path) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(|v| v["issues"].is_object())
        .unwrap_or_else(|| json!({ "issues": {} }))
}

// The record of an issue, made an object if missing: other fields stay.
fn record_mut<'a>(state: &'a mut Value, issue: &str) -> &'a mut Value {
    let record = &mut state["issues"][issue];
    if !record.is_object() {
        *record = json!({});
    }
    record
}

// The window a record still holds: its ticket sits in the role's working state.
fn holder<'a>(record: &'a Value, now: Option<&str>) -> Option<&'a str> {
    let working = match record["role"].as_str()? {
        "dev" => "in progress",
        "qa" => "test",
        _ => return None,
    };
    let target = record["target"].as_str().filter(|t| !t.is_empty())?;
    (now == Some(working)).then_some(target)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

// `opencode session list` is newest first: keep the N most recent sessions.
fn stale_session_ids(sessions: &[Value], keep: usize) -> Vec<String> {
    sessions
        .iter()
        .filter_map(|s| {
            s["id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .map(String::from)
        })
        .skip(keep)
        .collect()
}

// Old OpenCode sessions are deleted through the official CLI, never by
// touching the database: `session list` is scoped to this project and
// `session delete` removes child sessions too. Best effort, at most every 6 h.
fn prune_opencode_sessions(root: &Path, now: u64) {
    if std::env::var("WORK_OPENCODE_PRUNE").is_ok_and(|v| v == "0") {
        return;
    }
    let interval = std::env::var("WORK_OPENCODE_PRUNE_INTERVAL")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(PRUNE_INTERVAL_SECS);
    let keep = std::env::var("WORK_OPENCODE_KEEP")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(KEEP_SESSIONS)
        .max(1);
    let path = root.join(PRUNE_FILE);
    let last = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v["last_prune"].as_u64())
        .unwrap_or(0);
    if interval > 0 && now.saturating_sub(last) < interval {
        return;
    }
    let bin = std::env::var("WORK_OPENCODE_BIN").unwrap_or_else(|_| "opencode".into());
    let Ok(listed) = Command::new(&bin)
        .args(["session", "list", "--format", "json", "--max-count", "100"])
        .current_dir(root)
        .output()
    else {
        return;
    };
    if !listed.status.success() {
        return;
    }
    let sessions: Vec<Value> = serde_json::from_slice(&listed.stdout).unwrap_or_default();
    for session_id in stale_session_ids(&sessions, keep) {
        let _ = Command::new(&bin)
            .args(["session", "delete", &session_id])
            .current_dir(root)
            .output();
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&path, json!({ "last_prune": now }).to_string());
}

// flock, released when the file closes; the script takes the same one.
pub struct Lock {
    _file: std::fs::File,
}

pub fn try_lock(root: &Path) -> Option<Lock> {
    use std::os::fd::AsRawFd;
    let path = root.join(LOCK_FILE);
    std::fs::create_dir_all(path.parent()?).ok()?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path)
        .ok()?;
    let locked = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0;
    locked.then_some(Lock { _file: file })
}

// ── Cycle ────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Issue {
    pub issue: Option<u64>,
    pub id: String,
    pub state: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Action {
    pub issue: Option<u64>,
    pub id: String,
    pub from: String,
    pub to: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub telegram: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Waiting {
    pub issue: Option<u64>,
    pub state: &'static str,
    pub reason: String,
}

// The ticket an agent window is working on.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Assignment {
    pub window: String,
    pub issue: Option<u64>,
    pub id: String,
    pub state: String,
    pub name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Report {
    pub project: String,
    pub session: String,
    pub timestamp: String,
    pub issues: Vec<Issue>,
    pub actions: Vec<Action>,
    pub waiting: Vec<Waiting>,
    pub assignments: Vec<Assignment>,
    pub error: Option<String>,
}

struct Run<'a> {
    plane: &'a Plane,
    agents: &'a dyn Agents,
    path: &'a Path,
    state: Value,
    state_ids: HashMap<String, String>, // lower-case name -> id
    current: HashMap<String, String>,   // issue -> lower-case state name
    busy: HashSet<String>,
    actions: Vec<Action>,
    waiting: Vec<Waiting>,
}

impl Run<'_> {
    fn free(&self, candidates: &[&str]) -> Option<String> {
        candidates
            .iter()
            .find(|w| !self.busy.contains(**w) && self.agents.idle(w))
            .map(|w| w.to_string())
    }

    fn pending<'i>(&self, issues: &'i [Value], kind: &str) -> Vec<&'i Value> {
        issues
            .iter()
            .filter(|i| {
                self.current.get(id(i)).map(String::as_str) == Some(kind)
                    && self.state["issues"][id(i)]["hash"].as_str()
                        != Some(fingerprint(i, kind).as_str())
            })
            .collect()
    }

    fn wait(&mut self, issue: &Value, state: &'static str, reason: &str) {
        self.waiting.push(Waiting {
            issue: issue["sequence_id"].as_u64(),
            state,
            reason: reason.into(),
        });
    }

    // The prompt goes first and is recorded at once: a failure further on
    // (Plane down) must not type the same prompt again next cycle.
    fn delegate(
        &mut self,
        issue: &Value,
        (kind, label): (&str, &'static str),
        role: &str,
        target: String,
        prompt: &str,
        move_to: Option<&str>,
    ) {
        // A new task starts from a fresh OpenCode session: one active session,
        // no context left over from the ticket the agent just finished.
        if self.agents.is_opencode(&target) {
            let _ = self.agents.reset(&target);
        }
        if let Err(e) = self.agents.send(&target, prompt) {
            self.wait(issue, label, &format!("cannot type into {target}: {e}"));
            return;
        }
        self.busy.insert(target.clone());
        let record = record_mut(&mut self.state, id(issue));
        record["role"] = role.into();
        record["target"] = target.as_str().into();
        record["hash"] = fingerprint(issue, kind).into();
        record["handled"] = kind.into();
        record["timestamp"] = dogwatch::now_iso().into();
        let _ = store::save(self.path, &self.state);
        let mut action = Action {
            issue: issue["sequence_id"].as_u64(),
            id: id(issue).into(),
            from: kind.into(),
            to: move_to.unwrap_or(kind).into(),
            target: Some(target.clone()),
            error: None,
            telegram: None,
        };
        if let Some(state) = move_to {
            let moved = self
                .state_ids
                .get(&state.to_lowercase())
                .ok_or_else(|| format!("Plane state {state:?} not found"))
                .and_then(|sid| {
                    let note = format!(
                        "Presa in carico automatica da plane-dogwatch: delegato a {target}."
                    );
                    self.plane.move_issue(id(issue), sid, &note)
                });
            match moved {
                Ok(()) => {
                    self.current.insert(id(issue).into(), state.to_lowercase());
                }
                Err(e) => action.error = Some(e),
            }
        }
        self.actions.push(action);
    }
}

// One look at Plane and the agents. Returns the report without project,
// session and timestamp, which the caller knows.
pub fn run_cycle(
    plane: &Plane,
    agents: &dyn Agents,
    state_path: &Path,
    notify: &dyn Fn(&str) -> String,
) -> Result<Report, String> {
    let names = plane.state_names()?;
    let issues = plane.issues()?;
    let state = load_state(state_path);
    // Who held each ticket before this cycle's delegations overwrite "target".
    let before_cycle: HashMap<String, (String, String)> = state["issues"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(issue, r)| {
            (
                issue.clone(),
                (
                    r["state"].as_str().unwrap_or_default().to_string(),
                    r["target"].as_str().unwrap_or_default().to_string(),
                ),
            )
        })
        .collect();
    let state_of = |i: &Value| -> String {
        i["state"]
            .as_str()
            .and_then(|s| names.get(s))
            .map(|n| n.to_lowercase())
            .unwrap_or_default()
    };
    let current: HashMap<String, String> = issues
        .iter()
        .map(|i| (id(i).to_string(), state_of(i)))
        .collect();
    let busy = state["issues"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(issue, r)| holder(r, current.get(issue).map(String::as_str)))
        .map(String::from)
        .collect();
    let mut run = Run {
        plane,
        agents,
        path: state_path,
        state,
        state_ids: names
            .iter()
            .map(|(sid, n)| (n.to_lowercase(), sid.clone()))
            .collect(),
        current,
        busy,
        actions: vec![],
        waiting: vec![],
    };

    for issue in run.pending(&issues, "re-open") {
        let previous = run.state["issues"][id(issue)]["target"]
            .as_str()
            .filter(|t| DEVS.contains(t))
            .map(String::from);
        let target = previous
            .as_deref()
            .and_then(|p| run.free(&[p]))
            .or_else(|| run.free(&DEVS));
        let Some(target) = target else {
            run.wait(issue, "Re-open", "no free dev");
            continue;
        };
        let prompt = reopen_prompt(issue, &plane.last_comment(id(issue))?);
        run.delegate(
            issue,
            ("re-open", "Re-open"),
            "dev",
            target,
            &prompt,
            Some("In Progress"),
        );
    }

    for issue in run.pending(&issues, "todo") {
        let Some(target) = run.free(&DEVS) else {
            run.wait(issue, "Todo", "no free dev");
            continue;
        };
        run.delegate(
            issue,
            ("todo", "Todo"),
            "dev",
            target,
            &dev_prompt(issue),
            Some("In Progress"),
        );
    }

    for issue in run.pending(&issues, "test") {
        let Some(target) = run.free(&QA) else {
            run.wait(issue, "Test", "QA busy");
            continue;
        };
        let prompt = qa_prompt(issue, &plane.last_comment(id(issue))?);
        run.delegate(issue, ("test", "Test"), "qa", target, &prompt, None);
    }

    for issue in &issues {
        let now = run.current[id(issue)].clone();
        let (seen, prev_state, prev_target) = {
            let record = &run.state["issues"][id(issue)];
            let before = before_cycle.get(id(issue));
            (
                record["state"].as_str().unwrap_or_default().to_string(),
                before.map(|(s, _)| s.clone()).unwrap_or_default(),
                before.map(|(_, t)| t.clone()).unwrap_or_default(),
            )
        };
        // The task is over: reset the window that held it, if it is idle and
        // runs OpenCode, so the next ticket starts from a fresh session. Never
        // touch a window that received a new ticket in this same cycle: its
        // delegation already opened a fresh session and this cleanup would wipe it.
        if prev_state != now
            && matches!(now.as_str(), "test" | "done" | "re-open")
            && !prev_target.is_empty()
            && !run.busy.contains(&prev_target)
            && run.agents.is_opencode(&prev_target)
            && run.agents.idle(&prev_target)
        {
            let _ = run.agents.reset(&prev_target);
        }
        // A ticket already Done at the first look is history, not news.
        if now == "done" && !seen.is_empty() && seen != "done" {
            let sent = notify(&format!(
                "✅ {} completato: {}",
                ticket(issue),
                title(issue)
            ));
            run.actions.push(Action {
                issue: issue["sequence_id"].as_u64(),
                id: id(issue).into(),
                from: seen.clone(),
                to: "done".into(),
                target: None,
                error: None,
                telegram: Some(sent),
            });
        }
        if seen != now {
            let record = record_mut(&mut run.state, id(issue));
            record["state"] = now.into();
            record["timestamp"] = dogwatch::now_iso().into();
        }
    }
    store::save(state_path, &run.state).map_err(|e| format!("{}: {e}", state_path.display()))?;

    let display = |lower: &str| {
        names
            .values()
            .find(|n| n.to_lowercase() == lower)
            .cloned()
            .unwrap_or_else(|| lower.to_string())
    };
    let summary = |i: &Value| (i["sequence_id"].as_u64(), id(i).to_string(), title(i));
    let assignments = issues
        .iter()
        .filter_map(|i| {
            let now = run.current.get(id(i)).map(String::as_str);
            let window = holder(&run.state["issues"][id(i)], now)?;
            let (issue, id, name) = summary(i);
            Some(Assignment {
                window: window.into(),
                issue,
                id,
                state: display(now?),
                name,
            })
        })
        .collect();
    let active = issues
        .iter()
        .filter(|i| !matches!(run.current[id(i)].as_str(), "done" | "cancelled"))
        .map(|i| {
            let (issue, id, name) = summary(i);
            Issue {
                state: display(&run.current[&id]),
                issue,
                id,
                name,
            }
        })
        .collect();
    Ok(Report {
        issues: active,
        actions: run.actions,
        waiting: run.waiting,
        assignments,
        ..Default::default()
    })
}

// ── Watcher ──────────────────────────────────────────────────

#[derive(Serialize)]
pub struct PlaneDogwatchState {
    pub projects: Vec<Report>,
}

#[derive(Default)]
pub struct Watch {
    reports: Mutex<BTreeMap<String, Report>>,
    woken: Mutex<bool>,
    bell: Condvar,
}

impl Watch {
    fn sleep(&self) {
        let woken = self.woken.lock().unwrap();
        let (mut woken, _) = self.bell.wait_timeout_while(woken, POLL, |w| !*w).unwrap();
        *woken = false;
    }

    pub fn sync_now(&self) {
        *self.woken.lock().unwrap() = true;
        self.bell.notify_all();
    }

    pub fn status(&self) -> PlaneDogwatchState {
        PlaneDogwatchState {
            projects: self.reports.lock().unwrap().values().cloned().collect(),
        }
    }

    // True when the report says something new: the clock alone is not news.
    fn store(&self, report: Report) -> bool {
        let quiet = |r: &Report| Report {
            timestamp: String::new(),
            ..r.clone()
        };
        let previous = self
            .reports
            .lock()
            .unwrap()
            .insert(report.project.clone(), report.clone());
        previous.is_none_or(|old| quiet(&old) != quiet(&report))
    }
}

type Planes = HashMap<String, (Config, Plane)>;

// Ok(None): another plane dogwatch holds the lock; this round is skipped.
fn try_cycle(
    root: &Path,
    project: &str,
    session: &str,
    planes: &mut Planes,
    notify: &dyn Fn(&str) -> String,
) -> Result<Option<Report>, String> {
    let config = real_config(root)?;
    if planes.get(project).is_none_or(|(c, _)| *c != config) {
        let plane = Plane::new(&config)?;
        planes.insert(project.into(), (config, plane));
    }
    let agents = Tmux::open(session).map_err(|e| format!("tmux session {session}: {e}"))?;
    let Some(_lock) = try_lock(root) else {
        return Ok(None);
    };
    let report = run_cycle(&planes[project].1, &agents, &root.join(STATE_FILE), notify)?;
    prune_opencode_sessions(root, now_secs());
    Ok(Some(report))
}

// Every POLL (or at once after sync_now) each open project with a .plane.json
// gets a cycle; on_update hears each report that differs from the last one.
pub fn spawn(
    projects: impl Fn() -> Vec<String> + Send + 'static,
    notify: impl Fn(&str) -> String + Send + 'static,
    on_update: impl Fn(&Report) + Send + 'static,
) -> Arc<Watch> {
    let watch = Arc::new(Watch::default());
    if !tmux::is_available() {
        return watch;
    }
    let w = Arc::clone(&watch);
    std::thread::spawn(move || {
        let mut planes = Planes::new();
        loop {
            let open = projects();
            w.reports.lock().unwrap().retain(|p, _| open.contains(p));
            planes.retain(|p, _| open.contains(p));
            for project in &open {
                let root = Path::new(project);
                if !root.join(".plane.json").is_file() {
                    w.reports.lock().unwrap().remove(project);
                    continue;
                }
                let session = tmux::session_for_project(root);
                let base = Report {
                    project: project.clone(),
                    session: session.clone(),
                    timestamp: dogwatch::now_iso(),
                    ..Default::default()
                };
                let report = match try_cycle(root, project, &session, &mut planes, &notify) {
                    Ok(None) => continue,
                    Ok(Some(r)) => r.with(&base),
                    Err(e) => Report {
                        error: Some(e),
                        ..base
                    },
                };
                if w.store(report.clone()) {
                    on_update(&report);
                }
            }
            w.sleep();
        }
    });
    watch
}

impl Report {
    fn with(self, base: &Report) -> Report {
        Report {
            project: base.project.clone(),
            session: base.session.clone(),
            timestamp: base.timestamp.clone(),
            ..self
        }
    }
}

// ── IPC Commands ─────────────────────────────────────────────

#[tauri::command]
pub fn plane_dogwatch_status(watch: State<Arc<Watch>>) -> Result<PlaneDogwatchState, String> {
    Ok(watch.status())
}

#[tauri::command]
pub fn plane_dogwatch_sync_now(watch: State<Arc<Watch>>) -> Result<(), String> {
    watch.sync_now();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;

    // ── A local Plane ──

    #[derive(Debug, Clone)]
    struct Req {
        method: String,
        path: String,
        body: Value,
        key: String,
    }

    type Shared<T> = Arc<Mutex<T>>;

    struct Mock {
        url: String,
        requests: Shared<Vec<Req>>,
        issues: Shared<Vec<Value>>,
        comments: Shared<HashMap<String, Vec<Value>>>,
        fail: Shared<Option<(String, u16)>>, // (path, status) answered with an error
    }

    fn states() -> Value {
        json!({ "results": [
            { "id": "s-todo", "name": "Todo" },
            { "id": "s-progress", "name": "In Progress" },
            { "id": "s-test", "name": "Test" },
            { "id": "s-reopen", "name": "Re-open" },
            { "id": "s-done", "name": "Done" },
        ]})
    }

    fn issue(n: u64, state: &str) -> Value {
        json!({
            "id": format!("issue-{n}"),
            "sequence_id": n,
            "name": format!("Ticket title {n}"),
            "description_html": format!("<p>Description {n}</p><ul><li>criterion A{n}</li></ul>"),
            "updated_at": format!("2026-11-02T10:00:0{n}Z"),
            "state": state,
        })
    }

    fn route(m: &Mock, method: &str, path: &str, body: &Value) -> (u16, Value) {
        if let Some((p, code)) = m.fail.lock().unwrap().clone() {
            if p == path {
                return (code, json!({ "error": "no" }));
            }
        }
        let parts: Vec<&str> = path.trim_end_matches('/').split('/').collect();
        match (method, parts.as_slice()) {
            ("GET", ["states"]) => (200, states()),
            ("GET", ["issues"]) => (200, json!({ "results": *m.issues.lock().unwrap() })),
            ("GET", ["issues", id, "comments"]) => {
                let list = m
                    .comments
                    .lock()
                    .unwrap()
                    .get(*id)
                    .cloned()
                    .unwrap_or_default();
                (200, json!({ "results": list }))
            }
            ("PATCH", ["issues", id]) => {
                for i in m
                    .issues
                    .lock()
                    .unwrap()
                    .iter_mut()
                    .filter(|i| i["id"] == *id)
                {
                    i["state"] = body["state"].clone();
                }
                (200, json!({}))
            }
            ("POST", ["issues", _, "comments"]) => (201, json!({})),
            _ => (404, json!({})),
        }
    }

    fn serve(issues: Vec<Value>) -> Arc<Mock> {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mock = Arc::new(Mock {
            url: format!("http://{}", listener.local_addr().unwrap()),
            requests: Default::default(),
            issues: Arc::new(Mutex::new(issues)),
            comments: Default::default(),
            fail: Default::default(),
        });
        let m = Arc::clone(&mock);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                let mut words = first.split_whitespace();
                let method = words.next().unwrap_or_default().to_string();
                let full = words.next().unwrap_or_default().to_string();
                let (mut length, mut key) = (0, String::new());
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    let header = header.trim_end();
                    if header.is_empty() {
                        break;
                    }
                    let (k, v) = header.split_once(':').unwrap_or((header, ""));
                    if k.eq_ignore_ascii_case("content-length") {
                        length = v.trim().parse().unwrap_or(0);
                    }
                    if k.eq_ignore_ascii_case("x-api-key") {
                        key = v.trim().into();
                    }
                }
                let mut raw = vec![0; length];
                reader.read_exact(&mut raw).unwrap();
                let body: Value = serde_json::from_slice(&raw).unwrap_or(Value::Null);
                let path = full
                    .split_once("/api/v1/workspaces/ws/projects/proj/")
                    .map_or(full.clone(), |(_, p)| p.to_string());
                let (code, reply) = route(&m, &method, &path, &body);
                m.requests.lock().unwrap().push(Req {
                    method,
                    path,
                    body,
                    key,
                });
                let text = reply.to_string();
                let _ = write!(
                    stream,
                    "HTTP/1.1 {code} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
                    text.len()
                );
            }
        });
        mock
    }

    impl Mock {
        fn plane(&self) -> Plane {
            Plane::new(&Config {
                project_id: "proj".into(),
                workspace: "ws".into(),
                base_url: self.url.clone(),
                api_key: "secret-key".into(),
            })
            .unwrap()
        }

        fn writes(&self) -> Vec<Req> {
            self.requests
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r.method != "GET")
                .cloned()
                .collect()
        }

        fn set_state(&self, n: u64, state: &str) {
            for i in self
                .issues
                .lock()
                .unwrap()
                .iter_mut()
                .filter(|i| i["sequence_id"] == n)
            {
                i["state"] = state.into();
            }
        }
    }

    // ── Agents that only pretend ──

    #[derive(Default)]
    struct Fake {
        idle: RefCell<HashSet<String>>,
        sent: RefCell<Vec<(String, String)>>,
        opencode: RefCell<HashSet<String>>,
        resets: RefCell<Vec<String>>,
        events: RefCell<Vec<String>>,
    }

    fn agents(idle: &[&str]) -> Fake {
        let fake = Fake::default();
        fake.idle
            .borrow_mut()
            .extend(idle.iter().map(|w| w.to_string()));
        fake
    }

    impl Agents for Fake {
        fn idle(&self, window: &str) -> bool {
            self.idle.borrow().contains(window)
        }
        fn send(&self, window: &str, text: &str) -> Result<(), String> {
            self.sent.borrow_mut().push((window.into(), text.into()));
            self.events.borrow_mut().push(format!("send:{window}"));
            Ok(())
        }
        fn is_opencode(&self, window: &str) -> bool {
            self.opencode.borrow().contains(window)
        }
        fn reset(&self, window: &str) -> Result<(), String> {
            self.resets.borrow_mut().push(window.into());
            self.events.borrow_mut().push(format!("reset:{window}"));
            Ok(())
        }
    }

    struct Scene {
        mock: Arc<Mock>,
        plane: Plane,
        dir: tempfile::TempDir,
        notified: RefCell<Vec<String>>,
    }

    fn scenario(issues: Vec<Value>) -> Scene {
        let mock = serve(issues);
        Scene {
            plane: mock.plane(),
            mock,
            dir: tempfile::tempdir().unwrap(),
            notified: RefCell::new(vec![]),
        }
    }

    impl Scene {
        fn state_path(&self) -> PathBuf {
            self.dir.path().join(STATE_FILE)
        }
        fn cycle(&self, agents: &Fake) -> Report {
            let notify = |text: &str| {
                self.notified.borrow_mut().push(text.into());
                "sent".to_string()
            };
            run_cycle(&self.plane, agents, &self.state_path(), &notify).unwrap()
        }
        fn state(&self) -> Value {
            serde_json::from_str(&std::fs::read_to_string(self.state_path()).unwrap()).unwrap()
        }
        fn seed(&self, state: Value) {
            store::save(&self.state_path(), &state).unwrap();
        }
    }

    fn moves(r: &Report) -> Vec<(Option<u64>, String, String, Option<String>)> {
        r.actions
            .iter()
            .map(|a| (a.issue, a.from.clone(), a.to.clone(), a.target.clone()))
            .collect()
    }

    // ── Cycle ──

    #[test]
    fn todo_goes_to_the_first_free_dev_and_moves_to_in_progress_with_a_comment() {
        let b = scenario(vec![issue(1, "s-todo")]);
        let a = agents(&["dev1", "dev2"]);
        let r = b.cycle(&a);
        assert_eq!(
            moves(&r),
            [(
                Some(1),
                "todo".into(),
                "In Progress".into(),
                Some("dev1".into())
            )]
        );
        let writes = b.mock.writes();
        assert_eq!(
            (writes[0].method.as_str(), writes[0].path.as_str()),
            ("PATCH", "issues/issue-1/")
        );
        assert_eq!(writes[0].body["state"], "s-progress");
        assert!(writes[1].body["comment_html"]
            .as_str()
            .unwrap()
            .contains("delegato a dev1"));

        let sent = a.sent.borrow();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].0, "dev1");
        assert!(sent[0]
            .1
            .contains("Ticket [1] (UUID: issue-1): Ticket title 1"));
        assert!(
            sent[0].1.contains("Description 1 - criterion A1"),
            "{}",
            sent[0].1
        );
        assert!(!sent[0].1.contains("<p>"));

        let state = b.state();
        let record = &state["issues"]["issue-1"];
        assert_eq!(
            (record["target"].as_str(), record["role"].as_str()),
            (Some("dev1"), Some("dev"))
        );
        assert_eq!(record["state"], "in progress");
        assert_eq!(record["hash"].as_str().unwrap().len(), 64);
        assert_eq!(r.assignments.len(), 1);
        assert_eq!(
            (
                r.assignments[0].window.as_str(),
                r.assignments[0].state.as_str()
            ),
            ("dev1", "In Progress")
        );
        assert_eq!(r.issues[0].state, "In Progress");
    }

    #[test]
    fn an_unchanged_ticket_is_never_delegated_twice() {
        let b = scenario(vec![issue(1, "s-todo"), issue(3, "s-test")]);
        let a = agents(&["dev1", "dev2", "qa"]);
        b.cycle(&a);
        assert_eq!(a.sent.borrow().len(), 2, "Todo to dev1, Test to qa");
        let writes = b.mock.writes().len();

        b.mock.set_state(1, "s-todo"); // pretend nobody moved it: still the same version
        let again = agents(&["dev1", "dev2", "qa"]);
        let mut s = b.state();
        s["issues"]["issue-1"]["state"] = "todo".into();
        b.seed(s);
        let r = b.cycle(&again);
        assert!(r.actions.is_empty(), "{:?}", r.actions);
        assert!(again.sent.borrow().is_empty());
        assert_eq!(b.mock.writes().len(), writes, "no new write on Plane");
    }

    #[test]
    fn re_open_comes_first_goes_back_to_its_dev_and_carries_the_qa_rejection() {
        let b = scenario(vec![issue(1, "s-todo"), issue(2, "s-reopen")]);
        b.mock.comments.lock().unwrap().insert(
            "issue-2".into(),
            vec![
                json!({ "created_at": "2026-11-02T09:00:00Z", "comment_html": "<p>old</p>" }),
                json!({ "created_at": "2026-11-02T11:00:00Z", "comment_html": "<p>Il bottone &egrave; rotto &amp; lento</p>" }),
            ],
        );
        b.seed(json!({ "issues": { "issue-2": { "role": "dev", "target": "dev2", "state": "test", "custom": 7 } } }));
        let a = agents(&["dev1", "dev2"]);
        let r = b.cycle(&a);
        assert_eq!(
            moves(&r),
            [
                (
                    Some(2),
                    "re-open".into(),
                    "In Progress".into(),
                    Some("dev2".into())
                ),
                (
                    Some(1),
                    "todo".into(),
                    "In Progress".into(),
                    Some("dev1".into())
                ),
            ]
        );
        let sent = a.sent.borrow();
        assert!(
            sent[0]
                .1
                .contains("Motivo del QA: Il bottone è rotto & lento"),
            "{}",
            sent[0].1
        );
        assert_eq!(
            b.state()["issues"]["issue-2"]["custom"],
            7,
            "fields of the script are kept"
        );
    }

    #[test]
    fn test_goes_to_qa1_or_qa_and_devs_do_not_take_qa_tickets() {
        let b = scenario(vec![issue(3, "s-test")]);
        b.mock.comments.lock().unwrap().insert(
            "issue-3".into(),
            vec![json!({ "created_at": "x", "comment_html": "<p>Modificati: a.rs. Test: npm test</p>" })],
        );
        let a = agents(&["qa1", "dev2"]);
        let r = b.cycle(&a);
        assert_eq!(
            moves(&r),
            [(Some(3), "test".into(), "test".into(), Some("qa1".into()))]
        );
        assert!(a.sent.borrow()[0]
            .1
            .contains("Note del dev (file modificati e test): Modificati: a.rs. Test: npm test"));
        assert!(b.mock.writes().is_empty(), "QA moves it, not the dogwatch");
        assert_eq!(r.assignments[0].window, "qa1");

        let b = scenario(vec![issue(3, "s-test")]);
        let a = agents(&["qa"]);
        assert_eq!(
            b.cycle(&a).actions[0].target.as_deref(),
            Some("qa"),
            "fallback to qa"
        );

        let b = scenario(vec![issue(3, "s-test")]);
        let a = agents(&["dev1", "dev2"]);
        let r = b.cycle(&a);
        assert!(r.actions.is_empty(), "devs do not take QA tickets");
        assert_eq!(r.waiting[0].reason, "QA busy");
    }

    #[test]
    fn a_busy_pane_gets_nothing_and_a_dev_holding_a_ticket_is_not_free() {
        let b = scenario(vec![issue(1, "s-todo"), issue(5, "s-progress")]);
        b.seed(json!({ "issues": { "issue-5": { "role": "dev", "target": "dev1", "state": "in progress" } } }));
        let a = agents(&["dev1"]); // dev1 looks idle but holds issue 5; dev2 is busy
        let r = b.cycle(&a);
        assert!(r.actions.is_empty());
        assert!(a.sent.borrow().is_empty());
        assert_eq!(
            r.waiting,
            [Waiting {
                issue: Some(1),
                state: "Todo",
                reason: "no free dev".into()
            }]
        );
        assert_eq!(r.assignments[0].window, "dev1");
        assert_eq!(r.assignments[0].issue, Some(5));
    }

    #[test]
    fn done_is_notified_once_and_only_for_a_ticket_seen_before() {
        let b = scenario(vec![issue(1, "s-done"), issue(2, "s-progress")]);
        let a = agents(&[]);
        b.cycle(&a);
        assert!(
            b.notified.borrow().is_empty(),
            "done at the first look is history"
        );

        b.mock.set_state(2, "s-done");
        let r = b.cycle(&a);
        assert_eq!(
            b.notified.borrow().as_slice(),
            ["✅ Ticket [2] (UUID: issue-2) completato: Ticket title 2"]
        );
        assert_eq!(r.actions[0].telegram.as_deref(), Some("sent"));
        assert_eq!(
            (r.actions[0].from.as_str(), r.actions[0].to.as_str()),
            ("in progress", "done")
        );
        assert!(r.issues.is_empty(), "done tickets are not active");

        b.cycle(&a);
        assert_eq!(b.notified.borrow().len(), 1);
    }

    #[test]
    fn a_failed_move_is_reported_and_the_prompt_is_not_typed_again() {
        let b = scenario(vec![issue(1, "s-todo")]);
        *b.mock.fail.lock().unwrap() = Some(("issues/issue-1/".into(), 500));
        let a = agents(&["dev1"]);
        let r = b.cycle(&a);
        assert_eq!(
            r.actions[0].error.as_deref(),
            Some("Plane PATCH issues/issue-1/: HTTP 500")
        );

        let again = agents(&["dev1", "dev2"]);
        assert!(b.cycle(&again).actions.is_empty());
        assert!(again.sent.borrow().is_empty());
    }

    #[test]
    fn http_errors_name_the_call_never_the_key() {
        let b = scenario(vec![]);
        *b.mock.fail.lock().unwrap() = Some(("states/".into(), 401));
        let notify = |_: &str| String::new();
        let err = run_cycle(&b.plane, &agents(&[]), &b.state_path(), &notify).unwrap_err();
        assert_eq!(err, "Plane GET states/: HTTP 401");
        assert_eq!(
            b.mock.requests.lock().unwrap()[0].key,
            "secret-key",
            "the key travels in the header"
        );
        assert!(!b.state_path().exists(), "nothing written");

        let down = Plane::new(&Config {
            project_id: "proj".into(),
            workspace: "ws".into(),
            base_url: "http://127.0.0.1:1".into(),
            api_key: "secret-key".into(),
        })
        .unwrap();
        let err = run_cycle(&down, &agents(&[]), &b.state_path(), &notify).unwrap_err();
        assert!(err.starts_with("Plane GET states/: "), "{err}");
        assert!(!err.contains("secret-key"));
    }

    #[test]
    fn issues_with_odd_ids_never_reach_a_url() {
        let b = scenario(vec![
            json!({ "id": "../x", "sequence_id": 9, "state": "s-todo" }),
            issue(1, "s-todo"),
        ]);
        let r = b.cycle(&agents(&["dev1", "dev2"]));
        assert_eq!(r.actions.len(), 1);
        assert_eq!(r.actions[0].id, "issue-1");
    }

    // ── Pieces ──

    #[test]
    fn the_fingerprint_is_the_scripts_one() {
        let one = json!({ "updated_at": "2026-11-02T10:00:00Z", "name": "Titolo è", "description_html": "<p>x</p>" });
        assert_eq!(
            fingerprint(&one, "todo"),
            "2ec46fd956109ca0b61ca31b943c47e1ba52b778700fcefa1692c5c783d9f675"
        );
        let two = json!({ "updated_at": null, "name": "n" });
        assert_eq!(
            fingerprint(&two, "test"),
            "36e5adf97a007a89302078dd00a9450da9545a1f83308a282577b6e550cc8360"
        );
    }

    #[test]
    fn html_becomes_one_line_of_text() {
        assert_eq!(
            plain(
                Some("<p>Uno &amp; due</p><ul><li>A</li><li>B &lt;c&gt;</li></ul>"),
                100
            ),
            "Uno & due - A - B <c>"
        );
        assert_eq!(
            plain(Some("<link href=x>a&#233;&#x41;&nbsp;b"), 100),
            "aéA b"
        );
        assert_eq!(
            plain(
                Some("<p>Il bottone &egrave; rotto &mdash; davvero &amp; lento</p>"),
                100
            ),
            "Il bottone è rotto — davvero & lento",
            "named entities as html.unescape, not just the five XML ones"
        );
        assert_eq!(plain(Some("a < b & c"), 100), "a < b & c");
        assert_eq!(plain(None, 10), "");
        assert_eq!(plain(Some("abcdefghij"), 5), "abcd…");
        assert_eq!(escape_html("a<b>&\"'"), "a&lt;b&gt;&amp;&quot;&#x27;");
    }

    #[test]
    fn an_idle_pane_shows_an_input_line_and_nothing_running() {
        assert!(is_idle("done\nuser@host:~/p$ "));
        assert!(is_idle("output\n│ > \n"));
        assert!(
            is_idle("╭──╮\n┃ Ask anything\n  tab agents  ctrl+p commands\n"),
            "opencode TUI"
        );
        assert!(
            !is_idle("Thinking…\n> \n  esc to interrupt\n"),
            "an agent at work"
        );
        assert!(
            !is_idle("Do you want to proceed?\n❯ 1. Yes\n  2. No\n"),
            "a pending question"
        );
        assert!(!is_idle("compiling\nbuilding 12/40"), "no input line");
        assert!(!is_idle(""));
    }

    #[test]
    fn only_https_or_the_local_machine_is_trusted() {
        for good in [
            "https://plane.example.it",
            "http://127.0.0.1:8080",
            "http://localhost:8080",
            "http://[::1]:8080",
        ] {
            assert!(trusted_url(good), "{good}");
        }
        for bad in [
            "http://plane.example.it",
            "http://localhost.evil.test",
            "http://localhost@evil.test",
            "http://127.0.0.1.evil.test",
            "http://localhost:8080@evil.test",
            "ftp://localhost",
            "https://user@evil.test",
        ] {
            assert!(!trusted_url(bad), "{bad}");
        }
    }

    #[test]
    fn the_config_comes_from_plane_json_the_environment_and_plane_cli() {
        let dir = tempfile::tempdir().unwrap();
        let none = |_: &str| None;
        let cli = "PLANE_BASE_URL = \"https://plane.example.it/\"\nWORKSPACE_SLUG = 'acme'\nAPI_KEY = os.getenv(\"PLANE_API_KEY\", \"from-cli\")\n";
        assert!(load_config(dir.path(), &none, cli)
            .unwrap_err()
            .contains("not found"));

        std::fs::write(
            dir.path().join(".plane.json"),
            r#"{"project_id": "3b32-41"}"#,
        )
        .unwrap();
        let c = load_config(dir.path(), &none, cli).unwrap();
        assert_eq!(
            (
                c.project_id.as_str(),
                c.workspace.as_str(),
                c.base_url.as_str()
            ),
            ("3b32-41", "acme", "https://plane.example.it")
        );
        assert_eq!(c.api_key, "from-cli");

        let env = |k: &str| (k == "PLANE_API_KEY").then(|| "from-env".to_string());
        assert_eq!(
            load_config(dir.path(), &env, cli).unwrap().api_key,
            "from-env"
        );
        let c = load_config(dir.path(), &none, "").unwrap_err();
        assert_eq!(c, "no Plane API key: set PLANE_API_KEY");
        assert_eq!(
            py_string("API_KEY = os.getenv(\"PLANE_API_KEY\")", "API_KEY"),
            None,
            "no default"
        );
        assert_eq!(py_string("API_KEY_OLD = \"x\"", "API_KEY"), None);

        std::fs::write(
            dir.path().join(".plane.json"),
            r#"{"project_id": "../../x"}"#,
        )
        .unwrap();
        assert!(load_config(dir.path(), &none, cli)
            .unwrap_err()
            .contains("invalid"));
        std::fs::write(
            dir.path().join(".plane.json"),
            r#"{"project_id": "p", "base_url": "http://plane.example.it"}"#,
        )
        .unwrap();
        assert!(
            load_config(dir.path(), &none, "API_KEY = \"k\"")
                .unwrap_err()
                .contains("not https"),
            "the key never travels in clear"
        );
        for base_url in [
            "http://localhost.evil.test",
            "http://localhost@evil.test",
            "http://127.0.0.1.evil.test",
        ] {
            std::fs::write(
                dir.path().join(".plane.json"),
                format!(r#"{{"project_id": "p", "base_url": "{base_url}"}}"#),
            )
            .unwrap();
            assert!(
                load_config(dir.path(), &none, "API_KEY = \"k\"")
                    .unwrap_err()
                    .contains("not https"),
                "{base_url}"
            );
        }
        std::fs::write(dir.path().join(".plane.json"), r#"{"workspace_slug": "w"}"#).unwrap();
        assert!(load_config(dir.path(), &none, cli)
            .unwrap_err()
            .contains("no project_id"));
    }

    #[test]
    fn one_cycle_at_a_time_holds_the_lock() {
        let dir = tempfile::tempdir().unwrap();
        let first = try_lock(dir.path()).expect("free");
        assert!(try_lock(dir.path()).is_none(), "taken");
        drop(first);
        assert!(try_lock(dir.path()).is_some(), "released");
    }

    #[test]
    fn only_a_different_report_is_news() {
        let watch = Watch::default();
        let report = Report {
            project: "/p".into(),
            timestamp: "t1".into(),
            ..Default::default()
        };
        assert!(watch.store(report.clone()), "the first one");
        assert!(
            !watch.store(Report {
                timestamp: "t2".into(),
                ..report.clone()
            }),
            "only the clock moved"
        );
        assert!(watch.store(Report {
            error: Some("down".into()),
            ..report
        }));
        assert_eq!(watch.status().projects.len(), 1);
    }

    #[test]
    fn sync_now_wakes_the_watcher_before_the_poll() {
        let watch = Arc::new(Watch::default());
        let w = Arc::clone(&watch);
        let start = std::time::Instant::now();
        let sleeper = std::thread::spawn(move || w.sleep());
        std::thread::sleep(Duration::from_millis(50));
        watch.sync_now();
        sleeper.join().unwrap();
        assert!(start.elapsed() < POLL);
    }

    #[test]
    fn an_opencode_dev_is_reset_before_a_delegated_task() {
        let b = scenario(vec![issue(1, "s-todo")]);
        let a = agents(&["dev1", "dev2"]);
        a.opencode.borrow_mut().insert("dev1".into());
        b.cycle(&a);
        assert_eq!(
            a.events.borrow().as_slice(),
            ["reset:dev1", "send:dev1"],
            "the fresh session opens before the task is typed"
        );
        assert_eq!(a.resets.borrow().as_slice(), ["dev1"]);
    }

    #[test]
    fn a_ticket_leaving_the_working_state_resets_its_idle_opencode_window() {
        let b = scenario(vec![issue(1, "s-todo")]);
        let a = agents(&["dev1", "dev2", "qa1", "qa"]);
        a.opencode.borrow_mut().insert("dev1".into());
        b.cycle(&a);
        b.mock.set_state(1, "s-test");
        let r = b.cycle(&a);
        assert_eq!(
            a.resets.borrow().as_slice(),
            ["dev1", "dev1"],
            "once before the task and once when the ticket reaches Test"
        );
        assert_eq!(
            a.events.borrow().as_slice(),
            ["reset:dev1", "send:dev1", "send:qa1", "reset:dev1"]
        );
        assert_eq!(moves(&r)[0].3.as_deref(), Some("qa1"));
    }

    #[test]
    fn cleanup_does_not_wipe_a_task_delegated_to_the_same_window_in_the_same_cycle() {
        let b = scenario(vec![issue(1, "s-todo"), issue(2, "s-todo")]);
        let a = agents(&["dev1"]); // only dev1 is free: ticket 2 waits for cycle 2
        a.opencode.borrow_mut().insert("dev1".into());
        b.cycle(&a);
        assert_eq!(a.resets.borrow().as_slice(), ["dev1"]);
        b.mock.set_state(1, "s-test");

        let second = b.cycle(&a);
        assert_eq!(
            a.resets.borrow().as_slice(),
            ["dev1", "dev1"],
            "one reset per new task; the completion cleanup must skip dev1"
        );
        assert_eq!(
            a.events.borrow().as_slice(),
            ["reset:dev1", "send:dev1", "reset:dev1", "send:dev1"],
            "the last action is ticket 2's prompt, not a reset that would wipe it"
        );
        assert_eq!(moves(&second)[0].0, Some(2));
    }

    #[test]
    fn stale_sessions_keep_the_newest_ones() {
        let sessions = vec![json!({"id":"a"}), json!({"id":"b"}), json!({"id":"c"})];
        assert_eq!(stale_session_ids(&sessions, 1), ["b", "c"]);
        assert!(stale_session_ids(&[], 3).is_empty());
        let with_empty = vec![json!({"id":""}), json!({"id":"x"})];
        assert_eq!(stale_session_ids(&with_empty, 0), ["x"]);
    }
}
