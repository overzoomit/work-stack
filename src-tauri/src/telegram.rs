// Telegram bridge for the PM: the only team role with a remote channel.
// Incoming messages are typed into the PM window; outgoing messages come from
// the UI (telegram_send) and from dogwatch escalations, so the PM can decide
// whether a product/user decision is needed. Dev and QA windows never talk to
// the bot: they only go through the PM and dogwatch.
use crate::dogwatch;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

const API: &str = "https://api.telegram.org";
const POLL_TIMEOUT_SECS: u64 = 25;
const HTTP_TIMEOUT_SECS: u64 = 40;
const MAX_TEXT: usize = 4000;
const MAX_RECENT_MESSAGES: usize = 200;
// Voice notes are short by nature; the cap keeps a bad file from filling the
// cache or holding the polling thread.
const MAX_VOICE_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetProject {
    pub name: String,
    pub path: String,
    pub session: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub connected: bool,
    pub bot: Option<String>,
    pub chat_id: Option<String>,
    pub project: Option<String>,
    pub session: Option<String>,
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_project: Option<String>,
    pub is_pinned: bool,
}

#[derive(Clone)]
struct Config {
    token: String,
    chat_id: String,
    bot: String,
    project: String,
    session: String,
}

pub type ProjectsResolver = Box<dyn Fn() -> (Option<String>, Vec<TargetProject>) + Send + Sync>;

pub struct TelegramState {
    config: Mutex<Option<Config>>,
    last_error: Mutex<Option<String>>,
    // Bumped on connect/disconnect: an old polling thread sees a different
    // generation and stops after the request it is waiting on.
    generation: AtomicU64,
    projects_resolver: Mutex<Option<ProjectsResolver>>,
    pinned_target: Mutex<Option<String>>,
    recent_messages: Mutex<HashMap<i64, TargetProject>>,
}

impl TelegramState {
    pub fn new() -> Self {
        Self {
            config: Mutex::new(None),
            last_error: Mutex::new(None),
            generation: AtomicU64::new(0),
            projects_resolver: Mutex::new(None),
            pinned_target: Mutex::new(None),
            recent_messages: Mutex::new(HashMap::new()),
        }
    }

    pub fn set_projects_resolver<F>(&self, resolver: F)
    where
        F: Fn() -> (Option<String>, Vec<TargetProject>) + Send + Sync + 'static,
    {
        *self.projects_resolver.lock().unwrap() = Some(Box::new(resolver));
    }

    pub fn set_pinned_target(&self, target: Option<String>) {
        *self.pinned_target.lock().unwrap() = target;
    }

    pub fn record_message(&self, message_id: i64, target: TargetProject) {
        let mut map = self.recent_messages.lock().unwrap();
        if map.len() >= MAX_RECENT_MESSAGES {
            if let Some(&oldest) = map.keys().min() {
                map.remove(&oldest);
            }
        }
        map.insert(message_id, target);
    }

    fn resolve_projects(&self, config: &Config) -> (Option<String>, Vec<TargetProject>) {
        if let Some(ref resolver) = *self.projects_resolver.lock().unwrap() {
            let (active, list) = resolver();
            if !list.is_empty() {
                return (active, list);
            }
        }
        let name = project_name_from_path(&config.project);
        let target = TargetProject {
            name,
            path: config.project.clone(),
            session: config.session.clone(),
        };
        (Some(config.project.clone()), vec![target])
    }

    fn status(&self) -> Status {
        let config = self.config.lock().unwrap().clone();
        let last_error = self.last_error.lock().unwrap().clone();
        match config {
            Some(c) => {
                let (active_opt, projects) = self.resolve_projects(&c);
                let pinned_opt = self.pinned_target.lock().unwrap().clone();
                let current_target =
                    resolve_target(active_opt.as_deref(), pinned_opt.as_deref(), &projects);
                let is_pinned = pinned_opt.is_some();
                let target_name = current_target.as_ref().map(|t| t.name.clone());
                let target_session = current_target
                    .as_ref()
                    .map(|t| t.session.clone())
                    .or_else(|| Some(c.session.clone()));
                let active_name = active_opt.as_deref().map(project_name_from_path);

                Status {
                    connected: true,
                    bot: Some(c.bot),
                    chat_id: Some(c.chat_id),
                    project: Some(c.project),
                    session: target_session,
                    last_error,
                    active_project: active_name,
                    target_project: target_name,
                    is_pinned,
                }
            }
            None => Status {
                connected: false,
                bot: None,
                chat_id: None,
                project: None,
                session: None,
                last_error,
                active_project: None,
                target_project: None,
                is_pinned: false,
            },
        }
    }

    fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    fn set_error(&self, error: Option<String>) {
        *self.last_error.lock().unwrap() = error;
    }
}

impl Default for TelegramState {
    fn default() -> Self {
        Self::new()
    }
}

// ── PM CLI configuration ─────────────────────────────────────
// The bot token and the authorized chat are saved here on connect, so the PM
// can send with scripts/telegram-pm.py from its own window. The CLI has no
// recipient argument: it can only write to the chat configured by Work.
const CONFIG_FILE: &str = "telegram.json";

fn config_file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(CONFIG_FILE))
}

// On disk the bot configuration is also what lets Work reconnect on the next
// start. The token never leaves this file: the status sent to the UI has only
// the bot name and the chat id.
#[derive(Clone, Debug, Deserialize)]
struct SavedConfig {
    token: String,
    chat_id: String,
    #[serde(default)]
    bot: Option<String>,
    #[serde(default)]
    project: Option<String>,
    #[serde(default)]
    session: Option<String>,
}

fn write_config_file(path: &Path, config: &Config) {
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let body = json!({
        "token": config.token,
        "chat_id": config.chat_id,
        "bot": config.bot,
        "project": config.project,
        "session": config.session,
    });
    let tmp = path.with_extension("json.tmp");
    if fs::write(&tmp, body.to_string()).is_err() {
        return;
    }
    // The token is a secret: keep it readable by the user only.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    let _ = fs::rename(&tmp, path);
}

fn read_config_file(path: &Path) -> Option<SavedConfig> {
    let saved: SavedConfig = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
    (valid_token(&saved.token) && valid_chat_id(&saved.chat_id)).then_some(saved)
}

fn remove_config_file(path: &Path) {
    let _ = fs::remove_file(path);
}

fn save_config(app: &AppHandle, config: &Config) {
    if let Some(path) = config_file(app) {
        write_config_file(&path, config);
    }
}

fn clear_config(app: &AppHandle) {
    if let Some(path) = config_file(app) {
        remove_config_file(&path);
    }
}

// The saved connection knows its project and session. Older files only had
// the bot fields: fall back to the active project of this start-up.
fn restore_target(
    saved: SavedConfig,
    fallback_project: Option<&str>,
    fallback_session: Option<&str>,
) -> Option<Config> {
    let project = saved
        .project
        .filter(|p| !p.is_empty())
        .or_else(|| fallback_project.filter(|p| !p.is_empty()).map(String::from))?;
    let session = saved
        .session
        .filter(|s| !s.is_empty())
        .or_else(|| fallback_session.filter(|s| !s.is_empty()).map(String::from))?;
    Some(Config {
        token: saved.token,
        chat_id: saved.chat_id,
        bot: saved.bot.unwrap_or_else(|| "bot".into()),
        project,
        session,
    })
}

// Load the saved connection and hand it to `connect`. None means there is
// nothing to restore (no file, invalid file, or no project/session to use).
fn restore_from<F>(
    path: &Path,
    fallback_project: Option<&str>,
    fallback_session: Option<&str>,
    connect: F,
) -> Option<Result<Status, String>>
where
    F: FnOnce(Config) -> Result<Status, String>,
{
    let target = restore_target(read_config_file(path)?, fallback_project, fallback_session)?;
    Some(connect(target))
}

// Called once at start-up: if the app was connected before the restart, the
// same bot and chat are reconnected without asking the user again. A failure
// is shown in the Telegram panel, but the saved file stays for the next try.
pub fn restore(app: &AppHandle, state: &Arc<TelegramState>, active_project: Option<&str>) {
    if state.config.lock().unwrap().is_some() {
        return;
    }
    let Some(path) = config_file(app) else {
        return;
    };
    let fallback_session = active_project.map(|p| crate::tmux::session_for_project(Path::new(p)));
    let connected = restore_from(
        &path,
        active_project,
        fallback_session.as_deref(),
        |config| {
            connect_inner(
                app,
                state,
                config.token,
                config.chat_id,
                config.project,
                config.session,
                false,
            )
        },
    );
    if let Some(Err(error)) = connected {
        state.set_error(Some(error));
        emit_status(app, state);
    }
}

// ── Validation and parsing ───────────────────────────────────

// Bot tokens look like "<bot id>:<35ish characters>". Validate before putting
// them in a URL, so a typo is a clear error and not a request to another host.
pub fn valid_token(token: &str) -> bool {
    let Some((id, secret)) = token.split_once(':') else {
        return false;
    };
    !id.is_empty()
        && id.chars().all(|c| c.is_ascii_digit())
        && secret.len() >= 20
        && secret
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

// A chat id is a positive number, or -100... for a channel.
pub fn valid_chat_id(chat_id: &str) -> bool {
    let digits = chat_id.strip_prefix('-').unwrap_or(chat_id);
    !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())
}

pub fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn api_url(token: &str, method: &str) -> String {
    format!("{API}/bot{token}/{method}")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InboundMessage {
    pub text: String,
    pub reply_to_id: Option<i64>,
    pub reply_to_text: Option<String>,
}

pub fn parse_inbound(update: &Value, chat_id: &str) -> Option<InboundMessage> {
    let message = &update["message"];
    if message["chat"]["id"].as_i64()?.to_string() != chat_id {
        return None;
    }
    let text = message["text"].as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    let reply_to = message.get("reply_to_message");
    let reply_to_id = reply_to
        .and_then(|r| r.get("message_id"))
        .and_then(|id| id.as_i64());
    let reply_to_text = reply_to
        .and_then(|r| r.get("text"))
        .and_then(|t| t.as_str())
        .map(String::from);

    Some(InboundMessage {
        text: text.to_string(),
        reply_to_id,
        reply_to_text,
    })
}

// A voice note from the authorized chat: the file id is what getFile needs.
// Parsed separately so a non-text message can never crash the text path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InboundVoice {
    pub file_id: String,
    pub message_id: i64,
    pub duration: u64,
    pub mime_type: String,
    pub file_size: u64,
    pub reply_to_id: Option<i64>,
    pub reply_to_text: Option<String>,
}

pub fn parse_voice(update: &Value, chat_id: &str) -> Option<InboundVoice> {
    let message = &update["message"];
    if message["chat"]["id"].as_i64()?.to_string() != chat_id {
        return None;
    }
    let voice = message.get("voice")?;
    let file_id = voice["file_id"].as_str()?.trim();
    if file_id.is_empty() {
        return None;
    }
    let reply_to = message.get("reply_to_message");
    Some(InboundVoice {
        file_id: file_id.to_string(),
        message_id: message["message_id"].as_i64().unwrap_or(0),
        duration: voice["duration"].as_u64().unwrap_or(0),
        mime_type: voice["mime_type"]
            .as_str()
            .unwrap_or("audio/ogg")
            .to_string(),
        file_size: voice["file_size"].as_u64().unwrap_or(0),
        reply_to_id: reply_to
            .and_then(|r| r.get("message_id"))
            .and_then(|id| id.as_i64()),
        reply_to_text: reply_to
            .and_then(|r| r.get("text"))
            .and_then(|t| t.as_str())
            .map(String::from),
    })
}

// Only messages from the configured chat reach the PM. Anything else is
// ignored: this is what keeps the bot a PM-only channel.
#[allow(dead_code)]
pub fn inbound(update: &Value, chat_id: &str) -> Option<String> {
    parse_inbound(update, chat_id).map(|m| m.text)
}

// The only message a connection sends on its own: no dev/QA prompt is ever
// forwarded automatically. The PM decides what to relay with telegram_send.
pub fn welcome_message(project: &str) -> String {
    format!(
        "🤖 Work PM bot connected to {project}.\nMessages here are typed into the PM window. Only this chat is accepted.\nAgent escalations stay in the PM: relay one here only when the PM decides to."
    )
}

// ── PM reply capture ─────────────────────────────────────────
// When the PM answers a Telegram message, its output is on screen in the
// pm window. After typing the message we watch that pane and send the new,
// non-decoration lines back to the authorized chat.

const REPLY_SCAN_LINES: u32 = 120;
const REPLY_POLL: Duration = Duration::from_millis(750);
const REPLY_IDLE: Duration = Duration::from_secs(3);
const REPLY_TIMEOUT: Duration = Duration::from_secs(120);

fn capture_pm(session: &str) -> Option<String> {
    crate::tmux::capture_pane(session, "pm", Some(REPLY_SCAN_LINES)).ok()
}

// The part of `after` that follows the last screen still visible from
// `before`. When the pane scrolled, the suffix overlap finds the new tail;
// otherwise the unchanged head is dropped and the appended reply remains.
pub fn new_lines(before: &str, after: &str) -> String {
    let b: Vec<&str> = before.lines().collect();
    let a: Vec<&str> = after.lines().collect();
    for k in (1..=a.len().min(b.len())).rev() {
        if a[..k] == b[b.len() - k..] {
            return a[k..].join("\n");
        }
    }
    // No scroll overlap: drop the unchanged head (the reply is appended below).
    let common = a.iter().zip(b.iter()).take_while(|(x, y)| x == y).count();
    a[common..].join("\n")
}

// Box-drawing, progress bars and agent TUI markers (bullets, spinners, status)
// are not part of the PM's text reply.
pub fn is_chrome(line: &str) -> bool {
    let text = line.trim();
    if text.is_empty() {
        return false;
    }
    // Box-drawing, dividers and separator lines
    if text
        .chars()
        .all(|c| c.is_whitespace() || "╭╮╰╯─│┌┐└┘├┤┬┴┼═║╔╗╚╝█▀▄".contains(c))
    {
        return true;
    }
    // Agent status/tool lines, thinking headers and braille spinners
    // e.g. "● Ran 4 commands...", "● Edited 1 file...", "○ Thought for...", "▸ Thought for..."
    if text.starts_with(['●', '○', '▸', '◆', '◇']) {
        return true;
    }
    // Braille spinner lines (e.g. "⣾ Running command...")
    if text
        .chars()
        .next()
        .is_some_and(|c| ('\u{2800}'..='\u{28FF}').contains(&c))
    {
        return true;
    }
    // TUI controls, cancellation hints and status bar headers
    let lower = text.to_lowercase();
    if lower.starts_with("wait for background task")
        || lower.contains("conversation compacted")
        || lower.starts_with("tip:")
        || lower.starts_with("press esc to")
        || lower.starts_with("esc to cancel")
        || lower.starts_with("esc to interrupt")
        || lower.starts_with("ctrl+c to interrupt")
        || lower.starts_with("ctrl+o to expand")
        || (lower.contains("gemini") && lower.contains("flash"))
        || (lower.contains("claude") && lower.contains("code"))
    {
        return true;
    }
    false
}

pub fn is_agent_busy(screen: &str) -> bool {
    screen.lines().any(|line| {
        let text = line.trim();
        let lower = text.to_lowercase();
        text.chars().any(|c| ('\u{2800}'..='\u{28FF}').contains(&c))
            || lower.contains("running command")
            || lower.contains("esc to cancel")
            || lower.contains("esc to interrupt")
            || lower.contains("ctrl+c to interrupt")
            || lower.starts_with("thinking...")
    })
}

fn is_echo(line: &str, sent: &str) -> bool {
    let text = line.trim().trim_start_matches(['>', '❯', '│']).trim();
    text == sent.trim()
}

// The text to send back: new lines only, without the echoed user message,
// empty lines and the TUI decoration. None when the PM said nothing new.
pub fn reply_text(before: &str, after: &str, sent: &str) -> Option<String> {
    if before == after {
        return None;
    }
    // When the sent message appears in `after`, any text before that line
    // belongs to previous turns and must never be included in the reply.
    let after_lines: Vec<&str> = after.lines().collect();
    let prompt_idx = after_lines.iter().rposition(|line| is_echo(line, sent));

    let fresh_slice = match prompt_idx {
        Some(idx) => &after_lines[idx + 1..],
        None => {
            // Fallback: if the echoed prompt scrolled out of the capture buffer,
            // compute new lines between before and after.
            let fresh = new_lines(before, after);
            return clean_reply(fresh.lines(), sent);
        }
    };
    clean_reply(fresh_slice.iter().copied(), sent)
}

fn clean_reply<'a>(lines: impl Iterator<Item = &'a str>, sent: &str) -> Option<String> {
    let mut collected = Vec::new();
    for line in lines {
        if line.trim().is_empty() || is_chrome(line) || is_echo(line, sent) {
            continue;
        }
        let clean = line.trim_matches(|c: char| c.is_whitespace() || c == '│');
        // Drop lone prompt characters like ">" or "❯" at the very bottom
        if clean == ">" || clean == "❯" {
            continue;
        }
        collected.push(clean);
    }
    let text = collected.join("\n").trim().to_string();
    (!text.is_empty()).then(|| truncate(&text, MAX_TEXT))
}

// Wait until the reply stops changing, then return it. `stopped` observes a
// disconnect or a new connection; `capture` reads the pm pane.
pub fn collect_reply(
    baseline: &str,
    capture: impl Fn() -> Option<String>,
    stopped: impl Fn() -> bool,
    sent: &str,
    poll: Duration,
    idle: Duration,
    timeout: Duration,
) -> Option<String> {
    let start = Instant::now();
    let mut last_screen: Option<String> = None;
    let mut last_reply: Option<String> = None;
    let mut last_change = Instant::now();
    loop {
        if stopped() {
            return None;
        }
        if let Some(screen) = capture() {
            let busy = is_agent_busy(&screen);
            if last_screen.as_deref() != Some(screen.as_str()) {
                last_screen = Some(screen.clone());
                last_change = Instant::now();
            }
            if let Some(reply) = reply_text(baseline, &screen, sent) {
                last_reply = Some(reply);
            }
            // A non-empty reply is complete only when the agent has stopped working
            // (no spinners or cancellation hints) and the output has stayed idle.
            if !busy && last_reply.is_some() && last_change.elapsed() >= idle {
                return last_reply;
            }
        }
        if start.elapsed() >= timeout {
            return last_reply;
        }
        thread::sleep(poll);
    }
}

// ── HTTP client ──────────────────────────────────────────────

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Impossibile preparare la richiesta a Telegram: {e}"))
}

fn call(
    client: &reqwest::blocking::Client,
    token: &str,
    method: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let mut request = client.post(api_url(token, method));
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .map_err(|e| format!("Telegram non raggiungibile: {}", e.without_url()))?;
    let status = response.status();
    let value: Value = response
        .json()
        .map_err(|_| format!("Risposta di Telegram non valida ({status})"))?;
    if !status.is_success() || value["ok"] != true {
        let reason = value["description"]
            .as_str()
            .unwrap_or("richiesta rifiutata da Telegram");
        return Err(format!("Telegram: {reason}"));
    }
    Ok(value)
}

pub fn project_name_from_path(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(path)
        .to_string()
}

pub fn resolve_target(
    active_path: Option<&str>,
    pinned_name: Option<&str>,
    projects: &[TargetProject],
) -> Option<TargetProject> {
    if let Some(pin) = pinned_name {
        if let Some(found) = projects
            .iter()
            .find(|p| p.name.eq_ignore_ascii_case(pin) || p.session.eq_ignore_ascii_case(pin))
        {
            return Some(found.clone());
        }
    }
    if let Some(active) = active_path {
        if let Some(found) = projects.iter().find(|p| {
            p.path == active
                || p.name.eq_ignore_ascii_case(active)
                || p.session.eq_ignore_ascii_case(active)
        }) {
            return Some(found.clone());
        }
    }
    projects.first().cloned()
}

pub fn extract_project_from_text(text: &str, projects: &[TargetProject]) -> Option<TargetProject> {
    let trimmed = text.trim();
    if let Some(start) = trimmed.find('[') {
        if let Some(end) = trimmed[start + 1..].find(']') {
            let tag = trimmed[start + 1..start + 1 + end].trim();
            if let Some(found) = projects
                .iter()
                .find(|p| p.name.eq_ignore_ascii_case(tag) || p.session.eq_ignore_ascii_case(tag))
            {
                return Some(found.clone());
            }
        }
    }
    None
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RouteResult {
    CommandReply(String),
    ForwardToPm { target: TargetProject, text: String },
}

pub fn route_inbound(
    inbound: &InboundMessage,
    active_path: Option<&str>,
    pinned_name: Option<&str>,
    projects: &[TargetProject],
    recent: &HashMap<i64, TargetProject>,
) -> (RouteResult, Option<Option<String>>) {
    let raw = inbound.text.trim();

    // 1. Comandi bot
    if raw.eq_ignore_ascii_case("/projects")
        || raw.eq_ignore_ascii_case("/progetti")
        || raw.eq_ignore_ascii_case("/list")
    {
        if projects.is_empty() {
            return (
                RouteResult::CommandReply("📂 Nessun progetto aperto in Work.".into()),
                None,
            );
        }
        let mut reply = String::from("📂 Progetti aperti in Work:\n");
        for (i, p) in projects.iter().enumerate() {
            let is_active = active_path.is_some_and(|a| a == p.path || a == p.name);
            let is_pinned = pinned_name.is_some_and(|pin| pin.eq_ignore_ascii_case(&p.name));
            let mut tags = Vec::new();
            if is_active {
                tags.push("ATTIVO");
            }
            if is_pinned {
                tags.push("PINNED");
            }
            let tag_str = if tags.is_empty() {
                String::new()
            } else {
                format!(" [{}]", tags.join(", "))
            };
            reply.push_str(&format!(
                "{}. {} (sessione: {}){}\n",
                i + 1,
                p.name,
                p.session,
                tag_str
            ));
        }
        reply.push_str("\nComandi:\n• /use <nome o numero> per fissare il canale su un progetto\n• /use auto per seguire il progetto attivo in Work\n• @<nome> <messaggio> per inviare a un PM specifico");
        return (RouteResult::CommandReply(reply), None);
    }

    if let Some(arg) = raw
        .strip_prefix("/use")
        .or_else(|| raw.strip_prefix("/switch"))
    {
        let arg = arg.trim();
        if arg.is_empty() {
            return (
                RouteResult::CommandReply(
                    "Uso: /use <nome_progetto o numero> oppure /use auto".into(),
                ),
                None,
            );
        }
        if arg.eq_ignore_ascii_case("auto") || arg.eq_ignore_ascii_case("reset") {
            return (
                RouteResult::CommandReply(
                    "🔄 Target reimpostato su AUTO: il canale Telegram segue il progetto attivo in Work."
                        .into(),
                ),
                Some(None),
            );
        }
        // Tentativo indice 1..=projects.len()
        if let Ok(idx) = arg.parse::<usize>() {
            if idx >= 1 && idx <= projects.len() {
                let target = &projects[idx - 1];
                return (
                    RouteResult::CommandReply(format!(
                        "🎯 Target fissato su \"{}\" (sessione: {}). I prossimi messaggi andranno al suo PM.",
                        target.name, target.session
                    )),
                    Some(Some(target.name.clone())),
                );
            }
        }
        // Match per nome o sessione
        if let Some(target) = projects.iter().find(|p| {
            p.name.eq_ignore_ascii_case(arg)
                || p.session.eq_ignore_ascii_case(arg)
                || p.path.ends_with(arg)
        }) {
            return (
                RouteResult::CommandReply(format!(
                    "🎯 Target fissato su \"{}\" (sessione: {}). I prossimi messaggi andranno al suo PM.",
                    target.name, target.session
                )),
                Some(Some(target.name.clone())),
            );
        }
        return (
            RouteResult::CommandReply(format!(
                "❌ Progetto \"{}\" non trovato tra i progetti aperti. Digita /projects per vedere l'elenco.",
                arg
            )),
            None,
        );
    }

    if raw.eq_ignore_ascii_case("/status") {
        let current_target = resolve_target(active_path, pinned_name, projects);
        let mode_str = if pinned_name.is_some() {
            "FISSO (pinned)"
        } else {
            "AUTO (segue UI)"
        };
        let target_desc = match current_target {
            Some(t) => format!("{} (sessione: {}:pm)", t.name, t.session),
            None => "Nessun target disponibile".into(),
        };
        let msg = format!(
            "🤖 Stato Telegram Work:\n• Modalità: {}\n• Target corrente: {}\n• Progetti aperti: {}",
            mode_str,
            target_desc,
            projects.len()
        );
        return (RouteResult::CommandReply(msg), None);
    }

    if raw.eq_ignore_ascii_case("/help") || raw.eq_ignore_ascii_case("/start") {
        let msg = "🤖 Bot Telegram Work Stack (Multi-PM):\n\n\
            • Rispondi a un messaggio (Reply) per parlare direttamente con il PM di quel progetto.\n\
            • Anteponi @<progetto> al messaggio per parlare con un PM specifico (es. @work-stack status).\n\
            • /projects - Elenca i progetti aperti in Work.\n\
            • /use <progetto> - Fissa i messaggi su un progetto specifico.\n\
            • /use auto - Segue il progetto attivo nella finestra di Work.\n\
            • /status - Mostra lo stato e il target corrente.";
        return (RouteResult::CommandReply(msg.into()), None);
    }

    // 2. Controllo Reply-to
    if let Some(reply_id) = inbound.reply_to_id {
        if let Some(target) = recent.get(&reply_id) {
            return (
                RouteResult::ForwardToPm {
                    target: target.clone(),
                    text: raw.to_string(),
                },
                None,
            );
        }
    }
    if let Some(ref reply_text) = inbound.reply_to_text {
        if let Some(target) = extract_project_from_text(reply_text, projects) {
            return (
                RouteResult::ForwardToPm {
                    target,
                    text: raw.to_string(),
                },
                None,
            );
        }
    }

    // 3. Controllo Prefisso One-shot (@progetto o [progetto])
    if let Some(after_at) = raw.strip_prefix('@') {
        let (prefix, rest) = match after_at.find(|c: char| c.is_whitespace() || c == ':') {
            Some(idx) => (
                &after_at[..idx],
                after_at[idx..]
                    .trim_start_matches(|c: char| c.is_whitespace() || c == ':')
                    .trim(),
            ),
            None => (after_at, ""),
        };
        if let Some(target) = projects
            .iter()
            .find(|p| p.name.eq_ignore_ascii_case(prefix) || p.session.eq_ignore_ascii_case(prefix))
        {
            let text_to_send = if rest.is_empty() { raw } else { rest };
            return (
                RouteResult::ForwardToPm {
                    target: target.clone(),
                    text: text_to_send.to_string(),
                },
                None,
            );
        }
    } else if raw.starts_with('[') {
        if let Some(end) = raw.find(']') {
            let prefix = raw[1..end].trim();
            let rest = raw[end + 1..].trim();
            if let Some(target) = projects.iter().find(|p| {
                p.name.eq_ignore_ascii_case(prefix) || p.session.eq_ignore_ascii_case(prefix)
            }) {
                let text_to_send = if rest.is_empty() { raw } else { rest };
                return (
                    RouteResult::ForwardToPm {
                        target: target.clone(),
                        text: text_to_send.to_string(),
                    },
                    None,
                );
            }
        }
    }

    // 4. Fallback: risoluzione target (pinned o attivo)
    if let Some(target) = resolve_target(active_path, pinned_name, projects) {
        return (
            RouteResult::ForwardToPm {
                target,
                text: raw.to_string(),
            },
            None,
        );
    }

    (
        RouteResult::CommandReply(
            "⚠️ Nessun progetto aperto o attivo in Work. Apri un progetto o usa /projects.".into(),
        ),
        None,
    )
}

fn send_message(
    client: &reqwest::blocking::Client,
    config: &Config,
    text: &str,
) -> Result<i64, String> {
    let res = call(
        client,
        &config.token,
        "sendMessage",
        Some(json!({
            "chat_id": config.chat_id,
            "text": truncate(text, MAX_TEXT),
            "disable_web_page_preview": true,
        })),
    )?;
    let msg_id = res["result"]["message_id"].as_i64().unwrap_or(0);
    Ok(msg_id)
}

// ── Voice notes ──────────────────────────────────────────────
// The file name is built here from the message id, never from Telegram's path:
// the remote path only chooses a known extension, so it cannot escape the
// cache directory.
fn voice_extension(file_path: &str) -> &'static str {
    match Path::new(file_path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("oga") => "oga",
        Some("ogg") => "ogg",
        Some("mp3") => "mp3",
        Some("m4a") => "m4a",
        Some("wav") => "wav",
        Some("opus") => "opus",
        _ => "oga",
    }
}

// Telegram paths look like "voice/file_12.oga". Anything else is refused
// before it enters the download URL.
fn safe_remote_path(path: &str) -> Option<&str> {
    (!path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '.'))
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != ".."))
    .then_some(path)
}

fn voice_file_name(message_id: i64, file_path: &str) -> String {
    format!(
        "telegram-{}.{}",
        message_id.max(0),
        voice_extension(file_path)
    )
}

fn too_big() -> String {
    format!(
        "il vocale supera il limite di {} MB",
        MAX_VOICE_BYTES / (1024 * 1024)
    )
}

fn voice_prompt(voice: &InboundVoice, path: &Path) -> String {
    format!(
        "🎙️ Vocale Telegram ({} s, {}) salvato in {}. Trascrivilo con gli strumenti disponibili, gestisci la richiesta e rispondi qui.",
        voice.duration,
        voice.mime_type,
        path.display()
    )
}

// Downloads the note into the app cache. A failure is reported to the chat,
// never to the polling loop: one bad voice message must not stop the bot.
fn receive_voice(
    app: &AppHandle,
    client: &reqwest::blocking::Client,
    config: &Config,
    voice: &InboundVoice,
) -> Result<String, String> {
    if voice.file_size > MAX_VOICE_BYTES {
        return Err(too_big());
    }
    let info = call(
        client,
        &config.token,
        "getFile",
        Some(json!({ "file_id": voice.file_id })),
    )?;
    let file_path = info["result"]["file_path"]
        .as_str()
        .ok_or("Telegram non ha restituito il percorso del vocale")?;
    let size = info["result"]["file_size"]
        .as_u64()
        .unwrap_or(voice.file_size);
    if size > MAX_VOICE_BYTES {
        return Err(too_big());
    }
    let remote = safe_remote_path(file_path).ok_or("percorso del vocale non valido")?;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("cartella cache non disponibile: {e}"))?
        .join("voice");
    fs::create_dir_all(&dir).map_err(|e| format!("impossibile creare {}: {e}", dir.display()))?;
    let dest = dir.join(voice_file_name(voice.message_id, remote));
    let url = format!("{API}/file/bot{}/{remote}", config.token);
    let response = client
        .get(&url)
        .send()
        .map_err(|e| format!("download del vocale fallito: {}", e.without_url()))?;
    if !response.status().is_success() {
        return Err(format!(
            "Telegram ha rifiutato il download del vocale (HTTP {})",
            response.status().as_u16()
        ));
    }
    let bytes = response
        .bytes()
        .map_err(|e| format!("vocale non leggibile: {e}"))?;
    if bytes.len() as u64 > MAX_VOICE_BYTES {
        return Err(too_big());
    }
    // Write then rename, so a truncated download never looks complete.
    let tmp = dest.with_extension("part");
    fs::write(&tmp, &bytes).map_err(|e| format!("impossibile salvare {}: {e}", tmp.display()))?;
    fs::rename(&tmp, &dest).map_err(|e| format!("impossibile salvare {}: {e}", dest.display()))?;
    Ok(voice_prompt(voice, &dest))
}

// ── Polling thread ───────────────────────────────────────────

pub fn emit_status(app: &AppHandle, state: &Arc<TelegramState>) {
    let _ = app.emit("telegram:status", state.status());
}

fn poll(app: AppHandle, state: Arc<TelegramState>, config: Config, generation: u64, offset: i64) {
    let client = match client() {
        Ok(c) => c,
        Err(e) => {
            state.set_error(Some(e));
            emit_status(&app, &state);
            return;
        }
    };
    let mut offset = offset;
    loop {
        if state.generation() != generation {
            return;
        }
        let update = call(
            &client,
            &config.token,
            "getUpdates",
            Some(json!({
                "offset": offset,
                "timeout": POLL_TIMEOUT_SECS,
                "allowed_updates": ["message"],
            })),
        );
        match update {
            Ok(value) => {
                state.set_error(None);
                for update in value["result"].as_array().into_iter().flatten() {
                    if let Some(id) = update["update_id"].as_i64() {
                        offset = offset.max(id + 1);
                    }
                    let mut voice_error = None;
                    let (inbound_msg, is_voice) = match parse_inbound(update, &config.chat_id) {
                        Some(message) => (Some(message), false),
                        None => match parse_voice(update, &config.chat_id) {
                            Some(voice) => match receive_voice(&app, &client, &config, &voice) {
                                Ok(text) => (
                                    Some(InboundMessage {
                                        text,
                                        reply_to_id: voice.reply_to_id,
                                        reply_to_text: voice.reply_to_text,
                                    }),
                                    true,
                                ),
                                Err(e) => {
                                    voice_error = Some(e);
                                    (None, false)
                                }
                            },
                            None => (None, false),
                        },
                    };
                    if let Some(e) = voice_error {
                        let notice = format!("❌ Vocale non ricevuto: {e}");
                        let _ = send_message(&client, &config, &notice);
                        let _ = app.emit(
                            "telegram:message",
                            json!({ "direction": "out", "text": notice, "error": e, "voice": true }),
                        );
                    }
                    if let Some(inbound_msg) = inbound_msg {
                        let (active_path, projects) = state.resolve_projects(&config);
                        let pinned = state.pinned_target.lock().unwrap().clone();
                        let recent = state.recent_messages.lock().unwrap().clone();

                        let (action, new_pinned) = route_inbound(
                            &inbound_msg,
                            active_path.as_deref(),
                            pinned.as_deref(),
                            &projects,
                            &recent,
                        );
                        if let Some(next_pin) = new_pinned {
                            state.set_pinned_target(next_pin);
                            emit_status(&app, &state);
                        }

                        match action {
                            RouteResult::CommandReply(reply_text) => {
                                let _ = send_message(&client, &config, &reply_text);
                                let _ = app.emit(
                                    "telegram:message",
                                    json!({
                                        "direction": "out",
                                        "text": reply_text,
                                    }),
                                );
                            }
                            RouteResult::ForwardToPm { target, text } => {
                                let baseline = capture_pm(&target.session).unwrap_or_default();
                                let typed = dogwatch::answer(&target.session, "pm", &text);
                                let error = typed.as_ref().err().cloned();
                                let _ = app.emit(
                                    "telegram:message",
                                    json!({
                                        "direction": "in",
                                        "text": text,
                                        "project": target.name,
                                        "session": target.session,
                                        "typed": typed.is_ok(),
                                        "error": error,
                                        "voice": is_voice,
                                    }),
                                );
                                if let Err(e) = typed {
                                    let err_msg = format!(
                                        "❌ Impossibile inviare al PM di {}: {}",
                                        target.name, e
                                    );
                                    let _ = send_message(&client, &config, &err_msg);
                                    continue;
                                }
                                let stopped = || state.generation() != generation;
                                let reply = collect_reply(
                                    &baseline,
                                    || capture_pm(&target.session),
                                    stopped,
                                    &text,
                                    REPLY_POLL,
                                    REPLY_IDLE,
                                    REPLY_TIMEOUT,
                                );
                                if let Some(reply) = reply {
                                    let formatted = format!("[{}] {}", target.name, reply);
                                    match send_message(&client, &config, &formatted) {
                                        Ok(msg_id) => {
                                            if msg_id > 0 {
                                                state.record_message(msg_id, target.clone());
                                            }
                                            let _ = app.emit(
                                                "telegram:message",
                                                json!({
                                                    "direction": "out",
                                                    "text": formatted,
                                                    "project": target.name,
                                                    "session": target.session,
                                                }),
                                            );
                                        }
                                        Err(e) => {
                                            state.set_error(Some(e));
                                            emit_status(&app, &state);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Err(e) => {
                state.set_error(Some(e));
                emit_status(&app, &state);
                // Back off a little, then try again while this generation lives.
                for _ in 0..10 {
                    if state.generation() != generation {
                        return;
                    }
                    thread::sleep(Duration::from_millis(300));
                }
                offset = offset.max(0);
            }
        }
    }
}

// ── Commands ─────────────────────────────────────────────────

#[tauri::command]
pub fn telegram_status(state: State<Arc<TelegramState>>) -> Status {
    state.status()
}

#[tauri::command]
pub fn telegram_connect(
    app: AppHandle,
    state: State<Arc<TelegramState>>,
    token: String,
    chat_id: String,
    project: String,
    session: String,
) -> Result<Status, String> {
    connect_inner(&app, state.inner(), token, chat_id, project, session, true)
}

fn connect_inner(
    app: &AppHandle,
    state: &Arc<TelegramState>,
    token: String,
    chat_id: String,
    project: String,
    session: String,
    replace_saved: bool,
) -> Result<Status, String> {
    let token = token.trim().to_string();
    let chat_id = chat_id.trim().to_string();
    if !valid_token(&token) {
        return Err(
            "Token non valido: copia quello di @BotFather (formato <id>:<segreto>).".into(),
        );
    }
    if !valid_chat_id(&chat_id) {
        return Err("Chat ID non valido: deve essere un numero (es. 123456789).".into());
    }
    if session.is_empty() {
        return Err("Sessione tmux non disponibile: apri il progetto e riprova.".into());
    }

    // Stop any previous bot before validating the new token.
    state.generation.fetch_add(1, Ordering::SeqCst);
    *state.config.lock().unwrap() = None;
    state.set_error(None);
    // A manual connect replaces the old saved bot; a start-up restore keeps
    // the file until the token is accepted, so a temporary failure does not
    // erase the connection the user configured.
    if replace_saved {
        clear_config(app);
    }

    let http = client()?;
    let me = call(&http, &token, "getMe", None).map_err(|e| {
        // The token itself must never end up in an error shown to the user.
        if e.contains("401") || e.to_lowercase().contains("unauthorized") {
            "Token rifiutato da Telegram: controlla di aver copiato quello giusto.".to_string()
        } else {
            e
        }
    })?;
    let bot = me["result"]["username"]
        .as_str()
        .or_else(|| me["result"]["first_name"].as_str())
        .unwrap_or("bot")
        .to_string();

    let config = Config {
        token,
        chat_id,
        bot,
        project,
        session,
    };
    *state.config.lock().unwrap() = Some(config.clone());
    save_config(app, &config);
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    emit_status(app, state);

    let welcome = (config.clone(), welcome_message(&config.project));
    thread::spawn(move || {
        if let Ok(client) = client() {
            let _ = send_message(&client, &welcome.0, &welcome.1);
        }
    });

    let app2 = app.clone();
    let state2 = Arc::clone(state);
    let config2 = config.clone();
    thread::spawn(move || poll(app2, state2, config2, generation, 0));

    Ok(state.status())
}

#[tauri::command]
pub fn telegram_disconnect(app: AppHandle, state: State<Arc<TelegramState>>) -> Status {
    state.generation.fetch_add(1, Ordering::SeqCst);
    *state.config.lock().unwrap() = None;
    state.set_error(None);
    clear_config(&app);
    emit_status(&app, &state);
    state.status()
}

// The authorized chat only, as for the PM: Work's own notices (plane dogwatch) go there too.
pub fn notify(state: &TelegramState, text: &str) -> Result<i64, String> {
    let config = state
        .config
        .lock()
        .unwrap()
        .clone()
        .ok_or("Telegram non è connesso.")?;
    if text.trim().is_empty() {
        return Err("Il messaggio è vuoto.".into());
    }
    let msg_id = send_message(&client()?, &config, text)?;
    if msg_id > 0 {
        let (_, projects) = state.resolve_projects(&config);
        if let Some(target) = extract_project_from_text(text, &projects) {
            state.record_message(msg_id, target);
        } else if let Some(target) = projects.first() {
            state.record_message(msg_id, target.clone());
        }
    }
    Ok(msg_id)
}

#[tauri::command]
pub fn telegram_send(state: State<Arc<TelegramState>>, text: String) -> Result<(), String> {
    notify(&state, &text).map(|_| ())
}

pub fn shutdown(state: &TelegramState) {
    state.generation.fetch_add(1, Ordering::SeqCst);
    *state.config.lock().unwrap() = None;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn update(chat: i64, text: &str) -> Value {
        json!({
            "update_id": 7,
            "message": { "chat": { "id": chat }, "text": text }
        })
    }

    #[test]
    fn only_a_bot_father_token_is_accepted() {
        assert!(valid_token("123456789:AAHm2x3YqW8sVn4Lp6Rt0Zk9Bd1Cf5Gh7J"));
        assert!(!valid_token(""));
        assert!(!valid_token("token-senza-id"));
        assert!(!valid_token("abc:AAHm2x3YqW8sVn4Lp6Rt0Zk9Bd1Cf5Gh7J"));
        assert!(!valid_token("123:short"));
        assert!(!valid_token("123:AAHm2x3YqW8sVn4Lp6Rt0Zk9Bd1Cf5Gh7J/../x"));
    }

    #[test]
    fn chat_ids_are_positive_or_channel_numbers() {
        assert!(valid_chat_id("123456789"));
        assert!(valid_chat_id("-1001234567890"));
        assert!(!valid_chat_id(""));
        assert!(!valid_chat_id("-"));
        assert!(!valid_chat_id("12a"));
    }

    #[test]
    fn only_messages_from_the_configured_chat_reach_the_pm() {
        assert_eq!(
            inbound(&update(42, "hello PM"), "42"),
            Some("hello PM".into())
        );
        assert_eq!(
            inbound(&update(42, "  spaced  "), "42"),
            Some("spaced".into())
        );
        assert_eq!(
            inbound(&update(7, "not my chat"), "42"),
            None,
            "dev/qa or strangers are ignored"
        );
        assert_eq!(inbound(&update(42, "   "), "42"), None);
        assert_eq!(inbound(&json!({ "update_id": 1 }), "42"), None);
    }

    #[test]
    fn a_voice_note_is_parsed_for_the_authorized_chat_only() {
        let update = json!({
            "update_id": 9,
            "message": {
                "message_id": 11,
                "chat": { "id": 42 },
                "voice": {
                    "file_id": "file-1",
                    "duration": 7,
                    "mime_type": "audio/ogg",
                    "file_size": 4096
                }
            }
        });
        let v = parse_voice(&update, "42").unwrap();
        assert_eq!(v.file_id, "file-1");
        assert_eq!(v.message_id, 11);
        assert_eq!(v.duration, 7);
        assert_eq!(v.mime_type, "audio/ogg");
        assert_eq!(v.file_size, 4096);
        assert!(
            parse_voice(&update, "7").is_none(),
            "only the configured chat reaches the PM"
        );
        assert!(parse_voice(&json!({ "update_id": 1 }), "42").is_none());
        assert!(
            parse_voice(
                &json!({ "message": { "chat": { "id": 42 }, "voice": {} } }),
                "42"
            )
            .is_none(),
            "a voice without a file id cannot be downloaded"
        );
    }

    #[test]
    fn text_and_voice_never_take_each_others_path() {
        let text = update(42, "hello PM");
        assert!(parse_voice(&text, "42").is_none());
        let voice = json!({
            "message": { "chat": { "id": 42 }, "voice": { "file_id": "f" } }
        });
        assert!(parse_inbound(&voice, "42").is_none());
    }

    #[test]
    fn voice_files_are_named_from_the_message_id_and_a_known_extension() {
        assert_eq!(voice_file_name(12, "voice/file_1.oga"), "telegram-12.oga");
        assert_eq!(voice_file_name(12, "voice/file_1.MP3"), "telegram-12.mp3");
        assert_eq!(voice_file_name(12, "voice/file_1"), "telegram-12.oga");
        assert_eq!(voice_file_name(-3, "x.opus"), "telegram-0.opus");
    }

    #[test]
    fn a_remote_voice_path_cannot_walk_out_of_the_cache() {
        assert_eq!(
            safe_remote_path("voice/file_1.oga"),
            Some("voice/file_1.oga")
        );
        for bad in [
            "",
            "/voice/x.oga",
            "voice/../../x",
            "voice//x",
            "./x",
            "voice\\x",
            "voice/x.oga?token=1",
            "voice/x y.oga",
        ] {
            assert!(safe_remote_path(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn the_voice_prompt_points_the_pm_at_the_saved_file() {
        let voice = InboundVoice {
            file_id: "f".into(),
            message_id: 5,
            duration: 7,
            mime_type: "audio/ogg".into(),
            file_size: 10,
            reply_to_id: None,
            reply_to_text: None,
        };
        let text = voice_prompt(&voice, Path::new("/tmp/voice/telegram-5.oga"));
        assert!(text.contains("7 s"));
        assert!(text.contains("/tmp/voice/telegram-5.oga"));
        assert!(text.contains("audio/ogg"));
    }

    #[test]
    fn connecting_only_sends_the_welcome_never_an_agent_prompt() {
        let text = welcome_message("/p");
        assert!(text.contains("/p"));
        assert!(text.contains("Only this chat"));
        assert!(!text.to_lowercase().contains("escalation ·"));
        assert!(!text.contains("Do you want to proceed"));
    }

    #[test]
    fn dogwatch_prompts_are_never_forwarded_to_telegram_automatically() {
        // The PM-only mediation is architectural: main.rs must not call a
        // Telegram notifier from the dogwatch loop, and connect must not
        // inspect pending prompts. Only telegram_send may reach the chat.
        let main = include_str!("main.rs");
        let telegram = include_str!("telegram.rs");
        assert!(!main.contains("notify_pending"));
        // Built at runtime so this test does not match its own literals.
        let notifier = ["fn ", "notify_", "pending"].concat();
        let inspector = ["dogwatch::", "inspect"].concat();
        assert!(!telegram.contains(&notifier));
        assert!(!telegram.contains(&inspector));
    }

    #[test]
    fn long_text_is_cut_below_the_telegram_limit() {
        let text = "a".repeat(5000);
        let cut = truncate(&text, MAX_TEXT);
        assert_eq!(cut.chars().count(), MAX_TEXT);
        assert!(cut.ends_with('…'));
        assert_eq!(truncate("short", MAX_TEXT), "short");
    }

    #[test]
    fn only_new_pm_output_is_sent_back_without_echo_and_chrome() {
        let before = "working\n> \n";
        let after = "working\n> hello\nAnswer: hi\nMore detail\n";
        assert_eq!(
            reply_text(before, after, "hello").as_deref(),
            Some("Answer: hi\nMore detail")
        );
        assert_eq!(reply_text(before, before, "hello"), None, "no new output");
        assert_eq!(
            reply_text(before, "working\n> hello\n", "hello"),
            None,
            "the echoed message alone is not a reply"
        );
        assert_eq!(
            reply_text(before, "working\n╭────╮\n╰────╯\n", "hello"),
            None,
            "decoration alone is not a reply"
        );
    }

    #[test]
    fn terminal_history_and_ai_cli_tool_noise_are_stripped() {
        let before = "Old output\nAnother old turn\n";
        let after = "\
Old conversation history line 1
Old conversation history line 2
### Screenshot Aggiornato
────────────────────────────────────────────────────────────
> ciao pm, ci sei?08:56

● Ran 4 commands (+3 · python3 list) (ctrl+o to expand)
○ Thought for 12.2s
⣾ Running command...
Wait for background task task-1 to finish.

  Ciao! Sì, sono qui, operativo e pronto.

  Tutto il backlog di Plane è attualmente completato.

────────────────────────────────────────────────────────────
>
";
        let reply = reply_text(before, after, "ciao pm, ci sei?08:56").unwrap();
        assert!(!reply.contains("Old conversation"), "{reply}");
        assert!(!reply.contains("Screenshot"), "{reply}");
        assert!(!reply.contains("Ran 4 commands"), "{reply}");
        assert!(!reply.contains("Thought for"), "{reply}");
        assert!(!reply.contains("Running command"), "{reply}");
        assert!(!reply.contains("Wait for background"), "{reply}");
        assert!(
            reply.contains("Ciao! Sì, sono qui, operativo e pronto."),
            "{reply}"
        );
        assert!(
            reply.contains("Tutto il backlog di Plane è attualmente completato."),
            "{reply}"
        );
    }

    #[test]
    fn a_scrolled_pane_still_yields_the_new_tail() {
        let before = "a\nb\nc\n";
        let after = "b\nc\nAnswer\n";
        assert_eq!(reply_text(before, after, "q").as_deref(), Some("Answer"));
    }

    #[test]
    fn the_reply_is_returned_after_the_pane_stops_changing() {
        let screens = [
            "baseline\n> \n",
            "baseline\n> hello\n",
            "baseline\n> hello\nThinking...\n",
            "baseline\n> hello\nAnswer: 42\nMore detail\n",
            "baseline\n> hello\nAnswer: 42\nMore detail\n",
        ];
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let reply = collect_reply(
            screens[0],
            || {
                let n = calls.fetch_add(1, Ordering::SeqCst);
                Some(screens[n.min(screens.len() - 1)].to_string())
            },
            || false,
            "hello",
            Duration::from_millis(2),
            Duration::from_millis(20),
            Duration::from_secs(1),
        );
        let reply = reply.expect("a reply");
        assert!(reply.contains("Answer: 42"), "{reply}");
        assert!(reply.contains("More detail"), "{reply}");
        assert!(
            !reply.contains("hello"),
            "the echoed message is not sent back"
        );
    }

    #[test]
    fn no_reply_is_returned_when_the_connection_stops() {
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let reply = collect_reply(
            "baseline\n",
            || {
                calls.fetch_add(1, Ordering::SeqCst);
                Some("baseline\n> hello\n".into())
            },
            || calls.load(Ordering::SeqCst) > 1,
            "hello",
            Duration::from_millis(2),
            Duration::from_millis(20),
            Duration::from_secs(1),
        );
        assert_eq!(reply, None);
    }

    #[test]
    fn a_real_pm_window_reply_is_captured_and_returned() {
        if !crate::tmux::is_available() {
            return;
        }
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let session = format!("wstg_{nanos:x}");
        crate::tmux::ensure_session(&session, std::path::Path::new("/tmp")).unwrap();
        let command = "printf 'ready\\n'; read line; printf 'Answer: %s\\n' \"$line\"; sleep 30";
        crate::tmux::new_window(
            &session,
            Some("pm"),
            std::path::Path::new("/tmp"),
            Some(command),
        )
        .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let before = capture_pm(&session).unwrap_or_default();
        dogwatch::answer(&session, "pm", "hello").unwrap();
        let reply = collect_reply(
            &before,
            || capture_pm(&session),
            || false,
            "hello",
            Duration::from_millis(100),
            Duration::from_millis(500),
            Duration::from_secs(5),
        );
        let _ = crate::tmux::kill_session(&session);
        let reply = reply.unwrap_or_default();
        assert!(reply.contains("Answer: hello"), "reply: {reply:?}");
    }

    #[test]
    fn the_status_uses_camel_case_and_never_carries_the_token() {
        let state = TelegramState::new();
        let json = serde_json::to_value(state.status()).unwrap();
        assert_eq!(json["connected"], false);
        assert!(json.get("token").is_none());
        assert!(json["bot"].is_null());
        assert!(json.get("chatId").is_some(), "the panel reads chatId");
        assert!(json.get("lastError").is_some(), "the panel reads lastError");
        assert!(json.get("chat_id").is_none(), "no snake_case leak");
        assert!(json.get("last_error").is_none(), "no snake_case leak");
    }

    const TOKEN: &str = "123456:AAHm2x3YqW8sVn4Lp6Rt0Zk9Bd1Cf5Gh7J";
    const CHAT: &str = "987654321";

    fn saved_config() -> Config {
        Config {
            token: TOKEN.into(),
            chat_id: CHAT.into(),
            bot: "work_pm_bot".into(),
            project: "/saved/project".into(),
            session: "work_saved".into(),
        }
    }

    fn restored_status(config: &Config) -> Result<Status, String> {
        Ok(Status {
            connected: true,
            bot: Some(config.bot.clone()),
            chat_id: Some(config.chat_id.clone()),
            project: Some(config.project.clone()),
            session: Some(config.session.clone()),
            last_error: None,
            active_project: Some(project_name_from_path(&config.project)),
            target_project: Some(project_name_from_path(&config.project)),
            is_pinned: false,
        })
    }

    #[test]
    fn the_saved_connection_is_private_and_keeps_its_project() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("telegram.json");
        let config = saved_config();

        write_config_file(&path, &config);
        let saved: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved["token"], config.token);
        assert_eq!(saved["chat_id"], config.chat_id);
        assert_eq!(saved["bot"], config.bot);
        assert_eq!(
            saved["project"], config.project,
            "restore needs the project"
        );
        assert_eq!(
            saved["session"], config.session,
            "restore needs the session"
        );
        assert!(
            !path.with_extension("json.tmp").exists(),
            "no temp file left"
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "the token file stays private");
        }
    }

    #[test]
    fn startup_restore_reconnects_to_the_saved_project_and_chat() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("telegram.json");
        write_config_file(&path, &saved_config());

        let mut restored = None;
        let result = restore_from(
            &path,
            Some("/other/project"),
            Some("work_other"),
            |config| {
                let status = restored_status(&config);
                restored = Some(config);
                status
            },
        );
        assert!(matches!(result, Some(Ok(_))));
        let config = restored.unwrap();
        assert_eq!(config.project, "/saved/project", "the saved project wins");
        assert_eq!(config.session, "work_saved", "the saved session wins");
        assert_eq!(config.chat_id, CHAT, "only the authorized chat is restored");
        assert_eq!(config.token, TOKEN);
    }

    #[test]
    fn an_old_config_without_project_falls_back_to_the_active_one() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("telegram.json");
        fs::write(
            &path,
            json!({ "token": TOKEN, "chat_id": CHAT, "bot": "work_pm_bot" }).to_string(),
        )
        .unwrap();

        let mut restored = None;
        let result = restore_from(
            &path,
            Some("/active/project"),
            Some("work_active"),
            |config| {
                restored = Some(config);
                Ok(Status {
                    connected: true,
                    bot: Some("work_pm_bot".into()),
                    chat_id: Some(CHAT.into()),
                    project: Some("/active/project".into()),
                    session: Some("work_active".into()),
                    last_error: None,
                    active_project: Some("project".into()),
                    target_project: Some("project".into()),
                    is_pinned: false,
                })
            },
        );
        assert!(matches!(result, Some(Ok(_))));
        let config = restored.unwrap();
        assert_eq!(config.project, "/active/project");
        assert_eq!(config.session, "work_active");
        assert_eq!(config.bot, "work_pm_bot");
    }

    #[test]
    fn startup_restore_does_nothing_without_a_valid_saved_connection() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("telegram.json");
        let mut called = false;

        let mut attempt = |fallback_project: Option<&str>, fallback_session: Option<&str>| {
            restore_from(&path, fallback_project, fallback_session, |config| {
                called = true;
                restored_status(&config)
            })
            .is_some()
        };

        assert!(!attempt(Some("/active"), Some("work_active")), "no file");
        fs::write(&path, "{ rotto").unwrap();
        assert!(
            !attempt(Some("/active"), Some("work_active")),
            "broken JSON"
        );
        fs::write(
            &path,
            json!({ "token": "bad", "chat_id": CHAT }).to_string(),
        )
        .unwrap();
        assert!(!attempt(Some("/active"), Some("work_active")), "bad token");
        fs::write(
            &path,
            json!({ "token": TOKEN, "chat_id": CHAT }).to_string(),
        )
        .unwrap();
        assert!(
            !attempt(None, None),
            "no project or session to reconnect to"
        );
        assert!(!called, "nothing was connected");
    }

    #[test]
    fn a_failed_restore_keeps_the_saved_connection_for_the_next_start() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("telegram.json");
        write_config_file(&path, &saved_config());

        let result = restore_from(&path, Some("/active"), Some("work_active"), |_| {
            Err("Telegram non raggiungibile".into())
        });
        assert_eq!(result.unwrap().unwrap_err(), "Telegram non raggiungibile");
        assert!(path.exists(), "the token is kept for the next start");
    }

    #[test]
    fn startup_restores_the_saved_connection_instead_of_erasing_it() {
        let main = include_str!("main.rs");
        assert!(main.contains("telegram::restore"), "startup reconnects");
        assert!(
            !main.contains("clear_saved_config"),
            "startup must not erase the saved connection"
        );
    }

    fn sample_projects() -> Vec<TargetProject> {
        vec![
            TargetProject {
                name: "work-stack".into(),
                path: "/home/user/work-stack".into(),
                session: "work_work-stack".into(),
            },
            TargetProject {
                name: "ecommerce-api".into(),
                path: "/home/user/ecommerce-api".into(),
                session: "work_ecommerce-api".into(),
            },
        ]
    }

    #[test]
    fn route_inbound_shows_projects_list_on_command() {
        let projects = sample_projects();
        let recent = HashMap::new();
        let inbound = InboundMessage {
            text: "/projects".into(),
            reply_to_id: None,
            reply_to_text: None,
        };
        let (action, new_pinned) = route_inbound(
            &inbound,
            Some("/home/user/work-stack"),
            None,
            &projects,
            &recent,
        );
        assert_eq!(new_pinned, None);
        match action {
            RouteResult::CommandReply(reply) => {
                assert!(reply.contains("work-stack"));
                assert!(reply.contains("ecommerce-api"));
                assert!(reply.contains("[ATTIVO]"));
            }
            _ => panic!("Expected CommandReply"),
        }
    }

    #[test]
    fn route_inbound_switches_target_with_use() {
        let projects = sample_projects();
        let recent = HashMap::new();
        let inbound = InboundMessage {
            text: "/use ecommerce-api".into(),
            reply_to_id: None,
            reply_to_text: None,
        };
        let (action, new_pinned) = route_inbound(
            &inbound,
            Some("/home/user/work-stack"),
            None,
            &projects,
            &recent,
        );
        assert_eq!(new_pinned, Some(Some("ecommerce-api".into())));
        match action {
            RouteResult::CommandReply(reply) => {
                assert!(reply.contains("Target fissato su \"ecommerce-api\""));
            }
            _ => panic!("Expected CommandReply"),
        }
    }

    #[test]
    fn route_inbound_resets_target_with_use_auto() {
        let projects = sample_projects();
        let recent = HashMap::new();
        let inbound = InboundMessage {
            text: "/use auto".into(),
            reply_to_id: None,
            reply_to_text: None,
        };
        let (action, new_pinned) = route_inbound(
            &inbound,
            Some("/home/user/work-stack"),
            Some("ecommerce-api"),
            &projects,
            &recent,
        );
        assert_eq!(new_pinned, Some(None));
        match action {
            RouteResult::CommandReply(reply) => {
                assert!(reply.contains("Target reimpostato su AUTO"));
            }
            _ => panic!("Expected CommandReply"),
        }
    }

    #[test]
    fn route_inbound_routes_via_reply_to_cached_message() {
        let projects = sample_projects();
        let mut recent = HashMap::new();
        recent.insert(42, projects[1].clone());

        let inbound = InboundMessage {
            text: "proceed with tests".into(),
            reply_to_id: Some(42),
            reply_to_text: None,
        };
        let (action, new_pinned) = route_inbound(
            &inbound,
            Some("/home/user/work-stack"),
            None,
            &projects,
            &recent,
        );
        assert_eq!(new_pinned, None);
        match action {
            RouteResult::ForwardToPm { target, text } => {
                assert_eq!(target.name, "ecommerce-api");
                assert_eq!(target.session, "work_ecommerce-api");
                assert_eq!(text, "proceed with tests");
            }
            _ => panic!("Expected ForwardToPm"),
        }
    }

    #[test]
    fn route_inbound_routes_via_reply_to_tagged_text() {
        let projects = sample_projects();
        let recent = HashMap::new();

        let inbound = InboundMessage {
            text: "looks good".into(),
            reply_to_id: Some(999),
            reply_to_text: Some("[ecommerce-api] tests finished".into()),
        };
        let (action, _) = route_inbound(
            &inbound,
            Some("/home/user/work-stack"),
            None,
            &projects,
            &recent,
        );
        match action {
            RouteResult::ForwardToPm { target, text } => {
                assert_eq!(target.name, "ecommerce-api");
                assert_eq!(text, "looks good");
            }
            _ => panic!("Expected ForwardToPm"),
        }
    }

    #[test]
    fn route_inbound_routes_via_at_prefix() {
        let projects = sample_projects();
        let recent = HashMap::new();

        let inbound = InboundMessage {
            text: "@ecommerce-api run migrations".into(),
            reply_to_id: None,
            reply_to_text: None,
        };
        let (action, _) = route_inbound(
            &inbound,
            Some("/home/user/work-stack"),
            None,
            &projects,
            &recent,
        );
        match action {
            RouteResult::ForwardToPm { target, text } => {
                assert_eq!(target.name, "ecommerce-api");
                assert_eq!(text, "run migrations");
            }
            _ => panic!("Expected ForwardToPm"),
        }
    }

    #[test]
    fn route_inbound_routes_via_bracket_prefix() {
        let projects = sample_projects();
        let recent = HashMap::new();

        let inbound = InboundMessage {
            text: "[ecommerce-api] restart dev server".into(),
            reply_to_id: None,
            reply_to_text: None,
        };
        let (action, _) = route_inbound(
            &inbound,
            Some("/home/user/work-stack"),
            None,
            &projects,
            &recent,
        );
        match action {
            RouteResult::ForwardToPm { target, text } => {
                assert_eq!(target.name, "ecommerce-api");
                assert_eq!(text, "restart dev server");
            }
            _ => panic!("Expected ForwardToPm"),
        }
    }

    #[test]
    fn route_inbound_follows_active_project_by_default() {
        let projects = sample_projects();
        let recent = HashMap::new();

        let inbound = InboundMessage {
            text: "show git diff".into(),
            reply_to_id: None,
            reply_to_text: None,
        };
        let (action, _) = route_inbound(
            &inbound,
            Some("/home/user/work-stack"),
            None,
            &projects,
            &recent,
        );
        match action {
            RouteResult::ForwardToPm { target, text } => {
                assert_eq!(target.name, "work-stack");
                assert_eq!(text, "show git diff");
            }
            _ => panic!("Expected ForwardToPm"),
        }
    }

    #[test]
    fn route_inbound_status_command() {
        let projects = sample_projects();
        let recent = HashMap::new();

        let inbound = InboundMessage {
            text: "/status".into(),
            reply_to_id: None,
            reply_to_text: None,
        };
        let (action, _) = route_inbound(
            &inbound,
            Some("/home/user/work-stack"),
            None,
            &projects,
            &recent,
        );
        match action {
            RouteResult::CommandReply(reply) => {
                assert!(reply.contains("Stato Telegram Work"));
                assert!(reply.contains("AUTO (segue UI)"));
                assert!(reply.contains("work-stack"));
            }
            _ => panic!("Expected CommandReply"),
        }
    }
}
