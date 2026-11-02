// Telegram bridge for the PM: the only team role with a remote channel.
// Incoming messages are typed into the PM window; outgoing messages come from
// the UI (telegram_send) and from dogwatch escalations, so the PM can decide
// whether a product/user decision is needed. Dev and QA windows never talk to
// the bot: they only go through the PM and dogwatch.
use crate::dogwatch;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

const API: &str = "https://api.telegram.org";
const POLL_TIMEOUT_SECS: u64 = 25;
const HTTP_TIMEOUT_SECS: u64 = 40;
const MAX_TEXT: usize = 4000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub connected: bool,
    pub bot: Option<String>,
    pub chat_id: Option<String>,
    pub project: Option<String>,
    pub session: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Clone)]
struct Config {
    token: String,
    chat_id: String,
    bot: String,
    project: String,
    session: String,
}

pub struct TelegramState {
    config: Mutex<Option<Config>>,
    last_error: Mutex<Option<String>>,
    // Bumped on connect/disconnect: an old polling thread sees a different
    // generation and stops after the request it is waiting on.
    generation: AtomicU64,
}

impl TelegramState {
    pub fn new() -> Self {
        Self {
            config: Mutex::new(None),
            last_error: Mutex::new(None),
            generation: AtomicU64::new(0),
        }
    }

    fn status(&self) -> Status {
        let config = self.config.lock().unwrap().clone();
        let last_error = self.last_error.lock().unwrap().clone();
        match config {
            Some(c) => Status {
                connected: true,
                bot: Some(c.bot),
                chat_id: Some(c.chat_id),
                project: Some(c.project),
                session: Some(c.session),
                last_error,
            },
            None => Status {
                connected: false,
                bot: None,
                chat_id: None,
                project: None,
                session: None,
                last_error,
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

// Only messages from the configured chat reach the PM. Anything else is
// ignored: this is what keeps the bot a PM-only channel.
pub fn inbound(update: &Value, chat_id: &str) -> Option<String> {
    let message = &update["message"];
    if message["chat"]["id"].as_i64()?.to_string() != chat_id {
        return None;
    }
    let text = message["text"].as_str()?.trim();
    (!text.is_empty()).then(|| text.to_string())
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

// Box-drawing and progress bars around an agent TUI are not part of the answer.
fn is_chrome(line: &str) -> bool {
    let text = line.trim();
    !text.is_empty()
        && text
            .chars()
            .all(|c| c.is_whitespace() || "╭╮╰╯─│┌┐└┘├┤┬┴┼═║╔╗╚╝█▀▄".contains(c))
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
    let fresh = new_lines(before, after);
    let text = fresh
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter(|line| !is_chrome(line))
        .filter(|line| !is_echo(line, sent))
        .map(|line| line.trim_matches(|c: char| c.is_whitespace() || c == '│'))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
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
            if last_screen.as_deref() != Some(screen.as_str()) {
                last_screen = Some(screen.clone());
                last_change = Instant::now();
            }
            if let Some(reply) = reply_text(baseline, &screen, sent) {
                last_reply = Some(reply);
            }
            // A non-empty reply that stopped moving is complete enough to send.
            if last_reply.is_some() && last_change.elapsed() >= idle {
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

fn send_message(
    client: &reqwest::blocking::Client,
    config: &Config,
    text: &str,
) -> Result<(), String> {
    call(
        client,
        &config.token,
        "sendMessage",
        Some(json!({
            "chat_id": config.chat_id,
            "text": truncate(text, MAX_TEXT),
            "disable_web_page_preview": true,
        })),
    )?;
    Ok(())
}

// ── Polling thread ───────────────────────────────────────────

fn emit_status(app: &AppHandle, state: &Arc<TelegramState>) {
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
                    if let Some(text) = inbound(update, &config.chat_id) {
                        // The PM window is the only destination of the bot.
                        // Capture it first so the reply is only the new output.
                        let baseline = capture_pm(&config.session).unwrap_or_default();
                        let typed = dogwatch::answer(&config.session, "pm", &text);
                        let error = typed.as_ref().err().cloned();
                        let _ = app.emit(
                            "telegram:message",
                            json!({
                                "direction": "in",
                                "text": text,
                                "typed": typed.is_ok(),
                                "error": error,
                            }),
                        );
                        if typed.is_err() {
                            continue;
                        }
                        // The PM's answer is typed in the pm pane: send the new
                        // text back to the same authorized chat.
                        let stopped = || state.generation() != generation;
                        let reply = collect_reply(
                            &baseline,
                            || capture_pm(&config.session),
                            stopped,
                            &text,
                            REPLY_POLL,
                            REPLY_IDLE,
                            REPLY_TIMEOUT,
                        );
                        if let Some(reply) = reply {
                            match send_message(&client, &config, &reply) {
                                Ok(()) => {
                                    let _ = app.emit(
                                        "telegram:message",
                                        json!({ "direction": "out", "text": reply }),
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
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    emit_status(&app, &state);

    let welcome = (config.clone(), welcome_message(&config.project));
    thread::spawn(move || {
        if let Ok(client) = client() {
            let _ = send_message(&client, &welcome.0, &welcome.1);
        }
    });

    let app2 = app.clone();
    let state2 = Arc::clone(state.inner());
    let config2 = config.clone();
    thread::spawn(move || poll(app2, state2, config2, generation, 0));

    Ok(state.status())
}

#[tauri::command]
pub fn telegram_disconnect(app: AppHandle, state: State<Arc<TelegramState>>) -> Status {
    state.generation.fetch_add(1, Ordering::SeqCst);
    *state.config.lock().unwrap() = None;
    state.set_error(None);
    emit_status(&app, &state);
    state.status()
}

#[tauri::command]
pub fn telegram_send(state: State<Arc<TelegramState>>, text: String) -> Result<(), String> {
    let config = state
        .config
        .lock()
        .unwrap()
        .clone()
        .ok_or("Telegram non è connesso.")?;
    if text.trim().is_empty() {
        return Err("Il messaggio è vuoto.".into());
    }
    send_message(&client()?, &config, &text)
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
}
