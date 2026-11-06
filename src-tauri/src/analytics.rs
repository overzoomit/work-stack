// Fleet Analytics: aggregate the local agent history (Claude Code, Antigravity,
// OpenCode) and the Plane ticket lifecycle into one telemetry payload for the
// dashboard. Everything is read from files the agents already write, so the
// feature works offline; the parsed per-file results are cached in the project
// under .claude/ so opening the panel does not rescan old transcripts.
use crate::agents::{is_session_file, projects_dir};
use crate::fsops::{guard, Roots};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

const CACHE_FILE: &str = ".claude/analytics_cache.json";
const HISTORY_FILE: &str = ".claude/analytics_history.json";
const DAILY_DAYS: u64 = 14;
const DAY_MS: u64 = 86_400_000;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

// ── Calendar helpers ─────────────────────────────────────────

// Howard Hinnant's civil calendar conversion, so this module needs no date
// crate. Days are counted from 1970-01-01.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = y - i64::from(m <= 2);
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (y + i64::from(m <= 2), m, d)
}

fn day_key(ms: u64) -> String {
    let (y, m, d) = civil_from_days((ms / DAY_MS) as i64);
    format!("{y:04}-{m:02}-{d:02}")
}

// Date.parse for the ISO timestamps Claude Code and the dogwatch write.
fn parse_ts(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let n = |from: usize, len: usize| -> Option<i64> {
        let part = s.get(from..from + len)?;
        part.parse::<i64>().ok()
    };
    let (y, mo, d) = (n(0, 4)?, n(5, 2)?, n(8, 2)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    let mut ms = days_from_civil(y, mo, d).max(0) as u64 * DAY_MS;
    if b.len() >= 16 && (b[10] == b'T' || b[10] == b' ') {
        let (h, mi) = (n(11, 2)?, n(14, 2)?);
        ms += (h.max(0) as u64) * 3_600_000 + (mi.max(0) as u64) * 60_000;
        if b.len() >= 19 && b[16] == b':' {
            ms += (n(17, 2)?.max(0) as u64) * 1_000;
            if b.len() > 20 && b[19] == b'.' {
                let digits: String = s[20..]
                    .chars()
                    .take_while(char::is_ascii_digit)
                    .take(3)
                    .collect();
                if !digits.is_empty() {
                    let value: u64 = digits.parse().ok()?;
                    ms += value * 10u64.pow(3 - digits.len() as u32);
                }
            }
        }
    }
    Some(ms)
}

// ── Payload ──────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub sessions: u64,
    pub tokens: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
    pub tickets_done: u64,
    pub tickets_open: u64,
    pub avg_cycle_ms: Option<u64>,
    pub qa_first_pass_rate: Option<f64>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub key: String,
    pub provider: String,
    pub model: String,
    pub sessions: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub tokens: u64,
    pub cost_usd: f64,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    pub id: String,
    pub name: String,
    pub sessions: u64,
    pub tokens: u64,
    pub cost_usd: f64,
    pub avg_session_ms: Option<u64>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DailyPoint {
    pub date: String,
    pub sessions: u64,
    pub tokens: u64,
    pub tickets: u64,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TicketStat {
    pub id: String,
    pub state: String,
    pub started_at: Option<u64>,
    pub done_at: Option<u64>,
    pub cycle_ms: Option<u64>,
    pub first_pass: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsSummary {
    pub project: String,
    pub generated_at: u64,
    pub totals: Totals,
    pub models: Vec<ModelUsage>,
    pub agents: Vec<AgentUsage>,
    pub daily: Vec<DailyPoint>,
    pub tickets: Vec<TicketStat>,
}

// ── Parsed history ───────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
struct ModelSlice {
    model: String,
    provider: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
    tokens: u64,
    cost_usd: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
struct SessionRecord {
    id: String,
    agent: String,
    started_at: u64,
    ended_at: u64,
    input_tokens: u64,
    output_tokens: u64,
    tokens: u64,
    cost_usd: f64,
    models: Vec<ModelSlice>,
}

#[allow(clippy::too_many_arguments)]
fn add_model(
    models: &mut Vec<ModelSlice>,
    model: &str,
    provider: &str,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    cost: f64,
) {
    let tokens = input + output + cache_read + cache_write;
    if tokens == 0 && cost == 0.0 {
        return;
    }
    if let Some(slice) = models
        .iter_mut()
        .find(|m| m.model == model && m.provider == provider)
    {
        slice.input_tokens += input;
        slice.output_tokens += output;
        slice.cache_read_tokens += cache_read;
        slice.cache_write_tokens += cache_write;
        slice.tokens += tokens;
        slice.cost_usd += cost;
        return;
    }
    models.push(ModelSlice {
        model: model.to_string(),
        provider: provider.to_string(),
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cache_read,
        cache_write_tokens: cache_write,
        tokens,
        cost_usd: cost,
    });
}

fn record_from_models(
    id: String,
    agent: &str,
    start: u64,
    end: u64,
    models: Vec<ModelSlice>,
) -> SessionRecord {
    let mut rec = SessionRecord {
        id,
        agent: agent.to_string(),
        started_at: start,
        ended_at: end.max(start),
        models,
        ..Default::default()
    };
    for m in &rec.models {
        rec.input_tokens += m.input_tokens;
        rec.output_tokens += m.output_tokens;
        rec.tokens += m.tokens;
        rec.cost_usd += m.cost_usd;
    }
    rec
}

// ── Pricing & providers ──────────────────────────────────────

// USD per million tokens: (input, output, cache read, cache write).
fn prices(model: &str) -> (f64, f64, f64, f64) {
    let m = model.to_lowercase();
    if m.contains("opus") {
        (15.0, 75.0, 1.5, 18.75)
    } else if m.contains("sonnet") {
        (3.0, 15.0, 0.3, 3.75)
    } else if m.contains("haiku") {
        (0.8, 4.0, 0.08, 1.0)
    } else if m.contains("gpt-5") || m.contains("codex") {
        (1.25, 10.0, 0.125, 0.0)
    } else if m.contains("gemini") {
        (1.25, 5.0, 0.31, 0.0)
    } else if m.contains("deepseek") {
        (0.27, 1.1, 0.07, 0.0)
    } else {
        (1.0, 3.0, 0.1, 0.0)
    }
}

fn estimate_cost(model: &str, input: u64, output: u64, cache_read: u64, cache_write: u64) -> f64 {
    let (pin, pout, pread, pwrite) = prices(model);
    (input as f64 * pin
        + output as f64 * pout
        + cache_read as f64 * pread
        + cache_write as f64 * pwrite)
        / 1_000_000.0
}

fn provider_for(model: &str, hint: Option<&str>) -> String {
    if let Some(h) = hint {
        let lower = h.to_lowercase();
        return match lower.as_str() {
            "anthropic" => "Anthropic".into(),
            "openai" => "OpenAI".into(),
            "google" | "google-vertex" => "Google".into(),
            "ollama" => "Ollama".into(),
            "opencode" => "OpenCode".into(),
            "deepseek" => "DeepSeek".into(),
            _ => h.to_string(),
        };
    }
    let m = model.to_lowercase();
    if m.contains("claude") {
        "Anthropic".into()
    } else if m.contains("gpt") || m.contains("o3") || m.contains("codex") {
        "OpenAI".into()
    } else if m.contains("gemini") {
        "Google".into()
    } else if m.contains("deepseek") {
        "DeepSeek".into()
    } else if m.contains("qwen") || m.contains("llama") {
        "Ollama".into()
    } else {
        "Other".into()
    }
}

fn agent_name(id: &str) -> &'static str {
    match id {
        "claude" => "Claude Code",
        "antigravity" => "Antigravity",
        "opencode" => "OpenCode",
        _ => "Agent",
    }
}

// ── Claude Code transcripts ──────────────────────────────────

// Claude Code slugs the project path into a folder name, replacing every
// non-alphanumeric character with '-'.
fn claude_project_dir(root: &Path) -> PathBuf {
    let slug: String = root
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    projects_dir().join(slug)
}

// A transcript is one session: the first and last timestamp delimit it, each
// assistant message carries the model and its token usage.
fn parse_claude_transcript(text: &str) -> Option<SessionRecord> {
    let mut start = 0;
    let mut end = 0;
    let mut models: Vec<ModelSlice> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(ts) = v["timestamp"].as_str().and_then(parse_ts) {
            if start == 0 || ts < start {
                start = ts;
            }
            if ts > end {
                end = ts;
            }
        }
        if v["type"].as_str() != Some("assistant") {
            continue;
        }
        let msg = &v["message"];
        let Some(usage) = msg.get("usage") else {
            continue;
        };
        let model = msg["model"]
            .as_str()
            .filter(|m| !m.is_empty())
            .unwrap_or("unknown");
        let n = |key: &str| usage[key].as_u64().unwrap_or(0);
        let input = n("input_tokens");
        let output = n("output_tokens");
        let cache_read = n("cache_read_input_tokens");
        let cache_write = n("cache_creation_input_tokens");
        let cost = estimate_cost(model, input, output, cache_read, cache_write);
        add_model(
            &mut models,
            model,
            &provider_for(model, Some("anthropic")),
            input,
            output,
            cache_read,
            cache_write,
            cost,
        );
    }
    if start == 0 && end == 0 && models.is_empty() {
        return None;
    }
    let start = if start == 0 { end } else { start };
    Some(record_from_models(
        String::new(),
        "claude",
        start,
        end,
        models,
    ))
}

// ── Antigravity CLI history ──────────────────────────────────

// history.jsonl holds one user prompt per line with its workspace; a
// conversation groups them into a session. The file has no token counts, so
// these sessions contribute time and activity but no cost.
fn parse_antigravity_history(text: &str, project: &Path) -> Vec<SessionRecord> {
    let mut by_conversation: BTreeMap<String, (u64, u64)> = BTreeMap::new();
    let mut anonymous = 0u64;
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(workspace) = v["workspace"].as_str() else {
            continue;
        };
        if !Path::new(workspace).starts_with(project) {
            continue;
        }
        let Some(ts) = v["timestamp"].as_u64() else {
            continue;
        };
        let id = match v["conversationId"].as_str() {
            Some(c) => c.to_string(),
            None => {
                anonymous += 1;
                format!("single-{anonymous}")
            }
        };
        let entry = by_conversation.entry(id).or_insert((ts, ts));
        entry.0 = entry.0.min(ts);
        entry.1 = entry.1.max(ts);
    }
    by_conversation
        .into_iter()
        .map(|(id, (start, end))| record_from_models(id, "antigravity", start, end, Vec::new()))
        .collect()
}

// ── OpenCode session database ────────────────────────────────

fn opencode_db() -> Option<PathBuf> {
    if let Some(custom) = std::env::var_os("WORK_OPENCODE_DB") {
        return Some(PathBuf::from(custom));
    }
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/share")
        });
    let db = data.join("opencode/opencode.db");
    db.is_file().then_some(db)
}

fn antigravity_history() -> Option<PathBuf> {
    if let Some(custom) = std::env::var_os("WORK_ANTIGRAVITY_HISTORY") {
        return Some(PathBuf::from(custom));
    }
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    let file = home.join(".gemini/antigravity-cli/history.jsonl");
    file.is_file().then_some(file)
}

fn sql_quote(s: &str) -> String {
    s.replace('\'', "''")
}

// session_v2 stores the aggregates OpenCode already computed (tokens, cost,
// model, start/end), so one read-only query is enough.
fn opencode_sessions(root: &Path) -> Vec<SessionRecord> {
    let Some(db) = opencode_db() else {
        return vec![];
    };
    let dir = sql_quote(&root.to_string_lossy());
    let query = format!(
        "SELECT id, directory, title, model, cost, tokens_input, tokens_output, \
         tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, \
         time_updated FROM session_v2 WHERE directory = '{dir}' OR directory LIKE '{dir}/%' \
         ORDER BY time_created"
    );
    let output = Command::new("sqlite3")
        .args(["-readonly", "-json"])
        .arg(&db)
        .arg(query)
        .output();
    let Ok(out) = output else {
        return vec![];
    };
    if !out.status.success() {
        return vec![];
    }
    parse_opencode_rows(&String::from_utf8_lossy(&out.stdout))
}

fn parse_opencode_rows(raw: &str) -> Vec<SessionRecord> {
    let Ok(Value::Array(rows)) = serde_json::from_str::<Value>(raw) else {
        return vec![];
    };
    let mut out = Vec::new();
    for row in rows {
        let Some(id) = row["id"].as_str() else {
            continue;
        };
        let start = row["time_created"].as_u64().unwrap_or(0);
        let end = row["time_updated"].as_u64().unwrap_or(start);
        if start == 0 {
            continue;
        }
        let mut model = row["model"].as_str().unwrap_or("unknown").to_string();
        let mut provider = String::new();
        if let Ok(meta) = serde_json::from_str::<Value>(&model) {
            if let Some(name) = meta["id"].as_str() {
                model = name.to_string();
            }
            if let Some(name) = meta["providerID"].as_str() {
                provider = name.to_string();
            }
        }
        let input = row["tokens_input"].as_u64().unwrap_or(0);
        let output = row["tokens_output"].as_u64().unwrap_or(0)
            + row["tokens_reasoning"].as_u64().unwrap_or(0);
        let cache_read = row["tokens_cache_read"].as_u64().unwrap_or(0);
        let cache_write = row["tokens_cache_write"].as_u64().unwrap_or(0);
        let cost = row["cost"].as_f64().unwrap_or(0.0);
        let mut models = Vec::new();
        add_model(
            &mut models,
            &model,
            &provider_for(&model, (!provider.is_empty()).then_some(provider.as_str())),
            input,
            output,
            cache_read,
            cache_write,
            cost,
        );
        out.push(record_from_models(
            id.to_string(),
            "opencode",
            start,
            end,
            models,
        ));
    }
    out
}

// ── Per-file cache ───────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
struct CacheEntry {
    mtime: u64,
    size: u64,
    sessions: Vec<SessionRecord>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct Cache {
    version: u32,
    files: HashMap<String, CacheEntry>,
}

fn file_signature(path: &Path) -> Option<(u64, u64)> {
    let meta = fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64);
    Some((mtime, meta.len()))
}

fn load_cache(root: &Path) -> Cache {
    fs::read_to_string(root.join(CACHE_FILE))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_cache(root: &Path, cache: &Cache) {
    let Ok(value) = serde_json::to_value(cache) else {
        return;
    };
    let _ = crate::store::save(&root.join(CACHE_FILE), &value);
}

struct Collector {
    old: Cache,
    next: Cache,
    dirty: bool,
}

impl Collector {
    fn new(old: Cache) -> Self {
        Collector {
            old,
            next: Cache {
                version: 1,
                files: HashMap::new(),
            },
            dirty: false,
        }
    }

    // Returns the cached sessions for this file when its signature did not
    // change; otherwise runs `parse` and remembers the result.
    fn sessions<F>(&mut self, key: String, path: &Path, parse: F) -> Vec<SessionRecord>
    where
        F: FnOnce() -> Vec<SessionRecord>,
    {
        let Some((mtime, size)) = file_signature(path) else {
            return vec![];
        };
        if let Some(entry) = self.old.files.get(&key) {
            if entry.mtime == mtime && entry.size == size {
                self.next.files.insert(key, entry.clone());
                return entry.sessions.clone();
            }
        }
        self.dirty = true;
        let sessions = parse();
        self.next.files.insert(
            key,
            CacheEntry {
                mtime,
                size,
                sessions: sessions.clone(),
            },
        );
        sessions
    }

    fn finish(mut self, root: &Path) {
        // Deleted transcripts must not linger in the cache forever.
        if self
            .old
            .files
            .keys()
            .any(|k| !self.next.files.contains_key(k))
        {
            self.dirty = true;
        }
        if self.dirty {
            save_cache(root, &self.next);
        }
    }
}

fn read_to_string(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    // A pathological transcript must not stall the panel.
    if meta.len() > 64 * 1024 * 1024 {
        return None;
    }
    fs::read_to_string(path).ok()
}

fn collect_records(root: &Path) -> Vec<SessionRecord> {
    let mut c = Collector::new(load_cache(root));
    let mut out = Vec::new();

    let dir = claude_project_dir(root);
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if !is_session_file(name) {
                continue;
            }
            let key = format!("claude:{}", path.display());
            let mut sessions = c.sessions(key, &path, || {
                read_to_string(&path)
                    .and_then(|text| parse_claude_transcript(&text))
                    .into_iter()
                    .collect()
            });
            let id = name.trim_end_matches(".jsonl").to_string();
            for s in &mut sessions {
                s.id = id.clone();
            }
            out.extend(sessions);
        }
    }

    if let Some(history) = antigravity_history() {
        let key = format!("antigravity:{}", history.display());
        let project = root.to_path_buf();
        out.extend(c.sessions(key, &history, || {
            read_to_string(&history)
                .map(|text| parse_antigravity_history(&text, &project))
                .unwrap_or_default()
        }));
    }

    if let Some(db) = opencode_db() {
        let wal = db.with_extension("db-wal");
        // The WAL carries the newest writes: its mtime is part of the signature.
        let mut signature_path = db.clone();
        if let Some((wal_mtime, _)) = file_signature(&wal) {
            if let Some((db_mtime, _)) = file_signature(&db) {
                if wal_mtime > db_mtime {
                    signature_path = wal;
                }
            }
        }
        let key = format!("opencode:{}", db.display());
        let project = root.to_path_buf();
        out.extend(c.sessions(key, &signature_path, || opencode_sessions(&project)));
    }

    c.finish(root);
    out
}

// ── Ticket lifecycle ─────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct Transition {
    state: String,
    at: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct HistoryIssue {
    first_seen: u64,
    started_at: Option<u64>,
    done_at: Option<u64>,
    last_state: String,
    reopened: bool,
    transitions: Vec<Transition>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct History {
    version: u32,
    issues: BTreeMap<String, HistoryIssue>,
}

fn load_history(root: &Path) -> History {
    fs::read_to_string(root.join(HISTORY_FILE))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_history(root: &Path, history: &History) {
    let Ok(value) = serde_json::to_value(history) else {
        return;
    };
    let _ = crate::store::save(&root.join(HISTORY_FILE), &value);
}

fn normal_state(state: &str) -> String {
    match state.to_lowercase().as_str() {
        "in progress" | "in-progress" | "in_progress" => "in progress".into(),
        "re-open" | "reopen" | "re_opened" => "re-open".into(),
        other => other.to_string(),
    }
}

// Folds the dogwatch's last-seen states into a durable transition history.
// The dogwatch only keeps the current state, so without this file there would
// be no way to measure a Dev→QA→Done cycle after the fact.
fn observe_tickets(state: &Value, history: &mut History, now: u64) -> bool {
    let Some(issues) = state.get("issues").and_then(Value::as_object) else {
        return false;
    };
    let mut changed = false;
    for (id, record) in issues {
        let Some(raw_state) = record["state"].as_str().filter(|s| !s.is_empty()) else {
            continue;
        };
        let current = normal_state(raw_state);
        let at = record["timestamp"]
            .as_str()
            .and_then(parse_ts)
            .unwrap_or(now);
        let issue = history
            .issues
            .entry(id.clone())
            .or_insert_with(|| HistoryIssue {
                first_seen: at,
                ..Default::default()
            });
        if issue.first_seen == 0 {
            issue.first_seen = at;
        }
        if issue.last_state == current {
            continue;
        }
        changed = true;
        issue.transitions.push(Transition {
            state: current.clone(),
            at,
        });
        match current.as_str() {
            "todo" | "test" | "in progress" | "re-open" => {
                if issue.started_at.is_none() {
                    issue.started_at = Some(at);
                }
                if current == "re-open" {
                    issue.reopened = true;
                }
            }
            "done" => {
                issue.done_at = Some(at);
            }
            _ => {}
        }
        issue.last_state = current;
    }
    changed
}

#[derive(Default)]
struct TicketSummary {
    tickets: Vec<TicketStat>,
    done: u64,
    open: u64,
    avg_cycle_ms: Option<u64>,
    first_pass_rate: Option<f64>,
}

fn summarize_tickets(history: &History) -> TicketSummary {
    let mut out = TicketSummary::default();
    let mut cycles = Vec::new();
    let mut done_first_pass = 0u64;
    for (id, issue) in &history.issues {
        let done = issue.done_at.is_some() || issue.last_state == "done";
        let cycle = match (issue.started_at, issue.done_at) {
            (Some(start), Some(end)) if end >= start => Some(end - start),
            _ => None,
        };
        if done {
            out.done += 1;
            if issue.reopened {
                // A QA re-open means the ticket did not pass on the first try.
            } else {
                done_first_pass += 1;
            }
            if let Some(ms) = cycle {
                cycles.push(ms);
            }
        } else if !matches!(issue.last_state.as_str(), "done" | "cancelled") {
            out.open += 1;
        }
        out.tickets.push(TicketStat {
            id: id.clone(),
            state: if issue.last_state.is_empty() {
                "unknown".into()
            } else {
                issue.last_state.clone()
            },
            started_at: issue.started_at,
            done_at: issue.done_at,
            cycle_ms: cycle,
            first_pass: done && !issue.reopened,
        });
    }
    out.tickets.sort_by(|a, b| {
        b.done_at
            .unwrap_or(0)
            .cmp(&a.done_at.unwrap_or(0))
            .then_with(|| a.id.cmp(&b.id))
    });
    if !cycles.is_empty() {
        out.avg_cycle_ms = Some(cycles.iter().sum::<u64>() / cycles.len() as u64);
    }
    if out.done > 0 {
        out.first_pass_rate = Some(done_first_pass as f64 / out.done as f64);
    }
    out
}

// ── Aggregation ──────────────────────────────────────────────

fn aggregate(
    project: &str,
    records: &[SessionRecord],
    history: &History,
    now: u64,
) -> AnalyticsSummary {
    let tickets = summarize_tickets(history);
    let mut models: BTreeMap<String, ModelUsage> = BTreeMap::new();
    let mut agents: BTreeMap<String, (u64, u64, f64, u64, u64)> = BTreeMap::new();
    let mut daily: BTreeMap<String, DailyPoint> = BTreeMap::new();
    let mut totals = Totals::default();

    for rec in records {
        if rec.started_at == 0 {
            continue;
        }
        totals.sessions += 1;
        totals.tokens += rec.tokens;
        totals.input_tokens += rec.input_tokens;
        totals.output_tokens += rec.output_tokens;
        totals.cost_usd += rec.cost_usd;
        let duration = rec.ended_at.saturating_sub(rec.started_at);
        let agent = agents.entry(rec.agent.clone()).or_insert((0, 0, 0.0, 0, 0));
        agent.0 += 1;
        agent.1 += rec.tokens;
        agent.2 += rec.cost_usd;
        agent.3 += duration;
        agent.4 += u64::from(duration > 0);
        for slice in &rec.models {
            let key = format!("{}/{}", slice.provider, slice.model);
            let entry = models.entry(key.clone()).or_insert_with(|| ModelUsage {
                key,
                provider: slice.provider.clone(),
                model: slice.model.clone(),
                ..Default::default()
            });
            entry.sessions += 1;
            entry.input_tokens += slice.input_tokens;
            entry.output_tokens += slice.output_tokens;
            entry.tokens += slice.tokens;
            entry.cost_usd += slice.cost_usd;
        }
        let point = daily
            .entry(day_key(rec.started_at))
            .or_insert_with(|| DailyPoint {
                date: day_key(rec.started_at),
                ..Default::default()
            });
        point.sessions += 1;
        point.tokens += rec.tokens;
    }

    for ticket in &tickets.tickets {
        if let Some(done) = ticket.done_at {
            daily
                .entry(day_key(done))
                .or_insert_with(|| DailyPoint {
                    date: day_key(done),
                    ..Default::default()
                })
                .tickets += 1;
        }
    }

    // A dense window keeps the trend readable even on quiet days.
    let end_day = now / DAY_MS;
    let mut dense = BTreeMap::new();
    for offset in (0..DAILY_DAYS).rev() {
        let key = day_key(end_day.saturating_sub(offset) * DAY_MS);
        dense.insert(
            key.clone(),
            daily.remove(&key).unwrap_or(DailyPoint {
                date: key,
                ..Default::default()
            }),
        );
    }

    totals.tickets_done = tickets.done;
    totals.tickets_open = tickets.open;
    totals.avg_cycle_ms = tickets.avg_cycle_ms;
    totals.qa_first_pass_rate = tickets.first_pass_rate;

    let mut model_list: Vec<ModelUsage> = models.into_values().collect();
    model_list.sort_by(|a, b| {
        b.tokens
            .cmp(&a.tokens)
            .then_with(|| {
                b.cost_usd
                    .partial_cmp(&a.cost_usd)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| a.key.cmp(&b.key))
    });

    let agent_list = agents
        .into_iter()
        .map(
            |(id, (sessions, tokens, cost, duration, measured))| AgentUsage {
                id: id.clone(),
                name: agent_name(&id).to_string(),
                sessions,
                tokens,
                cost_usd: cost,
                avg_session_ms: (measured > 0).then(|| duration / measured),
            },
        )
        .collect();

    AnalyticsSummary {
        project: project.to_string(),
        generated_at: now,
        totals,
        models: model_list,
        agents: agent_list,
        daily: dense.into_values().collect(),
        tickets: tickets.tickets,
    }
}

// ── IPC ──────────────────────────────────────────────────────

fn summary_for(root: &Path) -> Result<AnalyticsSummary, String> {
    let now = now_ms();
    let records = collect_records(root);
    let state_path = root.join(".claude/plane_dogwatch_state.json");
    let state = fs::read_to_string(&state_path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .unwrap_or(Value::Null);
    let mut history = load_history(root);
    if observe_tickets(&state, &mut history, now) {
        history.version = 1;
        save_history(root, &history);
    }
    Ok(aggregate(&root.to_string_lossy(), &records, &history, now))
}

#[tauri::command]
pub async fn analytics_get_summary(
    roots: State<'_, Roots>,
    project_path: String,
) -> Result<AnalyticsSummary, String> {
    let root = guard(&roots.get(), Path::new(&project_path), true)?;
    tauri::async_runtime::spawn_blocking(move || summary_for(&root))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_root() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn ticket_state(id: &str, state: &str, iso: &str) -> Value {
        json!({ "issues": { id: { "state": state, "timestamp": iso } } })
    }

    #[test]
    fn parses_claude_usage_and_models() {
        let transcript = [
            r#"{"type":"user","timestamp":"2026-11-01T10:00:00Z","cwd":"/p"}"#,
            r#"{"type":"assistant","timestamp":"2026-11-01T10:01:00Z","message":{"model":"claude-sonnet-4","usage":{"input_tokens":1000,"output_tokens":500,"cache_read_input_tokens":2000,"cache_creation_input_tokens":100}}}"#,
            r#"{"type":"assistant","timestamp":"2026-11-01T10:05:00Z","message":{"model":"claude-sonnet-4","usage":{"input_tokens":2000,"output_tokens":1000}}}"#,
        ]
        .join("\n");
        let rec = parse_claude_transcript(&transcript).unwrap();
        assert_eq!(rec.agent, "claude");
        assert_eq!(rec.started_at, parse_ts("2026-11-01T10:00:00Z").unwrap());
        assert_eq!(rec.ended_at, parse_ts("2026-11-01T10:05:00Z").unwrap());
        assert_eq!(rec.input_tokens, 3000);
        assert_eq!(rec.output_tokens, 1500);
        assert_eq!(rec.tokens, 6600);
        assert_eq!(rec.models.len(), 1);
        assert_eq!(rec.models[0].model, "claude-sonnet-4");
        assert_eq!(rec.models[0].cache_read_tokens, 2000);
        assert!(rec.cost_usd > 0.0);
    }

    #[test]
    fn a_transcript_without_usage_is_not_a_session() {
        assert!(parse_claude_transcript("").is_none());
        assert!(parse_claude_transcript(r#"{"type":"user"}"#).is_none());
    }

    #[test]
    fn parses_antigravity_history_and_groups_conversations() {
        let history = [
            r#"{"display":"a","timestamp":1000,"workspace":"/p","conversationId":"c1"}"#,
            r#"{"display":"b","timestamp":5000,"workspace":"/p/sub","conversationId":"c1"}"#,
            r#"{"display":"c","timestamp":2000,"workspace":"/other","conversationId":"c2"}"#,
            r#"{"display":"d","timestamp":3000,"workspace":"/p","conversationId":"c3"}"#,
        ]
        .join("\n");
        let sessions = parse_antigravity_history(&history, Path::new("/p"));
        assert_eq!(sessions.len(), 2);
        let c1 = sessions.iter().find(|s| s.id == "c1").unwrap();
        assert_eq!(c1.started_at, 1000);
        assert_eq!(c1.ended_at, 5000);
        assert_eq!(sessions.iter().find(|s| s.id == "c3").unwrap().tokens, 0);
    }

    #[test]
    fn parses_opencode_rows_with_provider_and_cost() {
        let raw = r#"[{"id":"ses_1","directory":"/p","model":"{\"id\":\"deepseek-v4.1\",\"providerID\":\"ollama\"}","cost":0.25,"tokens_input":100,"tokens_output":20,"tokens_reasoning":5,"tokens_cache_read":30,"tokens_cache_write":0,"time_created":1000,"time_updated":9000}]"#;
        let rows = parse_opencode_rows(raw);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].agent, "opencode");
        assert_eq!(rows[0].tokens, 155);
        assert_eq!(rows[0].cost_usd, 0.25);
        assert_eq!(rows[0].models[0].provider, "Ollama");
        assert_eq!(rows[0].models[0].output_tokens, 25);
    }

    #[test]
    fn ticket_history_measures_the_cycle_and_first_pass_rate() {
        let mut history = History::default();
        let first = parse_ts("2026-11-01T10:00:00Z").unwrap();
        let second = parse_ts("2026-11-01T12:00:00Z").unwrap();
        let third = parse_ts("2026-11-01T14:00:00Z").unwrap();
        observe_tickets(
            &ticket_state("a", "In Progress", "2026-11-01T10:00:00Z"),
            &mut history,
            first,
        );
        observe_tickets(
            &ticket_state("a", "Test", "2026-11-01T12:00:00Z"),
            &mut history,
            second,
        );
        observe_tickets(
            &ticket_state("a", "Done", "2026-11-01T14:00:00Z"),
            &mut history,
            third,
        );
        observe_tickets(
            &ticket_state("b", "In Progress", "2026-11-01T10:00:00Z"),
            &mut history,
            first,
        );
        observe_tickets(
            &ticket_state("b", "Re-open", "2026-11-01T11:00:00Z"),
            &mut history,
            second,
        );
        observe_tickets(
            &ticket_state("b", "Done", "2026-11-01T15:00:00Z"),
            &mut history,
            third,
        );

        let summary = summarize_tickets(&history);
        assert_eq!(summary.done, 2);
        assert_eq!(summary.avg_cycle_ms, Some(16_200_000));
        assert_eq!(summary.first_pass_rate, Some(0.5));
        assert!(
            !summary
                .tickets
                .iter()
                .find(|t| t.id == "b")
                .unwrap()
                .first_pass
        );
    }

    #[test]
    fn a_ticket_already_done_at_first_look_does_not_claim_a_cycle() {
        let mut history = History::default();
        observe_tickets(
            &ticket_state("old", "Done", "2026-11-01T10:00:00Z"),
            &mut history,
            0,
        );
        let summary = summarize_tickets(&history);
        assert_eq!(summary.done, 1);
        assert_eq!(summary.avg_cycle_ms, None);
        assert!(summary.tickets[0].done_at.is_some());
    }

    #[test]
    fn aggregation_totals_models_agents_and_a_dense_window() {
        let now = parse_ts("2026-11-03T12:00:00Z").unwrap();
        let record = SessionRecord {
            id: "s".into(),
            agent: "claude".into(),
            started_at: parse_ts("2026-11-01T10:00:00Z").unwrap(),
            ended_at: parse_ts("2026-11-01T11:00:00Z").unwrap(),
            input_tokens: 100,
            output_tokens: 50,
            tokens: 150,
            cost_usd: 0.5,
            models: vec![ModelSlice {
                model: "claude-sonnet-4".into(),
                provider: "Anthropic".into(),
                input_tokens: 100,
                output_tokens: 50,
                tokens: 150,
                cost_usd: 0.5,
                ..Default::default()
            }],
        };
        let summary = aggregate("/p", &[record], &History::default(), now);
        assert_eq!(summary.totals.sessions, 1);
        assert_eq!(summary.totals.tokens, 150);
        assert_eq!(summary.models.len(), 1);
        assert_eq!(summary.agents[0].name, "Claude Code");
        assert_eq!(summary.agents[0].avg_session_ms, Some(3_600_000));
        assert_eq!(summary.daily.len() as u64, DAILY_DAYS);
        assert_eq!(summary.daily.last().unwrap().date, "2026-11-03");
    }

    #[test]
    fn cache_reuses_an_unchanged_transcript() {
        let d = temp_root();
        let file = d.path().join("a.txt");
        fs::write(&file, "one").unwrap();
        let mut c = Collector::new(Cache::default());
        let counter = AtomicU64::new(0);
        let first = c.sessions("k".into(), &file, || {
            counter.fetch_add(1, Ordering::SeqCst);
            vec![SessionRecord {
                id: "s".into(),
                ..Default::default()
            }]
        });
        assert_eq!(first.len(), 1);
        // A later run loads the cache from disk: the same signature must hit.
        let mut c = Collector::new(c.next.clone());
        let second = c.sessions("k".into(), &file, || {
            counter.fetch_add(1, Ordering::SeqCst);
            vec![]
        });
        assert_eq!(second.len(), 1);
        assert_eq!(counter.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn day_keys_are_calendar_days() {
        assert_eq!(
            day_key(parse_ts("2026-11-01T00:00:00Z").unwrap()),
            "2026-11-01"
        );
        assert_eq!(
            day_key(parse_ts("2026-11-01T23:59:59Z").unwrap()),
            "2026-11-01"
        );
        assert_eq!(
            day_key(parse_ts("2026-03-01T00:00:00Z").unwrap()),
            "2026-03-01"
        );
    }
}
