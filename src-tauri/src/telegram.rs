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
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

const API: &str = "https://api.telegram.org";
const POLL_TIMEOUT_SECS: u64 = 25;
const HTTP_TIMEOUT_SECS: u64 = 40;
const MAX_TEXT: usize = 4000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
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

pub fn format_pending(project: &str, session: &str, pending: &[dogwatch::Pending]) -> String {
    let mut text = format!("🚨 Agent escalation · {project}\n");
    if !session.is_empty() {
        text.push_str(&format!("session: {session}\n"));
    }
    for p in pending {
        text.push_str(&format!("\n• {} — {}", p.target, p.prompt.question));
        if !p.prompt.options.is_empty() {
            text.push_str(&format!("\n  options: {}", p.prompt.options.join(" / ")));
        }
    }
    text.push_str("\n\nReply here to bring it to the PM.");
    text
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
                        let typed = dogwatch::answer(&config.session, "pm", &text);
                        let _ = app.emit(
                            "telegram:message",
                            json!({
                                "direction": "in",
                                "text": text,
                                "typed": typed.is_ok(),
                                "error": typed.err(),
                            }),
                        );
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

    // The PM already had a question pending when the bot connected.
    let pending = dogwatch::inspect(&config.session)
        .map(|i| i.pending())
        .unwrap_or_default();
    let hello = if pending.is_empty() {
        format!(
            "🤖 Work PM bot connected to {}.\nMessages here are typed into the PM window. Only this chat is accepted.",
            config.project
        )
    } else {
        format_pending(&config.project, &config.session, &pending)
    };
    let welcome = (config.clone(), hello);
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

// Dogwatch changed the pending list of a project: tell the PM's chat, if the
// bot is connected to that same project. An empty list is not sent.
pub fn notify_pending(
    app: &AppHandle,
    project: &str,
    session: &str,
    pending: &[dogwatch::Pending],
) {
    if pending.is_empty() {
        return;
    }
    let state = app.state::<Arc<TelegramState>>();
    let Some(config) = state.config.lock().unwrap().clone() else {
        return;
    };
    if config.project != project || config.session != session {
        return;
    }
    let text = format_pending(project, session, pending);
    let app = app.clone();
    thread::spawn(move || {
        if let Ok(client) = client() {
            let _ = send_message(&client, &config, &text);
            let _ = app.emit(
                "telegram:message",
                json!({ "direction": "out", "text": text }),
            );
        }
    });
}

pub fn shutdown(state: &TelegramState) {
    state.generation.fetch_add(1, Ordering::SeqCst);
    *state.config.lock().unwrap() = None;
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn an_escalation_message_names_target_question_and_options() {
        let pending = vec![dogwatch::Pending {
            target: "dev1".into(),
            prompt: dogwatch::parse_prompt("Do you want to proceed?\n❯ 1. Yes\n  2. No\n").unwrap(),
        }];
        let text = format_pending("/p", "work_p_1234", &pending);
        assert!(text.contains("dev1"));
        assert!(text.contains("Do you want to proceed?"));
        assert!(text.contains("Yes / No"));
        assert!(text.contains("work_p_1234"));
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
    fn the_status_never_carries_the_token() {
        let state = TelegramState::new();
        let json = serde_json::to_value(state.status()).unwrap();
        assert_eq!(json["connected"], false);
        assert!(json.get("token").is_none());
        assert!(json["bot"].is_null());
    }
}
