// AgentWatcher: follows Claude Code session transcripts
// (~/.claude/projects/<project>/<session>.jsonl) and turns them into a
// live picture of what each agent is doing.
use crate::claudeprocs;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const WINDOW_MS: f64 = 24.0 * 3600.0 * 1000.0; // sessions touched in the last 24h
const TAIL_BYTES: u64 = 256 * 1024;
const MAX_EVENTS: usize = 60;

pub fn projects_dir() -> PathBuf {
    match std::env::var_os("WORK_CLAUDE_PROJECTS") {
        Some(d) => PathBuf::from(d),
        None => PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".claude/projects"),
    }
}

// Claude Code names transcripts <session-uuid>.jsonl. The id ends up in a
// shell command ("claude --resume <id>"), so anything else is ignored.
// Same as /^[0-9a-f]{8}-…-[0-9a-f]{12}\.jsonl$/i.
pub fn is_session_file(name: &str) -> bool {
    let b = name.as_bytes();
    b.len() == 42
        && b[36..].eq_ignore_ascii_case(b".jsonl")
        && b[..36].iter().enumerate().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { *c == b'-' } else { c.is_ascii_hexdigit() })
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

fn mtime_ms(m: &fs::Metadata) -> f64 {
    m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

// A whole number goes out as an integer, like a JS number would.
fn num(f: f64) -> Value {
    if f.fract() == 0.0 && f.abs() < 9e15 {
        json!(f as i64)
    } else {
        json!(f)
    }
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        _ => true,
    }
}

// A non-empty string field.
fn text<'a>(e: &'a Value, key: &str) -> Option<&'a str> {
    e.get(key)?.as_str().filter(|s| !s.is_empty())
}

// First n UTF-16 units (JS string length) without cutting an emoji (a
// surrogate pair) in half.
fn clip(s: &str, n: usize) -> String {
    let mut units = 0;
    s.chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= n
        })
        .collect()
}

// Date.parse for the ISO 8601 timestamps Claude Code writes; NaN (null) otherwise.
fn parse_ts(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    let n = |from: usize, len: usize| -> Option<i64> {
        let d = b.get(from..from + len)?;
        d.iter().all(u8::is_ascii_digit).then(|| s[from..from + len].parse().ok())?
    };
    let at = |i: usize, c: u8| b.get(i) == Some(&c);
    let (y, mo, d) = (n(0, 4)?, n(5, 2)?, n(8, 2)?);
    if !at(4, b'-') || !at(7, b'-') || !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    let (mut h, mut mi, mut sec, mut ms, mut i) = (0, 0, 0, 0, 10);
    if at(10, b'T') || at(10, b' ') {
        (h, mi, i) = (n(11, 2)?, n(14, 2)?, 16);
        if !at(13, b':') {
            return None;
        }
        if at(16, b':') {
            (sec, i) = (n(17, 2)?, 19);
            if at(19, b'.') {
                let digits = b[20..].iter().take_while(|c| c.is_ascii_digit()).count();
                if digits == 0 {
                    return None;
                }
                ms = s[20..20 + digits.min(3)].parse::<i64>().ok()? * 10i64.pow(3 - digits.min(3) as u32);
                i = 20 + digits;
            }
        }
        if h > 24 || mi > 59 || sec > 59 {
            return None;
        }
    }
    // ponytail: no offset is read as UTC (JS: local time for a date-time); Claude Code always writes "Z".
    let offset = match b.get(i) {
        None => 0,
        Some(b'Z') if i + 1 == b.len() => 0,
        Some(&c @ (b'+' | b'-')) if b.len() == i + 6 && at(i + 3, b':') => {
            let o = n(i + 1, 2)? * 60 + n(i + 4, 2)?;
            if c == b'+' {
                o
            } else {
                -o
            }
        }
        _ => return None,
    };
    // Days since 1970-01-01 from a civil date (Howard Hinnant's algorithm).
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let days = era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;
    Some(((days * 24 + h) * 60 + mi - offset) * 60_000 + sec * 1000 + ms)
}

// The most telling field of a tool call's input, in order of preference.
const SUMMARY_FIELDS: [&str; 6] = ["command", "file_path", "pattern", "url", "description", "prompt"];

fn summarize_input(input: Option<&Value>) -> String {
    let input = input.cloned().unwrap_or_else(|| json!({}));
    for f in SUMMARY_FIELDS {
        match input.get(f) {
            Some(Value::String(s)) if !s.is_empty() => return s.clone(),
            Some(v) if truthy(Some(v)) => return v.to_string(),
            _ => {}
        }
    }
    let s = input.to_string();
    if s.len() > 2 {
        s
    } else {
        String::new()
    }
}

fn text_of(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .filter(|c| c.get("type").and_then(Value::as_str) == Some("text"))
            .map(|c| c.get("text").and_then(Value::as_str).unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

// The last /"permissionMode":"(\w+)"/ in a latin1 block.
fn last_mode(buf: &[u8]) -> Option<String> {
    const NEEDLE: &[u8] = b"\"permissionMode\":\"";
    let mut found = None;
    for i in 0..buf.len().saturating_sub(NEEDLE.len()) {
        if &buf[i..i + NEEDLE.len()] != NEEDLE {
            continue;
        }
        let from = i + NEEDLE.len();
        let len = buf[from..].iter().take_while(|c| c.is_ascii_alphanumeric() || **c == b'_').count();
        if len > 0 && buf.get(from + len) == Some(&b'"') {
            found = Some(String::from_utf8_lossy(&buf[from..from + len]).into_owned());
        }
    }
    found
}

// The permission mode is written once per turn: a long autonomous run can
// push it out of the tail read at start. Look for its last value before
// `end`, reading backwards in blocks.
fn last_mode_before(file: &Path, end: u64) -> io::Result<Option<String>> {
    const BLOCK: u64 = 1024 * 1024;
    let mut f = File::open(file)?;
    let mut pos = end;
    while pos > 0 {
        let start = pos.saturating_sub(BLOCK);
        let mut buf = Vec::new();
        f.seek(SeekFrom::Start(start))?;
        // overlap: a match cut at a block edge
        (&mut f).take(end.min(pos + 64) - start).read_to_end(&mut buf)?;
        if let Some(m) = last_mode(&buf) {
            return Ok(Some(m));
        }
        pos = start;
    }
    Ok(None)
}

#[derive(Serialize, Clone, Debug)]
pub struct Event {
    ts: Option<i64>,
    kind: &'static str,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool: Option<String>,
}

pub struct Session {
    file: PathBuf,
    id: String,
    offset: u64,
    partial: String,
    // Keeps a multi-byte character cut by a read in the middle of a write.
    pending: Vec<u8>,
    events: Vec<Event>,
    event_seq: u64, // grows with every event, even once the list is capped
    cwd: Option<String>,
    title: Option<String>,
    agent_name: Option<String>,
    ai_title: Option<String>,
    last_kind: Option<&'static str>, // user | assistant-tool | assistant-end | tool-result
    last_tool: Option<String>,
    mtime: f64,
    tokens: f64,
    permission_mode: Option<String>,
}

impl Session {
    pub fn new(file: &Path) -> Self {
        let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        Session {
            file: file.to_path_buf(),
            id: name.strip_suffix(".jsonl").unwrap_or(&name).to_string(),
            offset: 0,
            partial: String::new(),
            pending: Vec::new(),
            events: Vec::new(),
            event_seq: 0,
            cwd: None,
            title: None,
            agent_name: None,
            ai_title: None,
            last_kind: None,
            last_tool: None,
            mtime: 0.0,
            tokens: 0.0,
            permission_mode: None,
        }
    }

    // UTF-8 like Node's StringDecoder: an incomplete sequence at the end waits
    // for the next read, invalid bytes become U+FFFD.
    fn decode(&mut self, buf: &[u8]) -> String {
        let mut bytes = std::mem::take(&mut self.pending);
        bytes.extend_from_slice(buf);
        let mut out = String::new();
        let mut rest = &bytes[..];
        loop {
            match std::str::from_utf8(rest) {
                Ok(s) => {
                    out.push_str(s);
                    return out;
                }
                Err(e) => {
                    let (ok, bad) = rest.split_at(e.valid_up_to());
                    out.push_str(std::str::from_utf8(ok).unwrap_or_default());
                    match e.error_len() {
                        None => {
                            self.pending = bad.to_vec();
                            return out;
                        }
                        Some(n) => {
                            out.push('\u{FFFD}');
                            rest = &bad[n..];
                        }
                    }
                }
            }
        }
    }

    pub fn read(&mut self) -> io::Result<bool> {
        let meta = fs::metadata(&self.file)?;
        let size = meta.len();
        if size < self.offset {
            // Truncated / rewritten: start over, dropping the half line read before.
            self.offset = 0;
            self.partial.clear();
            self.pending.clear();
        }
        if size == self.offset {
            return Ok(false);
        }
        let mut skipped = 0;
        if self.offset == 0 && size > TAIL_BYTES {
            self.offset = size - TAIL_BYTES;
            skipped = self.offset;
        }

        let mut f = File::open(&self.file)?;
        f.seek(SeekFrom::Start(self.offset))?;
        let mut buf = Vec::new();
        f.take(size - self.offset).read_to_end(&mut buf)?;
        self.offset = size;
        self.mtime = mtime_ms(&meta);

        let text = std::mem::take(&mut self.partial) + &self.decode(&buf);
        let mut lines: Vec<&str> = text.split('\n').collect();
        self.partial = lines.pop().unwrap_or_default().to_string();
        for line in lines {
            if line.trim().is_empty() {
                continue;
            }
            // first line of a tail read may be cut in half
            if let Ok(e) = serde_json::from_str::<Value>(line) {
                self.ingest(&e);
            }
        }
        if skipped > 0 && self.permission_mode.is_none() {
            self.permission_mode = last_mode_before(&self.file, skipped).unwrap_or(None);
        }
        Ok(true)
    }

    fn push(&mut self, ts: Option<i64>, kind: &'static str, text: String, tool: Option<String>) {
        self.event_seq += 1;
        self.events.push(Event { ts, kind, text, tool });
        if self.events.len() > MAX_EVENTS {
            self.events.remove(0);
        }
    }

    fn ingest(&mut self, e: &Value) {
        if let Some(cwd) = text(e, "cwd") {
            self.cwd = Some(cwd.into());
        }
        // "permission-mode" entries (and user messages) carry the session's mode.
        if let Some(m) = text(e, "permissionMode") {
            self.permission_mode = Some(m.into());
        }
        // Title priority: explicit agent name > AI title > first prompt
        let ty = e.get("type").and_then(Value::as_str);
        if ty == Some("agent-name") {
            if let Some(n) = text(e, "agentName") {
                self.agent_name = Some(n.into());
            }
        }
        if ty == Some("ai-title") {
            if let Some(t) = text(e, "aiTitle") {
                self.ai_title = Some(t.into());
            }
        }
        if ty == Some("last-prompt") && self.title.is_none() {
            if let Some(p) = text(e, "lastPrompt") {
                self.title = Some(clip(p, 80));
            }
        }
        let ts = if truthy(e.get("timestamp")) { e["timestamp"].as_str().and_then(parse_ts) } else { Some(now_ms() as i64) };
        let msg = match e.get("message") {
            Some(m) if truthy(Some(m)) && !truthy(e.get("isSidechain")) => m,
            _ => return,
        };

        if ty == Some("user") {
            let content = msg.get("content");
            // Esc / Ctrl+C in Claude Code: the turn is over and it waits for you.
            if text_of(content).starts_with("[Request interrupted by user") {
                self.last_kind = Some("assistant-end");
                return;
            }
            let result = content.and_then(Value::as_array).and_then(|a| a.iter().find(|c| c.get("type").and_then(Value::as_str) == Some("tool_result")));
            if let Some(r) = result {
                self.last_kind = Some("tool-result");
                if truthy(r.get("is_error")) {
                    let t = clip(&text_of(r.get("content")), 300);
                    self.push(ts, "error", if t.is_empty() { "errore tool".into() } else { t }, None);
                }
                return;
            }
            let t = text_of(content);
            let t = t.trim();
            if t.is_empty() || t.starts_with('<') {
                return; // system reminders, command wrappers
            }
            if self.title.is_none() {
                self.title = Some(clip(t, 80));
            }
            self.last_kind = Some("user");
            self.push(ts, "user", clip(t, 400), None);
            return;
        }

        if ty == Some("assistant") {
            if let Some(u) = msg.get("usage").filter(|u| truthy(Some(u))) {
                let n = |k: &str| u.get(k).and_then(Value::as_f64).unwrap_or(0.0);
                self.tokens = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens") + n("output_tokens");
            }
            for c in msg.get("content").and_then(Value::as_array).into_iter().flatten() {
                match c.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        let t = c.get("text").and_then(Value::as_str).unwrap_or("").trim();
                        if !t.is_empty() {
                            self.push(ts, "text", clip(t, 400), None);
                        }
                    }
                    Some("tool_use") => {
                        let name = c.get("name").and_then(Value::as_str).map(String::from);
                        self.last_tool.clone_from(&name);
                        self.push(ts, "tool", clip(&summarize_input(c.get("input")), 300), name);
                    }
                    _ => {}
                }
            }
            match msg.get("stop_reason").and_then(Value::as_str) {
                Some("tool_use") => self.last_kind = Some("assistant-tool"),
                Some("end_turn") => self.last_kind = Some("assistant-end"),
                _ => {}
            }
        }
    }

    fn status(&self) -> (&'static str, String) {
        let idle = now_ms() - self.mtime;
        let tool = self.last_tool.as_deref().unwrap_or("undefined");
        if idle > 10.0 * 60.0 * 1000.0 {
            return ("idle", "Inattivo".into());
        }
        match self.last_kind {
            Some("assistant-end") => ("waiting", "Attende il tuo input".into()),
            // A tool call with no result for a while usually means a permission
            // prompt, unless permissions are bypassed: then it's just a long tool.
            Some("assistant-tool") if idle > 15000.0 && self.permission_mode.as_deref() != Some("bypassPermissions") => ("blocked", format!("Attende permesso: {tool}")),
            Some("assistant-tool") => ("working", format!("Esegue {tool}")),
            _ => ("working", "Sta ragionando…".into()),
        }
    }

    // open: true/false when Claude Code says whether the process is running,
    // None when it can't be known (older versions without ~/.claude/sessions).
    pub fn to_json(&self, open: Option<bool>) -> Value {
        let (mut state, mut label) = self.status();
        // A closed session is not working nor waiting, whatever its transcript says.
        if open == Some(false) && state != "idle" {
            (state, label) = ("idle", "Chiusa".into());
        }
        let base = |p: &Path| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let project = match &self.cwd {
            Some(cwd) => base(Path::new(cwd)),
            None => self.file.parent().map(base).unwrap_or_default(),
        };
        json!({
            "id": self.id,
            "cwd": self.cwd,
            "project": project,
            "title": self.agent_name.as_ref().or(self.ai_title.as_ref()).or(self.title.as_ref()).map_or("Sessione", String::as_str),
            "mtime": num(self.mtime),
            "tokens": num(self.tokens),
            "status": { "state": state, "label": label },
            "live": open == Some(true),
            // Events stay out of the list (it goes to the UI several times a second);
            // the detail view asks for them with events(id) when eventSeq moves.
            "eventSeq": self.event_seq,
        })
    }
}

fn state_key(list: &[Value]) -> String {
    list.iter().map(|a| format!("{}:{}:{}", a["status"]["state"].as_str().unwrap_or(""), a["status"]["label"].as_str().unwrap_or(""), a["live"])).collect::<Vec<_>>().join(",")
}

#[derive(Default)]
struct State {
    sessions: HashMap<PathBuf, Session>,
    last_states: String,
}

struct Shared {
    projects: PathBuf,
    sessions_dir: PathBuf,
    on_update: Box<dyn Fn(Vec<Value>) + Send + Sync>,
    state: Mutex<State>,
}

impl Shared {
    fn list(&self) -> Vec<Value> {
        let open = claudeprocs::tracked(&self.sessions_dir).then(|| claudeprocs::live(&self.sessions_dir));
        let cutoff = now_ms() - WINDOW_MS;
        let st = self.state.lock().unwrap();
        let mut list: Vec<&Session> = st.sessions.values().filter(|s| !s.events.is_empty() && s.mtime >= cutoff).collect();
        // The path breaks ties so the order doesn't flicker between updates.
        list.sort_by(|a, b| b.mtime.total_cmp(&a.mtime).then_with(|| a.file.cmp(&b.file)));
        list.iter().map(|s| s.to_json(open.as_ref().map(|o| o.contains_key(&s.id)))).collect()
    }

    fn emit(&self) {
        let list = self.list();
        self.state.lock().unwrap().last_states = state_key(&list);
        (self.on_update)(list);
    }

    fn emit_if_states_changed(&self) {
        let list = self.list();
        let key = state_key(&list);
        let mut st = self.state.lock().unwrap();
        if key != st.last_states {
            st.last_states = key;
            drop(st);
            (self.on_update)(list);
        }
    }

    fn read_file(&self, file: &Path) -> bool {
        let mut st = self.state.lock().unwrap();
        let s = st.sessions.entry(file.to_path_buf()).or_insert_with(|| Session::new(file));
        match s.read() {
            Ok(changed) => changed,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                st.sessions.remove(file); // transcript deleted: drop the session
                true
            }
            Err(_) => false,
        }
    }

    // Sessions untouched for longer than the window are dropped, so the map
    // (and the list sent to the UI) doesn't grow while the app stays open.
    fn prune(&self) {
        let cutoff = now_ms() - WINDOW_MS;
        self.state.lock().unwrap().sessions.retain(|_, s| s.mtime == 0.0 || s.mtime >= cutoff);
    }
}

enum Msg {
    Fs(notify::Result<notify::Event>),
    Stop,
}

// Owned by the watcher thread: notify's FSEvents backend restarts its stream
// on watch(), which can't be done from inside its own callback.
struct Worker {
    shared: Arc<Shared>,
    fsw: Option<RecommendedWatcher>,
    // Real paths (FSEvents reports /private/var for /var): event paths compare equal.
    root: PathBuf,
    procs_dir: PathBuf,
    watched: HashSet<PathBuf>,
    started: bool,
    dirty: HashSet<PathBuf>,
    flush_at: Option<Instant>,
    procs_at: Option<Instant>,
}

fn real(p: &Path) -> PathBuf {
    fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

impl Worker {
    fn watch(&mut self, dir: &Path) -> bool {
        self.fsw.as_mut().is_some_and(|w| w.watch(dir, RecursiveMode::NonRecursive).is_ok())
    }

    fn watch_dirs(&mut self) {
        self.root = real(&self.shared.projects);
        let (Ok(rd), Some(fsw)) = (fs::read_dir(&self.root), self.fsw.as_mut()) else { return };
        // One commit for all folders: each watch() restarts the FSEvents stream.
        let mut paths = fsw.paths_mut();
        // A folder removed is forgotten, so one created again is watched again.
        self.watched.retain(|d| {
            let keep = d.is_dir();
            if !keep {
                let _ = paths.remove(d);
            }
            keep
        });
        let mut fresh = Vec::new();
        for entry in rd.flatten() {
            let dir = entry.path();
            if self.watched.contains(&dir) || !dir.is_dir() {
                continue; // not a directory or vanished
            }
            if paths.add(&dir, RecursiveMode::NonRecursive).is_ok() {
                self.watched.insert(dir.clone());
                fresh.push(dir);
            }
        }
        let _ = paths.commit();
        // A project folder that appeared after start may already hold a session
        // written before its watcher existed: read it now, not at its next write.
        if !self.started {
            return;
        }
        for dir in fresh {
            for f in fs::read_dir(&dir).into_iter().flatten().flatten() {
                if f.file_name().to_str().is_some_and(is_session_file) {
                    self.touch(f.path());
                }
            }
        }
    }

    // Coalesce bursts of writes (a streaming reply writes many lines) into one update.
    fn touch(&mut self, file: PathBuf) {
        self.dirty.insert(file);
        self.flush_at.get_or_insert_with(|| Instant::now() + Duration::from_millis(250));
    }

    fn flush(&mut self) {
        self.flush_at = None;
        let mut changed = false;
        for f in std::mem::take(&mut self.dirty) {
            changed |= self.shared.read_file(&f);
        }
        if changed {
            self.shared.emit();
        }
    }

    fn scan(&mut self) {
        self.root = real(&self.shared.projects);
        let now = now_ms();
        for d in fs::read_dir(&self.root).into_iter().flatten().flatten() {
            let Ok(files) = fs::read_dir(d.path()) else { continue };
            for f in files.flatten() {
                if !f.file_name().to_str().is_some_and(is_session_file) {
                    continue;
                }
                let file = f.path();
                match fs::metadata(&file) {
                    Ok(m) if now - mtime_ms(&m) <= WINDOW_MS => {
                        self.shared.read_file(&file);
                    }
                    _ => {}
                }
            }
        }
        self.watch_dirs();
    }

    fn route(&mut self, p: &Path) {
        let parent = p.parent();
        if p == self.procs_dir || parent == Some(&self.procs_dir) {
            // Claude Code adds/removes ~/.claude/sessions/<pid>.json as sessions open
            // and close: refresh "Chiusa" and the close button without waiting a tick.
            self.procs_at = Some(Instant::now() + Duration::from_millis(300));
        } else if p == self.root || parent == Some(&self.root) {
            self.watch_dirs();
        } else if parent.and_then(Path::parent) == Some(&self.root) && p.file_name().and_then(|n| n.to_str()).is_some_and(is_session_file) {
            self.touch(p.to_path_buf());
        }
    }

    fn run(mut self, rx: std::sync::mpsc::Receiver<Msg>) {
        let tick = Duration::from_secs(10);
        let mut tick_at = Instant::now() + tick;
        let mut ticks = 0u32;
        loop {
            let next = [self.flush_at, self.procs_at, Some(tick_at)].into_iter().flatten().min().unwrap_or(tick_at);
            match rx.recv_timeout(next.saturating_duration_since(Instant::now())) {
                Ok(Msg::Stop) | Err(RecvTimeoutError::Disconnected) => return,
                Ok(Msg::Fs(Ok(ev))) => ev.paths.iter().for_each(|p| self.route(p)),
                Ok(Msg::Fs(Err(_))) | Err(RecvTimeoutError::Timeout) => {}
            }
            let now = Instant::now();
            if self.flush_at.is_some_and(|t| t <= now) {
                self.flush();
            }
            if self.procs_at.is_some_and(|t| t <= now) {
                self.procs_at = None;
                self.shared.emit_if_states_changed();
            }
            if tick_at <= now {
                tick_at += tick;
                ticks += 1;
                if ticks.is_multiple_of(6) {
                    self.shared.prune();
                    self.scan();
                    self.shared.emit();
                } else {
                    self.shared.emit_if_states_changed();
                }
            }
        }
    }
}

// Event-driven: inotify/FSEvents tell us which transcript changed, so idle
// cost is ~zero. A full scan runs once at start and every 60 s as a safety
// net (missed events, new project folders); a light 10 s tick only refreshes
// time-based states ("Inattivo", "Attende permesso") without touching disk.
pub struct AgentWatcher {
    shared: Arc<Shared>,
    worker: Mutex<Option<(Sender<Msg>, JoinHandle<()>)>>,
}

impl AgentWatcher {
    pub fn new(projects: PathBuf, sessions_dir: PathBuf, on_update: impl Fn(Vec<Value>) + Send + Sync + 'static) -> Self {
        AgentWatcher {
            shared: Arc::new(Shared { projects, sessions_dir, on_update: Box::new(on_update), state: Mutex::default() }),
            worker: Mutex::new(None),
        }
    }

    pub fn start(&self) {
        let (tx, rx) = channel();
        let events = tx.clone();
        let fsw = notify::recommended_watcher(move |r| {
            let _ = events.send(Msg::Fs(r));
        });
        let mut w = Worker {
            root: real(&self.shared.projects),
            procs_dir: real(&self.shared.sessions_dir),
            shared: self.shared.clone(),
            fsw: fsw.ok(),
            watched: HashSet::new(),
            started: false,
            dirty: HashSet::new(),
            flush_at: None,
            procs_at: None,
        };
        w.scan();
        self.shared.emit();
        // no ~/.claude/projects yet: the 60 s scan will pick its folders up
        let root = w.root.clone();
        w.watch(&root);
        w.watch_dirs();
        // sessions folder missing: the 10 s tick still notices
        let procs = w.procs_dir.clone();
        w.watch(&procs);
        w.started = true;
        let handle = std::thread::spawn(move || w.run(rx));
        *self.worker.lock().unwrap() = Some((tx, handle));
    }

    // A burst still being coalesced must not emit after stop: the thread is gone when this returns.
    pub fn stop(&self) {
        if let Some((tx, handle)) = self.worker.lock().unwrap().take() {
            let _ = tx.send(Msg::Stop);
            let _ = handle.join();
        }
    }

    pub fn list(&self) -> Vec<Value> {
        self.shared.list()
    }

    pub fn emit(&self) {
        self.shared.emit()
    }

    // The same id can live in two project folders (a session resumed elsewhere):
    // the most recently written one is the one the list shows as active.
    pub fn events(&self, id: &str) -> Vec<Event> {
        let st = self.shared.state.lock().unwrap();
        let mut best: Option<&Session> = None;
        for s in st.sessions.values() {
            if s.id == id && best.is_none_or(|b| s.mtime > b.mtime) {
                best = Some(s);
            }
        }
        best.map(|s| s.events.clone()).unwrap_or_default()
    }
}

impl Drop for AgentWatcher {
    fn drop(&mut self) {
        self.stop();
    }
}

// Whether Claude Code has a past conversation for a folder, i.e. whether
// "claude --continue" there has something to continue. Claude Code keeps a
// folder's transcripts in ~/.claude/projects/<path with every character
// other than a letter or digit turned into "-">.
pub fn has_history(projects: &Path, dir: &Value) -> bool {
    let Some(dir) = dir.as_str().filter(|d| d.starts_with('/')) else { return false };
    // One "-" per UTF-16 unit, as the JS regex replaced them.
    let name: String = dir.chars().flat_map(|c| std::iter::repeat_n(if c.is_ascii_alphanumeric() { c } else { '-' }, if c.is_ascii_alphanumeric() { 1 } else { c.len_utf16() })).collect();
    fs::read_dir(projects.join(name)).is_ok_and(|rd| rd.flatten().any(|f| f.file_name().to_str().is_some_and(is_session_file)))
}

fn is_safe_command(c: &str) -> bool {
    !c.is_empty() && c.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}

// Which agent CLIs are installed, resolved through a login shell so
// nvm / ~/.local/bin paths are found like in a normal terminal.
pub async fn available(commands: Vec<String>) -> Vec<String> {
    use tokio::io::AsyncReadExt;
    let safe: Vec<String> = commands.into_iter().filter(|c| is_safe_command(c)).collect();
    if safe.is_empty() {
        return safe;
    }
    let script = safe.iter().map(|c| format!("command -v {c} >/dev/null 2>&1 && echo {c}")).collect::<Vec<_>>().join("; ");
    let shell = crate::pty::user_shell();
    let child = tokio::process::Command::new(shell)
        .arg("-lc")
        .arg(format!("{script}; true"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn();
    let Ok(mut child) = child else { return vec![] };
    let mut out = Vec::new();
    if let Some(mut stdout) = child.stdout.take() {
        // What was printed before the timeout still counts.
        let _ = tokio::time::timeout(Duration::from_secs(8), stdout.read_to_end(&mut out)).await;
    }
    let _ = child.start_kill();
    let _ = child.wait().await;
    String::from_utf8_lossy(&out).split('\n').filter(|l| safe.iter().any(|c| c == l)).map(String::from).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::sleep;

    const UUID: &str = "12345678-1234-1234-1234-123456789abc";

    fn line(o: Value) -> String {
        let mut v = json!({ "timestamp": "2026-09-29T12:00:00.000Z", "cwd": "/work/proj" });
        v.as_object_mut().unwrap().extend(o.as_object().unwrap().clone());
        v.to_string() + "\n"
    }
    fn user(text: &str) -> String {
        line(json!({ "type": "user", "message": { "role": "user", "content": text } }))
    }
    fn tool_use(name: &str, input: Value) -> String {
        tool_call(name, input, Value::Null)
    }
    fn tool_call(name: &str, input: Value, usage: Value) -> String {
        let mut msg = json!({ "role": "assistant", "stop_reason": "tool_use", "content": [{ "type": "tool_use", "name": name, "input": input }] });
        if !usage.is_null() {
            msg["usage"] = usage;
        }
        line(json!({ "type": "assistant", "message": msg }))
    }
    fn reply(text: &str) -> String {
        line(json!({ "type": "assistant", "message": { "role": "assistant", "stop_reason": "end_turn", "content": [{ "type": "text", "text": text }] } }))
    }
    fn tool_result(is_error: bool, text: &str) -> String {
        line(json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "tool_result", "is_error": is_error, "content": [{ "type": "text", "text": text }] }] } }))
    }
    fn interrupt(text: &str, with_tool_result: bool) -> String {
        let mut content = vec![];
        if with_tool_result {
            content.push(json!({ "type": "tool_result", "is_error": true, "content": "The user doesn't want to proceed with this tool use." }));
        }
        content.push(json!({ "type": "text", "text": text }));
        line(json!({ "type": "user", "message": { "role": "user", "content": content } }))
    }
    fn mode(m: &str) -> String {
        line(json!({ "type": "permission-mode", "permissionMode": m }))
    }

    // The folder lives as long as the session using it.
    fn transcript(lines: &[String]) -> (tempfile::TempDir, Session) {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(format!("{UUID}.jsonl"));
        fs::write(&file, lines.concat()).unwrap();
        (dir, Session::new(&file))
    }
    fn append(file: &Path, text: &[u8]) {
        use std::io::Write;
        fs::OpenOptions::new().append(true).open(file).unwrap().write_all(text).unwrap();
    }
    fn texts(s: &Session) -> Vec<&str> {
        s.events.iter().map(|e| e.text.as_str()).collect()
    }
    fn kinds(s: &Session) -> Vec<(&str, &str)> {
        s.events.iter().map(|e| (e.kind, e.text.as_str())).collect()
    }
    fn ago(ms: f64) -> f64 {
        now_ms() - ms
    }

    #[test]
    fn a_session_that_just_asked_for_a_tool_is_working_on_it() {
        let (_d, mut s) = transcript(&[user("sistema il bug"), tool_use("Bash", json!({ "command": "npm test" }))]);
        s.read().unwrap();
        assert_eq!(s.status(), ("working", "Esegue Bash".into()));
        assert_eq!(kinds(&s), [("user", "sistema il bug"), ("tool", "npm test")]);
    }

    #[test]
    fn a_session_that_replied_waits_for_input() {
        let (_d, mut s) = transcript(&[user("ciao"), reply("Fatto.")]);
        s.read().unwrap();
        assert_eq!(s.status().0, "waiting");
    }

    #[test]
    fn a_tool_without_result_for_over_15s_reads_as_a_permission_prompt() {
        let (_d, mut s) = transcript(&[tool_use("Edit", json!({ "file_path": "/x.js" }))]);
        s.read().unwrap();
        s.mtime = ago(20000.0);
        assert_eq!(s.status(), ("blocked", "Attende permesso: Edit".into()));
    }

    #[test]
    fn a_session_still_for_over_10_minutes_is_idle() {
        let (_d, mut s) = transcript(&[reply("ok")]);
        s.read().unwrap();
        s.mtime = ago(11.0 * 60.0 * 1000.0);
        assert_eq!(s.status().0, "idle");
    }

    #[test]
    fn the_title_prefers_agent_name_then_ai_title_then_first_prompt() {
        let (_d, mut s) = transcript(&[user("primo messaggio"), line(json!({ "type": "ai-title", "aiTitle": "Titolo AI" })), line(json!({ "type": "agent-name", "agentName": "nome-agente" }))]);
        s.read().unwrap();
        assert_eq!(s.to_json(None)["title"], "nome-agente");
    }

    #[test]
    fn reads_only_new_lines_between_reads() {
        let (_d, mut s) = transcript(&[user("uno")]);
        s.read().unwrap();
        append(&s.file, user("due").as_bytes());
        assert!(s.read().unwrap());
        assert!(!s.read().unwrap(), "nothing new → no change");
        assert_eq!(texts(&s), ["uno", "due"]);
    }

    #[test]
    fn accepts_only_uuid_named_session_files_regression() {
        assert!(is_session_file(&format!("{UUID}.jsonl")));
        assert!(!is_session_file("x; touch PWNED.jsonl"));
        assert!(!is_session_file(&format!("{UUID}.jsonl.bak")));
    }

    fn watcher_with(projects: &Path, on_update: impl Fn(Vec<Value>) + Send + Sync + 'static) -> AgentWatcher {
        // No sessions folder: whether a process is open stays unknown, so the real
        // ~/.claude/sessions of whoever runs the tests never leaks in.
        let w = AgentWatcher::new(projects.to_path_buf(), projects.join("no-sessions"), on_update);
        w.start();
        w
    }
    fn watcher(projects: &Path) -> AgentWatcher {
        watcher_with(projects, |_| {})
    }
    type Updates = Arc<Mutex<Vec<Vec<Value>>>>;
    fn recorder() -> (Updates, impl Fn(Vec<Value>) + Send + Sync + 'static) {
        let updates = Updates::default();
        let u = updates.clone();
        (updates, move |list| u.lock().unwrap().push(list))
    }
    fn project(root: &Path, folder: &str, id: &str, content: &str) -> PathBuf {
        let dir = root.join(folder);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join(format!("{id}.jsonl"));
        fs::write(&file, content).unwrap();
        file
    }
    fn set_mtime(w: &AgentWatcher, id: &str, mtime: f64) {
        w.shared.state.lock().unwrap().sessions.values_mut().find(|s| s.id == id).unwrap().mtime = mtime;
    }
    fn ids(list: &[Value]) -> Vec<&str> {
        list.iter().map(|a| a["id"].as_str().unwrap()).collect()
    }
    fn event_texts(w: &AgentWatcher, id: &str) -> Vec<String> {
        w.events(id).into_iter().map(|e| e.text).collect()
    }

    #[test]
    fn the_watcher_ignores_files_with_invalid_names_regression() {
        let root = tempfile::tempdir().unwrap();
        project(root.path(), "-proj-a", UUID, &user("valida"));
        fs::write(root.path().join("-proj-a/x; touch PWNED.jsonl"), user("malevola")).unwrap();
        let w = watcher(root.path());
        assert_eq!(ids(&w.list()), [UUID]);
    }

    #[test]
    fn sessions_older_than_24_hours_leave_the_list_regression() {
        let root = tempfile::tempdir().unwrap();
        let other = "22222222-2222-2222-2222-222222222222";
        project(root.path(), "-proj-b", other, &user("recente"));
        let w = watcher(root.path());
        set_mtime(&w, other, ago(25.0 * 3600.0 * 1000.0));
        assert!(!ids(&w.list()).contains(&other));
    }

    #[test]
    fn sessions_older_than_24_hours_are_dropped_from_memory_regression() {
        let root = tempfile::tempdir().unwrap();
        let other = "33333333-3333-3333-3333-333333333333";
        project(root.path(), "-proj-c", other, &user("recente"));
        let w = watcher(root.path());
        set_mtime(&w, other, ago(25.0 * 3600.0 * 1000.0));
        w.shared.prune();
        assert!(!w.shared.state.lock().unwrap().sessions.values().any(|s| s.id == other));
    }

    #[test]
    fn the_list_sent_to_the_ui_has_no_events_which_are_asked_by_id() {
        let root = tempfile::tempdir().unwrap();
        let id = "44444444-4444-4444-4444-444444444444";
        project(root.path(), "-proj-events", id, &(user("ciao") + &reply("fatto")));
        let w = watcher(root.path());
        let list = w.list();
        let a = list.iter().find(|a| a["id"] == id).unwrap();
        assert!(a.get("events").is_none());
        assert_eq!(a["eventSeq"], 2);
        assert_eq!(event_texts(&w, id), ["ciao", "fatto"]);
        assert!(w.events("sconosciuto").is_empty());
    }

    #[test]
    fn the_event_counter_keeps_growing_past_the_limit_of_60() {
        let lines: Vec<String> = (0..70).map(|i| user(&format!("messaggio {i}"))).collect();
        let (_d, mut s) = transcript(&lines);
        s.read().unwrap();
        assert_eq!(s.events.len(), 60);
        assert_eq!(s.to_json(None)["eventSeq"], 70);
    }

    #[test]
    fn with_the_same_id_in_two_folders_events_come_from_the_most_recent() {
        let root = tempfile::tempdir().unwrap();
        let id = "55555555-5555-5555-5555-555555555555";
        project(root.path(), "-proj-old", id, &user("vecchia"));
        project(root.path(), "-proj-new", id, &user("nuova"));
        let w = watcher(root.path());
        w.shared.state.lock().unwrap().sessions.values_mut().find(|s| s.id == id && s.events[0].text == "vecchia").unwrap().mtime = ago(3600.0 * 1000.0);
        assert_eq!(event_texts(&w, id), ["nuova"]);
    }

    #[test]
    fn a_tool_summary_shows_the_most_useful_input_field() {
        let (_d, mut s) = transcript(&[
            tool_use("Read", json!({ "file_path": "/src/a.js", "limit": 10 })),
            tool_use("Grep", json!({ "pattern": "TODO", "path": "." })),
            tool_use("Custom", json!({ "x": 1 })),
            tool_use("Empty", json!({})),
        ]);
        s.read().unwrap();
        let got: Vec<(&str, &str)> = s.events.iter().map(|e| (e.tool.as_deref().unwrap(), e.text.as_str())).collect();
        assert_eq!(got, [("Read", "/src/a.js"), ("Grep", "TODO"), ("Custom", r#"{"x":1}"#), ("Empty", "")]);
    }

    #[test]
    fn a_failed_tool_becomes_an_error_event_a_successful_one_does_not() {
        let (_d, mut s) = transcript(&[tool_use("Bash", json!({ "command": "ls" })), tool_result(true, "permesso negato"), tool_result(false, "ok")]);
        s.read().unwrap();
        assert_eq!(kinds(&s), [("tool", "ls"), ("error", "permesso negato")]);
        assert_eq!(s.status().1, "Sta ragionando…", "a tool result means the model is thinking again");
    }

    #[test]
    fn system_reminders_and_subagent_messages_stay_out_of_the_timeline() {
        let (_d, mut s) = transcript(&[
            user("<system-reminder>ignora</system-reminder>"),
            line(json!({ "type": "user", "isSidechain": true, "message": { "role": "user", "content": "dal sotto-agente" } })),
            user("vero messaggio"),
        ]);
        s.read().unwrap();
        assert_eq!(texts(&s), ["vero messaggio"]);
        assert_eq!(s.to_json(None)["title"], "vero messaggio");
    }

    #[test]
    fn context_tokens_sum_input_cache_and_output_of_the_last_reply() {
        let usage = json!({ "input_tokens": 10, "cache_read_input_tokens": 1000, "cache_creation_input_tokens": 200, "output_tokens": 5 });
        let (_d, mut s) = transcript(&[tool_call("Bash", json!({ "command": "x" }), usage)]);
        s.read().unwrap();
        assert_eq!(s.to_json(None)["tokens"], json!(1215));
    }

    #[test]
    fn the_state_goes_to_permission_after_15s_on_a_tool_and_idle_after_10_minutes() {
        let (_d, mut s) = transcript(&[tool_use("Bash", json!({ "command": "rm -rf build" }))]);
        s.read().unwrap();
        s.mtime = ago(16.0 * 1000.0);
        assert_eq!(s.status(), ("blocked", "Attende permesso: Bash".into()));
        s.mtime = ago(11.0 * 60.0 * 1000.0);
        assert_eq!(s.status().0, "idle");
    }

    #[test]
    fn a_transcript_rewritten_from_scratch_drops_the_previous_half_line_regression() {
        let (_d, mut s) = transcript(&[user("primo"), r#"{"type":"user","message":{"role":"user","content":"a metà"#.into()]);
        s.read().unwrap();
        fs::write(&s.file, user("nuovo inizio")).unwrap(); // shorter than before: rewritten from scratch
        s.read().unwrap();
        assert_eq!(texts(&s), ["primo", "nuovo inizio"]);
    }

    #[test]
    fn a_burst_of_writes_gives_one_update_with_all_messages() {
        let root = tempfile::tempdir().unwrap();
        let id = "77777777-7777-7777-7777-777777777777";
        let file = project(root.path(), "-proj-live", id, &user("inizio"));
        let (updates, cb) = recorder();
        let w = watcher_with(root.path(), cb);
        sleep(Duration::from_millis(150));
        updates.lock().unwrap().clear();
        for text in ["uno", "due", "tre"] {
            append(&file, user(text).as_bytes()); // streaming reply
        }
        sleep(Duration::from_millis(700));
        let updates = updates.lock().unwrap();
        assert_eq!(updates.len(), 1, "writes within 250 ms are coalesced");
        assert_eq!(updates[0].iter().find(|a| a["id"] == id).unwrap()["eventSeq"], 4);
        assert_eq!(event_texts(&w, id), ["inizio", "uno", "due", "tre"]);
    }

    #[test]
    fn no_updates_after_stop_not_even_from_writes_just_made_regression() {
        let root = tempfile::tempdir().unwrap();
        let file = project(root.path(), "-proj-stop", "88888888-8888-8888-8888-888888888888", &user("inizio"));
        let (updates, cb) = recorder();
        let w = watcher_with(root.path(), cb);
        sleep(Duration::from_millis(150));
        updates.lock().unwrap().clear();
        append(&file, user("ultima").as_bytes());
        sleep(Duration::from_millis(100)); // the write is seen, its flush is pending
        w.stop();
        sleep(Duration::from_millis(500));
        assert_eq!(updates.lock().unwrap().len(), 0);
    }

    #[test]
    fn a_session_in_a_new_project_folder_shows_up_without_further_writes_regression() {
        let root = tempfile::tempdir().unwrap();
        let (updates, cb) = recorder();
        let w = watcher_with(root.path(), cb);
        sleep(Duration::from_millis(150));
        let id = "99999999-9999-9999-9999-999999999999";
        project(root.path(), "-proj-nuovo", id, &user("prima riga"));
        sleep(Duration::from_millis(800));
        assert!(ids(&w.list()).contains(&id), "listed");
        assert!(updates.lock().unwrap().iter().any(|l| ids(l).contains(&id)), "and sent to the UI");
    }

    #[test]
    fn a_session_whose_file_is_deleted_leaves_the_list_regression() {
        let root = tempfile::tempdir().unwrap();
        let id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        let file = project(root.path(), "-proj-del", id, &user("da cancellare"));
        let (updates, cb) = recorder();
        let w = watcher_with(root.path(), cb);
        assert!(ids(&w.list()).contains(&id));
        fs::remove_file(&file).unwrap();
        sleep(Duration::from_millis(700));
        assert!(!ids(&w.list()).contains(&id), "gone from the list");
        assert!(!ids(updates.lock().unwrap().last().unwrap()).contains(&id), "and the UI was told");
    }

    #[test]
    fn after_an_interruption_the_agent_waits_for_input_regression() {
        let (_d, mut s) = transcript(&[user("fai il deploy"), reply("Inizio…"), interrupt("[Request interrupted by user]", false)]);
        s.read().unwrap();
        assert_eq!(s.status().0, "waiting");
        assert_eq!(texts(&s), ["fai il deploy", "Inizio…"], "the marker is not shown as your message");
    }

    #[test]
    fn an_interruption_during_a_tool_also_leaves_the_agent_waiting_regression() {
        let (_d, mut s) = transcript(&[user("pulisci"), tool_use("Bash", json!({ "command": "rm -rf dist" })), interrupt("[Request interrupted by user for tool use]", true)]);
        s.read().unwrap();
        assert_eq!(s.status().0, "waiting");
    }

    #[test]
    fn an_accented_character_split_between_reads_arrives_whole_regression() {
        let (_d, mut s) = transcript(&[]);
        let bytes = user("perché è così").into_bytes();
        let cut = bytes.windows(2).position(|w| w == "è".as_bytes()).unwrap() + 1; // in the middle of the two bytes of "è"
        fs::write(&s.file, &bytes[..cut]).unwrap();
        s.read().unwrap();
        append(&s.file, &bytes[cut..]);
        s.read().unwrap();
        assert_eq!(texts(&s), ["perché è così"]);
    }

    #[test]
    fn in_bypass_mode_a_long_tool_stays_working_regression() {
        let (_d, mut s) = transcript(&[mode("bypassPermissions"), user("lancia i test"), tool_use("Bash", json!({ "command": "npm test" }))]);
        s.read().unwrap();
        s.mtime = ago(60000.0);
        assert_eq!(s.status(), ("working", "Esegue Bash".into()));
        // Switching back to a mode with prompts brings the permission reading back.
        append(&s.file, (mode("default") + &tool_use("Edit", json!({ "file_path": "/x.js" }))).as_bytes());
        s.read().unwrap();
        s.mtime = ago(20000.0);
        assert_eq!(s.status(), ("blocked", "Attende permesso: Edit".into()));
    }

    #[test]
    fn bypass_mode_is_found_before_the_last_256_kb_of_a_long_transcript_regression() {
        let filler = reply(&"x".repeat(300)).repeat(1200); // ~400 KB of an autonomous run
        let (_d, mut s) = transcript(&[mode("bypassPermissions"), user("fai tutto"), filler, tool_use("Bash", json!({ "command": "npm run build" }))]);
        s.read().unwrap();
        s.mtime = ago(60000.0);
        assert_eq!(s.status(), ("working", "Esegue Bash".into()));
    }

    #[test]
    fn clipped_titles_and_texts_never_split_an_emoji_regression() {
        let prompt = format!("{}🚀 e poi altro testo", "a".repeat(79));
        let (_d, mut s) = transcript(&[user(&prompt), tool_use("Bash", json!({ "command": format!("{}✅ fine", "b".repeat(299)) }))]);
        s.read().unwrap();
        // A Rust string can't hold a lone surrogate: check the cut is the one JS makes.
        assert_eq!(s.to_json(None)["title"], "a".repeat(79));
        assert_eq!(s.events.last().unwrap().text, format!("{}✅", "b".repeat(299)));
    }

    #[test]
    fn a_session_whose_process_is_closed_is_neither_working_nor_waiting() {
        let (_d, mut s) = transcript(&[user("ciao"), reply("Fatto.")]);
        s.read().unwrap();
        assert_eq!(s.to_json(Some(true))["status"]["state"], "waiting");
        assert_eq!(s.to_json(Some(true))["live"], true);
        assert_eq!(s.to_json(Some(false))["status"], json!({ "state": "idle", "label": "Chiusa" }));
        assert_eq!(s.to_json(Some(false))["live"], false);
        assert_eq!(s.to_json(None)["status"]["state"], "waiting", "unknown (older Claude Code): the transcript decides");
    }

    #[test]
    fn a_folder_has_conversations_to_continue_only_if_claude_code_saved_some() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        let dir = p.join("-home-u-my-app-v1-2");
        fs::create_dir_all(&dir).unwrap();
        let has = |d: Value| has_history(p, &d);
        assert!(!has(json!("/home/u/my.app/v1_2")), "folder without transcripts");
        fs::write(dir.join("note.txt"), "x").unwrap();
        assert!(!has(json!("/home/u/my.app/v1_2")), "only session transcripts count");
        fs::write(dir.join(format!("{UUID}.jsonl")), user("ciao")).unwrap();
        assert!(has(json!("/home/u/my.app/v1_2")), "every non-alphanumeric character becomes \"-\"");
        assert!(!has(json!("/home/u/altro")));
        assert!(!has(json!("relativo")));
        assert!(!has(Value::Null));
    }

    #[test]
    fn the_list_and_events_json_have_the_js_shape() {
        let (_d, mut s) = transcript(&[user("ciao"), tool_use("Bash", json!({ "command": "ls" }))]);
        s.read().unwrap();
        let v = s.to_json(None);
        let keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, ["id", "cwd", "project", "title", "mtime", "tokens", "status", "live", "eventSeq"]);
        assert_eq!(v["project"], "proj");
        assert_eq!(serde_json::to_value(&s.events[0]).unwrap(), json!({ "ts": 1790683200000i64, "kind": "user", "text": "ciao" }));
        assert_eq!(serde_json::to_value(&s.events[1]).unwrap(), json!({ "ts": 1790683200000i64, "kind": "tool", "text": "ls", "tool": "Bash" }));
        assert_eq!(parse_ts("2026-09-29T14:24:21.96+02:00"), Some(1790684661960));
        assert_eq!(parse_ts("ieri"), None);
    }

    #[test]
    fn available_lists_only_installed_and_safe_commands() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let got = rt.block_on(available(vec!["sh".into(), "no-such-cmd-xyz".into(), "sh;id".into(), "$(id)".into()]));
        assert_eq!(got, ["sh"]);
    }
}

// ── Tauri commands ───────────────────────────────────────────
#[tauri::command]
pub fn agents_list(w: tauri::State<AgentWatcher>) -> Vec<Value> {
    w.list()
}

#[tauri::command]
pub fn agents_events(w: tauri::State<AgentWatcher>, id: Value) -> Vec<Event> {
    id.as_str().map(|id| w.events(id)).unwrap_or_default()
}

#[tauri::command]
pub fn agents_has_history(dir: Value) -> bool {
    has_history(&projects_dir(), &dir)
}

// Only a session id crosses IPC: the pid comes from Claude Code's own record.
#[tauri::command]
pub async fn agents_stop(w: tauri::State<'_, AgentWatcher>, id: Value) -> Result<(), String> {
    let Value::String(id) = id else { return Err("ID di sessione non valido".into()) };
    let dir = crate::claudeprocs::sessions_dir();
    tauri::async_runtime::spawn_blocking(move || crate::claudeprocs::stop(&dir, &id, 3000)).await.map_err(|e| e.to_string())??;
    w.emit();
    Ok(())
}

// Which agent CLIs are installed, resolved through a login shell so
// nvm / ~/.local/bin paths are found like in a normal terminal.
#[tauri::command]
pub async fn agents_available(commands: Vec<String>) -> Vec<String> {
    available(commands).await
}
