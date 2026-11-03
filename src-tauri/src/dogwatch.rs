// Dogwatch: finds the agent windows of a project's tmux session that wait for
// input and relays the PM's answers. The same job as scripts/tmux-dogwatch.py,
// built into Work: a watcher thread, two IPC commands and an event.
use crate::{store, tmux};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const POLL: Duration = Duration::from_secs(3);
const SCAN_LINES: &str = "-30";
const TAIL_LINES: usize = 12;
const ESCALATION_FILE: &str = ".claude/escalation_to_pm.json";
const STATE_FILE: &str = ".claude/dogwatch_state.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PromptType {
    Permission,
    Confirmation,
    Selection,
    Question,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentState {
    Working,
    Blocked,
    Idle,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Prompt {
    pub prompt_type: PromptType,
    pub question: String,
    pub options: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WindowState {
    pub id: String,
    pub name: String,
    pub prompt: Option<Prompt>,
    pub agent: Option<String>,
    pub state: AgentState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Pending {
    pub target: String,
    #[serde(flatten)]
    pub prompt: Prompt,
}

#[derive(Debug, Serialize)]
pub struct Inspection {
    pub session: String,
    pub windows: Vec<WindowState>,
}

impl Inspection {
    pub fn pending(&self) -> Vec<Pending> {
        self.windows
            .iter()
            // The PM is the one who answers escalations: its prompts are shown
            // in the team panel but never written back to the escalation file.
            .filter(|w| !w.name.eq_ignore_ascii_case("pm"))
            .filter_map(|w| {
                Some(Pending {
                    target: w.name.clone(),
                    prompt: w.prompt.clone()?,
                })
            })
            .collect()
    }
}

// ── Declarative agent manifests ──────────────────────────────
//
// Status detection is data, not code: each supported CLI has a TOML manifest
// under detect/manifests/. Rules are evaluated from the highest priority down
// and the first match wins, so a permission prompt always beats a spinner.

#[derive(Debug, Deserialize)]
struct ManifestSource {
    id: String,
    #[serde(default)]
    aliases: Vec<String>,
    version: u32,
    #[serde(default)]
    rules: Vec<RuleSource>,
}

#[derive(Debug, Deserialize)]
struct RuleSource {
    id: String,
    state: AgentState,
    priority: i32,
    region: String,
    #[serde(default)]
    prompt_type: Option<PromptType>,
    #[serde(default)]
    predicates: PredicatesSource,
}

#[derive(Debug, Default, Deserialize)]
struct PredicatesSource {
    #[serde(default)]
    contains: Vec<String>,
    #[serde(default)]
    regex: Vec<String>,
    #[serde(default)]
    line_regex: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Region {
    WholeRecent,
    BottomNonEmptyLines(usize),
    LastNonEmptyLine,
    PromptBlock,
}

#[derive(Debug)]
struct Rule {
    id: String,
    state: AgentState,
    priority: i32,
    region: Region,
    prompt_type: Option<PromptType>,
    contains: Vec<String>,
    regexes: Vec<Regex>,
    line_regexes: Vec<Regex>,
}

#[derive(Debug)]
pub struct AgentManifest {
    pub id: String,
    pub version: u32,
    aliases: Vec<String>,
    rules: Vec<Rule>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Classification {
    pub agent: Option<String>,
    pub state: AgentState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip)]
    prompt_type: Option<PromptType>,
}

#[derive(Debug, Serialize)]
pub struct Explanation {
    pub session: String,
    pub window: String,
    pub agent: Option<String>,
    pub version: Option<u32>,
    pub state: AgentState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

fn parse_region(raw: &str) -> Region {
    let raw = raw.trim();
    if raw == "prompt_block" {
        return Region::PromptBlock;
    }
    if raw == "last_non_empty_line" {
        return Region::LastNonEmptyLine;
    }
    if let Some(n) = raw
        .strip_prefix("bottom_non_empty_lines(")
        .and_then(|r| r.strip_suffix(')'))
        .and_then(|n| n.trim().parse::<usize>().ok())
    {
        return Region::BottomNonEmptyLines(n.clamp(1, 200));
    }
    Region::WholeRecent
}

fn compile_regex(pattern: &str) -> Result<Regex, String> {
    RegexBuilder::new(pattern)
        .case_insensitive(true)
        .build()
        .map_err(|e| format!("regex {pattern:?}: {e}"))
}

impl AgentManifest {
    fn parse(source: &str) -> Result<Self, String> {
        let manifest: ManifestSource = toml::from_str(source).map_err(|e| format!("TOML: {e}"))?;
        if manifest.id.trim().is_empty() {
            return Err("manifest id is empty".into());
        }
        let mut rules = Vec::with_capacity(manifest.rules.len());
        for rule in manifest.rules {
            if rule.id.trim().is_empty() {
                return Err(format!("{}: rule id is empty", manifest.id));
            }
            if rule.predicates.contains.is_empty()
                && rule.predicates.regex.is_empty()
                && rule.predicates.line_regex.is_empty()
            {
                return Err(format!(
                    "{}: rule {} has no predicates",
                    manifest.id, rule.id
                ));
            }
            let regexes = rule
                .predicates
                .regex
                .iter()
                .map(|p| compile_regex(p))
                .collect::<Result<Vec<_>, _>>()?;
            let line_regexes = rule
                .predicates
                .line_regex
                .iter()
                .map(|p| compile_regex(p))
                .collect::<Result<Vec<_>, _>>()?;
            rules.push(Rule {
                id: rule.id,
                state: rule.state,
                priority: rule.priority,
                region: parse_region(&rule.region),
                prompt_type: rule.prompt_type,
                contains: rule
                    .predicates
                    .contains
                    .into_iter()
                    .map(|s| s.to_lowercase())
                    .collect(),
                regexes,
                line_regexes,
            });
        }
        Ok(Self {
            id: manifest.id,
            version: manifest.version,
            aliases: manifest
                .aliases
                .into_iter()
                .map(|a| a.to_lowercase())
                .collect(),
            rules,
        })
    }
}

pub struct ManifestEngine {
    manifests: Vec<AgentManifest>,
}

const MANIFEST_SOURCES: &[&str] = &[
    include_str!("../detect/manifests/antigravity.toml"),
    include_str!("../detect/manifests/claude.toml"),
    include_str!("../detect/manifests/opencode.toml"),
    include_str!("../detect/manifests/codex.toml"),
    include_str!("../detect/manifests/gemini.toml"),
    include_str!("../detect/manifests/generic.toml"),
];

impl ManifestEngine {
    pub fn builtin() -> Self {
        Self::from_sources(MANIFEST_SOURCES).expect("built-in agent manifests are valid")
    }

    fn from_sources(sources: &[&str]) -> Result<Self, String> {
        let manifests = sources
            .iter()
            .map(|s| AgentManifest::parse(s))
            .collect::<Result<Vec<_>, _>>()?;
        if manifests.is_empty() {
            return Err("no agent manifests".into());
        }
        Ok(Self { manifests })
    }

    pub fn manifest(&self, id: &str) -> Option<&AgentManifest> {
        self.manifests.iter().find(|m| m.id == id)
    }

    fn generic(&self) -> &AgentManifest {
        self.manifest("generic")
            .unwrap_or_else(|| self.manifests.last().expect("at least one manifest"))
    }

    // The window's command is the strongest hint; the tmux window name (the
    // team role: pm, dev1, qa1…) is the fallback when no command is visible.
    pub fn detect_agent(&self, name: &str, command: &str) -> &AgentManifest {
        let command = command.to_lowercase();
        let role = name.to_lowercase();
        let specific = self.manifests.iter().filter(|m| m.id != "generic");
        for manifest in specific.clone() {
            if manifest
                .aliases
                .iter()
                .any(|alias| command_has_alias(&command, alias))
            {
                return manifest;
            }
        }
        for manifest in specific {
            if manifest
                .aliases
                .iter()
                .any(|alias| alias_matches_role(alias, &role))
            {
                return manifest;
            }
        }
        self.generic()
    }

    fn manifest_for_hint(&self, hint: Option<&str>) -> &AgentManifest {
        let Some(hint) = hint else {
            return self.generic();
        };
        let hint = hint.to_lowercase();
        self.manifests
            .iter()
            .find(|m| m.id == hint || m.aliases.contains(&hint))
            .unwrap_or_else(|| self.generic())
    }

    pub fn classify(&self, manifest: &AgentManifest, capture: &str) -> Classification {
        let mut rules: Vec<&Rule> = manifest.rules.iter().collect();
        rules.sort_by_key(|r| std::cmp::Reverse(r.priority));
        for rule in rules {
            if let Some(reason) = rule.matches(capture) {
                return Classification {
                    agent: Some(manifest.id.clone()),
                    state: rule.state,
                    rule: Some(rule.id.clone()),
                    reason: Some(reason),
                    prompt_type: rule.prompt_type,
                };
            }
        }
        Classification {
            agent: Some(manifest.id.clone()),
            state: AgentState::Idle,
            rule: None,
            reason: None,
            prompt_type: None,
        }
    }

    fn classify_hint(&self, hint: Option<&str>, capture: &str) -> Classification {
        self.classify(self.manifest_for_hint(hint), capture)
    }
}

fn command_has_alias(command: &str, alias: &str) -> bool {
    command
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.'))
        .any(|token| token == alias)
}

fn alias_matches_role(alias: &str, role: &str) -> bool {
    role == alias
        || role
            .strip_prefix(alias)
            .is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()))
}

impl Rule {
    fn matches(&self, capture: &str) -> Option<String> {
        let text = take_region(&self.region, capture);
        if text.trim().is_empty() {
            return None;
        }
        let lower = text.to_lowercase();
        for needle in &self.contains {
            if lower.contains(needle) {
                return Some(format!("contains {needle:?}"));
            }
        }
        for regex in &self.regexes {
            if let Some(m) = regex.find(&text) {
                return Some(format!(
                    "regex {:?} matched {:?}",
                    regex.as_str(),
                    m.as_str()
                ));
            }
        }
        for regex in &self.line_regexes {
            for line in text.lines() {
                if let Some(m) = regex.find(line) {
                    return Some(format!(
                        "line_regex {:?} matched {:?}",
                        regex.as_str(),
                        m.as_str()
                    ));
                }
            }
        }
        None
    }
}

fn take_region(region: &Region, capture: &str) -> String {
    match region {
        // capture-pane already reads a bounded recent window (-30 lines).
        Region::WholeRecent => capture.to_string(),
        Region::BottomNonEmptyLines(n) => {
            let lines: Vec<&str> = capture
                .lines()
                .filter(|line| !line.trim().is_empty())
                .collect();
            lines[lines.len().saturating_sub(*n)..].join("\n")
        }
        Region::LastNonEmptyLine => capture
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("")
            .to_string(),
        Region::PromptBlock => prompt_block(capture),
    }
}

// The question plus only its own options and hints: any later content means
// the prompt was answered and is now history.
fn prompt_block(capture: &str) -> String {
    let lines: Vec<&str> = capture
        .lines()
        .map(trim_box)
        .filter(|line| !line.is_empty())
        .collect();
    let Some(_) = lines.last() else {
        return String::new();
    };
    let tail = &lines[lines.len().saturating_sub(TAIL_LINES)..];
    let from = tail.iter().rposition(|line| !is_chrome(line)).unwrap_or(0);
    tail[from..].join("\n")
}

fn prompt_from(classification: &Classification, capture: &str) -> Option<Prompt> {
    if classification.state != AgentState::Blocked {
        return None;
    }
    let prompt_type = classification.prompt_type?;
    let block_text = prompt_block(capture);
    let block: Vec<&str> = block_text.lines().collect();
    if block.is_empty() {
        return None;
    }
    Some(Prompt {
        prompt_type,
        question: question_of(&block),
        options: options_of(&block),
    })
}

fn engine() -> &'static ManifestEngine {
    static ENGINE: OnceLock<ManifestEngine> = OnceLock::new();
    ENGINE.get_or_init(ManifestEngine::builtin)
}

// ── Prompt parser ────────────────────────────────────────────

// dev1, qa, qa2, agent3, doc1, generico: the windows of the team. The PM is
// watched for its status too, but pending() keeps its prompts out of escalation.
pub fn is_agent_window(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    let digits = |rest: &str| rest.chars().all(|c| c.is_ascii_digit());
    name == "pm"
        || name == "generico"
        || name.strip_prefix("qa").is_some_and(digits)
        || name.strip_prefix("doc").is_some_and(digits)
        || name
            .strip_prefix("dev")
            .or(name.strip_prefix("agent"))
            .is_some_and(|r| !r.is_empty() && digits(r))
}

fn trim_box(line: &str) -> &str {
    line.trim_matches(|c: char| c.is_whitespace() || c == '│')
}

// "2. No", "❯ 1) Yes": the option text, and whether the cursor is on it.
fn numbered_option(line: &str) -> Option<(&str, bool)> {
    let line = trim_box(line);
    let (cursor, rest) = match line.strip_prefix(['❯', '>']) {
        Some(rest) => (true, rest.trim_start()),
        None => (false, line),
    };
    let digits = rest.chars().take_while(char::is_ascii_digit).count();
    let text = rest[digits..].strip_prefix(['.', ')'])?;
    let text = text.strip_prefix(char::is_whitespace)?.trim();
    (digits > 0 && !text.is_empty()).then_some((text, cursor))
}

// "[y/N]" or "(optional)" alone on a line.
fn bare_flag(line: &str) -> bool {
    let line = trim_box(line);
    [('[', ']'), ('(', ')')].iter().any(|&(open, close)| {
        line.strip_prefix(open)
            .and_then(|r| r.strip_suffix(close))
            .is_some_and(|inner| !inner.is_empty() && !inner.contains(close))
    })
}

// What a prompt keeps drawn around its question: options, key hints, borders.
fn is_chrome(line: &str) -> bool {
    let lower = trim_box(line).to_lowercase();
    let hint = [
        "esc to ",
        "enter to ",
        "tab to ",
        "ctrl+c to ",
        "ctrl-c to ",
    ];
    numbered_option(line).is_some()
        || bare_flag(line)
        || lower.chars().all(|c| "╭╰╮╯─┌└┐┘".contains(c))
        || hint.iter().any(|h| lower.contains(h))
}

fn has_yes_no(lower: &str) -> bool {
    ["[y/n]", "(y/n)", "yes/no", "yes / no"]
        .iter()
        .any(|p| lower.contains(p))
}

fn options_of(block: &[&str]) -> Vec<String> {
    let mut options: Vec<String> = Vec::new();
    for (text, _) in block.iter().filter_map(|l| numbered_option(l)) {
        if !options.iter().any(|o| o == text) {
            options.push(text.to_string());
        }
    }
    if options.is_empty() && has_yes_no(&block.join("\n").to_lowercase()) {
        return vec!["Yes".into(), "No".into()];
    }
    options
}

fn question_of(block: &[&str]) -> String {
    let line = block
        .iter()
        .rev()
        .find(|l| !is_chrome(l))
        .or(block.last())
        .copied()
        .unwrap_or_default();
    trim_box(line).to_string()
}

// A prompt counts only while nothing but its own options and key hints
// follows it: any other later line means the agent went on, and the old
// question is just history (commit logs quote "Do you want to proceed?").
// The patterns themselves come from the agent's TOML manifest.
fn parse_prompt_for(agent: Option<&str>, capture: &str) -> Option<Prompt> {
    let classification = engine().classify_hint(agent, capture);
    prompt_from(&classification, capture)
}

pub fn parse_prompt(capture: &str) -> Option<Prompt> {
    parse_prompt_for(None, capture)
}

// ── Inspection and answers ───────────────────────────────────

// -J joins the lines the terminal wrapped, so a long question stays whole.
fn capture(session: &str, window_id: &str) -> Option<String> {
    let target = format!("{session}:{window_id}");
    tmux::run_tmux(&["capture-pane", "-p", "-J", "-t", &target, "-S", SCAN_LINES]).ok()
}

// What the pane runs (the start command for team windows, the foreground
// process for an agent started by hand) plus its title: the manifest hint.
fn window_command(session: &str, window_id: &str) -> String {
    let target = format!("{session}:{window_id}");
    tmux::run_tmux(&[
        "display-message",
        "-p",
        "-t",
        &target,
        "#{pane_start_command}\t#{pane_current_command}\t#{pane_title}",
    ])
    .unwrap_or_default()
}

pub fn inspect(session: &str) -> Result<Inspection, String> {
    let engine = engine();
    let windows = tmux::list_windows(session)?
        .into_iter()
        .filter(|w| is_agent_window(&w.name))
        .map(|w| {
            let manifest = engine.detect_agent(&w.name, &window_command(session, &w.id));
            let captured = capture(session, &w.id);
            let classification = match captured.as_deref() {
                Some(text) => engine.classify(manifest, text),
                None => Classification {
                    agent: Some(manifest.id.clone()),
                    state: AgentState::Idle,
                    rule: None,
                    reason: None,
                    prompt_type: None,
                },
            };
            let prompt = captured
                .as_deref()
                .and_then(|text| prompt_from(&classification, text));
            WindowState {
                prompt,
                id: w.id,
                name: w.name,
                agent: Some(manifest.id.clone()),
                state: classification.state,
                rule: classification.rule,
            }
        })
        .collect();
    Ok(Inspection {
        session: session.to_string(),
        windows,
    })
}

// The text is typed literally (-l): "Enter" in an answer must not press a key.
pub fn answer(session: &str, window: &str, text: &str) -> Result<(), String> {
    let target = format!("{session}:{window}");
    if !text.is_empty() {
        tmux::run_tmux(&["send-keys", "-t", &target, "-l", "--", text])?;
    }
    tmux::run_tmux(&["send-keys", "-t", &target, "Enter"])?;
    Ok(())
}

// ── Escalation file ──────────────────────────────────────────

pub(crate) fn now_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::gmtime_r(&secs, &mut tm) };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec
    )
}

// The same file scripts/tmux-dogwatch.py writes, for the PM to read.
fn write_escalation(root: &Path, pending: &[Pending]) -> std::io::Result<()> {
    let stamp = now_iso();
    let entries: Vec<_> = pending
        .iter()
        .map(|p| {
            let mut entry = serde_json::to_value(p).unwrap_or_default();
            entry["timestamp"] = stamp.clone().into();
            entry
        })
        .collect();
    store::save(
        &root.join(ESCALATION_FILE),
        &serde_json::json!({ "updated_at": stamp, "pending": entries }),
    )
}

// Shared status snapshot read by scripts/work-agent.py: one entry per agent
// window with the manifest-decided state. Kept next to the escalation file.
fn write_window_state(
    root: &Path,
    session: &str,
    live: bool,
    windows: &[WindowState],
) -> std::io::Result<()> {
    store::save(
        &root.join(STATE_FILE),
        &serde_json::json!({
            "updated_at": now_iso(),
            "session": session,
            "live": live,
            "windows": windows,
        }),
    )
}

// ── Watcher ──────────────────────────────────────────────────

type Seen = HashMap<String, (bool, Vec<Pending>, String)>;

fn state_signature(windows: &[WindowState]) -> String {
    windows
        .iter()
        .map(|w| {
            format!(
                "{}:{}:{}:{}",
                w.name,
                serde_json::to_string(&w.state).unwrap_or_default(),
                w.rule.as_deref().unwrap_or(""),
                w.agent.as_deref().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("|")
}

// True when this project's session state (live or not), pending list or the
// agent states differ from the last look. The first look at a project always
// counts, even if empty: a stale escalation file must be cleared then.
fn changed_full(
    seen: &mut Seen,
    project: &str,
    live: bool,
    now: Vec<Pending>,
    states: String,
) -> bool {
    let state = (live, now, states);
    seen.insert(project.to_string(), state.clone()).as_ref() != Some(&state)
}

// Pending-only wrapper kept for the watcher tests and for callers that do not
// care about working/idle transitions.
#[cfg(test)]
fn changed(seen: &mut Seen, project: &str, live: bool, now: Vec<Pending>) -> bool {
    changed_full(seen, project, live, now, String::new())
}

// Writes the file when there is something to say, or an old one to clear.
fn refresh_escalation(root: &Path, pending: &[Pending]) {
    if !pending.is_empty() || root.join(ESCALATION_FILE).exists() {
        let _ = write_escalation(root, pending);
    }
}

// Polls the session of every open project. On a change it refreshes the
// escalation file (only if there is something to say, or a stale file to
// clear) and calls on_change(project, session, pending, live, windows); live is
// false when the project has no tmux session to watch. The windows carry the
// real agent detected in each pane, so the renderer can update its badges.
pub fn spawn(
    projects: impl Fn() -> Vec<String> + Send + 'static,
    on_change: impl Fn(&str, &str, &[Pending], bool, &[WindowState]) + Send + 'static,
) {
    if !tmux::is_available() {
        return;
    }
    std::thread::spawn(move || {
        let mut seen = HashMap::new();
        loop {
            for project in projects() {
                let root = Path::new(&project);
                let session = tmux::session_for_project(root);
                let inspection = inspect(&session).ok();
                let live = inspection.is_some();
                let (now, states, windows) = match inspection {
                    Some(inspection) => {
                        let now = inspection.pending();
                        let states = state_signature(&inspection.windows);
                        (now, states, inspection.windows)
                    }
                    None => (Vec::new(), String::new(), Vec::new()),
                };
                if !changed_full(&mut seen, &project, live, now.clone(), states) {
                    continue;
                }
                refresh_escalation(root, &now);
                let _ = write_window_state(root, &session, live, &windows);
                on_change(&project, &session, &now, live, &windows);
            }
            std::thread::sleep(POLL);
        }
    });
}

// ── IPC Commands ─────────────────────────────────────────────

#[tauri::command]
pub fn dogwatch_inspect(session: String) -> Result<Inspection, String> {
    inspect(&session)
}

// Diagnostics: why is this window blocked/working/idle, and which manifest
// rule decided it? The renderer uses it from the agent team panel and tests.
pub fn explain(session: &str, window: &str) -> Result<Explanation, String> {
    let engine = engine();
    let found = tmux::list_windows(session)?
        .into_iter()
        .find(|w| w.id == window || w.name == window)
        .ok_or_else(|| format!("finestra {window} non trovata in {session}"))?;
    let manifest = engine.detect_agent(&found.name, &window_command(session, &found.id));
    let text = capture(session, &found.id)
        .ok_or_else(|| format!("impossibile catturare la finestra {}", found.name))?;
    let classification = engine.classify(manifest, &text);
    Ok(Explanation {
        session: session.to_string(),
        window: found.name,
        agent: classification.agent,
        version: Some(manifest.version),
        state: classification.state,
        rule: classification.rule,
        reason: classification.reason,
    })
}

#[tauri::command]
pub fn dogwatch_explain(session: String, window: String) -> Result<Explanation, String> {
    explain(&session, &window)
}

#[tauri::command]
pub fn dogwatch_answer(session: String, window: String, answer: String) -> Result<(), String> {
    self::answer(&session, &window, &answer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn prompt(capture: &str) -> Prompt {
        parse_prompt(capture).expect("a pending prompt")
    }

    fn classified(agent: &str, capture: &str) -> Classification {
        let engine = ManifestEngine::builtin();
        let manifest = engine.manifest(agent).expect(agent);
        engine.classify(manifest, capture)
    }

    #[test]
    fn every_builtin_manifest_parses_and_is_versioned() {
        let engine = ManifestEngine::builtin();
        for id in [
            "antigravity",
            "claude",
            "opencode",
            "codex",
            "gemini",
            "generic",
        ] {
            let manifest = engine.manifest(id).expect(id);
            assert_eq!(manifest.version, 1, "{id}");
        }
    }

    #[test]
    fn windows_are_matched_to_agents_by_command_then_by_role() {
        let engine = ManifestEngine::builtin();
        assert_eq!(
            engine
                .detect_agent("dev1", "ollama launch opencode --model deepseek")
                .id,
            "opencode"
        );
        assert_eq!(
            engine
                .detect_agent("pm", "agy --dangerously-skip-permissions")
                .id,
            "antigravity"
        );
        assert_eq!(engine.detect_agent("qa1", "codex --yolo").id, "codex");
        // No visible command: the team role name decides.
        assert_eq!(engine.detect_agent("dev2", "bash").id, "opencode");
        assert_eq!(engine.detect_agent("qa2", "bash").id, "codex");
        assert_eq!(engine.detect_agent("agent1", "bash").id, "generic");
    }

    #[test]
    fn manifest_snapshots_classify_real_claude_antigravity_and_opencode_buffers() {
        let claude_blocked = classified(
            "claude",
            include_str!("../detect/fixtures/claude_blocked.txt"),
        );
        assert_eq!(claude_blocked.state, AgentState::Blocked);
        assert_eq!(claude_blocked.rule.as_deref(), Some("claude-permission"));

        let claude_working = classified(
            "claude",
            include_str!("../detect/fixtures/claude_working.txt"),
        );
        assert_eq!(claude_working.state, AgentState::Working);
        assert_eq!(
            claude_working.rule.as_deref(),
            Some("claude-interrupt-hint")
        );

        let antigravity = classified(
            "antigravity",
            include_str!("../detect/fixtures/antigravity_working.txt"),
        );
        assert_eq!(antigravity.state, AgentState::Working);
        assert_eq!(antigravity.rule.as_deref(), Some("antigravity-spinner"));

        let opencode = classified(
            "opencode",
            include_str!("../detect/fixtures/opencode_blocked.txt"),
        );
        assert_eq!(opencode.state, AgentState::Blocked);
        assert_eq!(opencode.rule.as_deref(), Some("opencode-permission"));

        let codex = classified(
            "codex",
            include_str!("../detect/fixtures/codex_blocked.txt"),
        );
        assert_eq!(codex.state, AgentState::Blocked);
        assert_eq!(codex.rule.as_deref(), Some("codex-confirmation"));

        let idle = classified("gemini", include_str!("../detect/fixtures/gemini_idle.txt"));
        assert_eq!(idle.state, AgentState::Idle);
        assert!(idle.rule.is_none());
    }

    #[test]
    fn a_prompt_beats_a_spinner_and_history_does_not_look_blocked() {
        let mixed = "⠋ Working…\nDo you want to proceed?\n❯ 1. Yes\n  2. No\n";
        assert_eq!(classified("claude", mixed).state, AgentState::Blocked);

        let history = "commit abc\n    docs: ask 'Do you want to proceed?'\nnpm test\nall passed\n";
        assert_eq!(classified("claude", history).state, AgentState::Idle);
    }

    #[test]
    fn manifest_prompt_types_still_drive_the_escalation_parser() {
        let p = parse_prompt_for(
            Some("claude"),
            "Do you want to proceed?\n❯ 1. Yes\n  2. No\n",
        )
        .expect("permission");
        assert_eq!(p.prompt_type, PromptType::Permission);
        assert_eq!(p.options, ["Yes", "No"]);

        let q =
            parse_prompt_for(Some("generic"), "Could you clarify which file?\n").expect("question");
        assert_eq!(q.prompt_type, PromptType::Question);
    }

    #[test]
    fn a_numbered_permission_prompt_lists_its_options() {
        let p = prompt("running\nDo you want to proceed?\n❯ 1. Yes\n  2. No\n");
        assert_eq!(p.prompt_type, PromptType::Permission);
        assert_eq!(p.question, "Do you want to proceed?");
        assert_eq!(p.options, ["Yes", "No"]);
    }

    #[test]
    fn a_yes_no_flag_is_a_confirmation_with_yes_and_no() {
        let p = prompt("Continue with the deploy? [y/N]\n");
        assert_eq!(p.prompt_type, PromptType::Confirmation);
        assert_eq!(p.options, ["Yes", "No"]);
    }

    #[test]
    fn a_boxed_prompt_with_key_hints_keeps_the_real_question() {
        let p = prompt(
            "╭────╮\n│ Do you want to proceed? │\n│ ❯ 1. Yes │\n│   2. No │\n╰────╯\n  Esc to cancel\n",
        );
        assert_eq!(p.prompt_type, PromptType::Permission);
        assert_eq!(p.question, "Do you want to proceed?");
        assert_eq!(p.options, ["Yes", "No"]);
    }

    #[test]
    fn a_selection_needs_the_cursor_on_an_option() {
        let p = prompt("Pick one\n❯ 1. alpha\n  2. beta\n");
        assert_eq!(p.prompt_type, PromptType::Selection);
        assert_eq!(p.question, "Pick one");
        assert!(parse_prompt("steps\n1. alpha\n2. beta\n").is_none());
    }

    #[test]
    fn a_last_line_question_is_an_open_question() {
        let p = prompt("working\nCould you clarify which file I should edit?\n");
        assert_eq!(p.prompt_type, PromptType::Question);
        assert_eq!(p.question, "Could you clarify which file I should edit?");
        assert!(p.options.is_empty());
    }

    #[test]
    fn an_answered_prompt_followed_by_output_is_not_pending_regression() {
        assert!(
            parse_prompt("Do you want to proceed? [y/N] n\nANSWER=no\nrunning tests\n").is_none()
        );
        assert!(parse_prompt("Do you want to proceed?\n1. Yes\n2. No\nbuilding\n").is_none());
    }

    #[test]
    fn a_quoted_prompt_in_old_output_is_not_pending_regression() {
        let log = "commit abc\n    docs: ask 'Do you want to proceed?'\nnpm test\nall passed\n";
        assert!(parse_prompt(log).is_none());
        assert!(parse_prompt("").is_none());
        assert!(parse_prompt("\n  \n").is_none());
    }

    #[test]
    fn only_team_windows_are_watched() {
        for name in ["pm", "dev1", "DEV12", "qa", "qa2", "agent3", "doc1", "DOC2", "doc", "generico"] {
            assert!(is_agent_window(name), "{name}");
        }
        for name in ["shell", "dev", "agent", "qatest", "dev1x", "docx", "docs", ""] {
            assert!(!is_agent_window(name), "{name}");
        }
    }

    #[test]
    fn a_pm_prompt_is_shown_but_never_escalated() {
        let prompt = prompt("Continue? [y/N]\n");
        let inspection = Inspection {
            session: "s".into(),
            windows: vec![
                WindowState {
                    id: "@0".into(),
                    name: "pm".into(),
                    prompt: Some(prompt.clone()),
                    agent: Some("antigravity".into()),
                    state: AgentState::Blocked,
                    rule: Some("antigravity-confirmation".into()),
                },
                WindowState {
                    id: "@1".into(),
                    name: "dev1".into(),
                    prompt: Some(prompt),
                    agent: Some("opencode".into()),
                    state: AgentState::Blocked,
                    rule: Some("opencode-confirmation".into()),
                },
            ],
        };
        assert_eq!(
            inspection
                .pending()
                .into_iter()
                .map(|p| p.target)
                .collect::<Vec<_>>(),
            ["dev1"],
            "the PM answers, it is not an escalation target"
        );
    }

    #[test]
    fn a_pending_entry_serializes_flat_like_the_escalation_file() {
        let p = Pending {
            target: "dev1".into(),
            prompt: prompt("Continue? [y/N]\n"),
        };
        let json = serde_json::to_value(&p).unwrap();
        assert_eq!(json["target"], "dev1");
        assert_eq!(json["prompt_type"], "confirmation");
        assert_eq!(json["options"][0], "Yes");
    }

    #[test]
    fn the_escalation_file_mirrors_the_pending_list_and_clears() {
        let dir = tempfile::tempdir().unwrap();
        let pending = vec![Pending {
            target: "qa".into(),
            prompt: prompt("Continue? [y/N]\n"),
        }];
        write_escalation(dir.path(), &pending).unwrap();
        let read = || -> serde_json::Value {
            serde_json::from_str(
                &std::fs::read_to_string(dir.path().join(ESCALATION_FILE)).unwrap(),
            )
            .unwrap()
        };
        assert_eq!(read()["pending"][0]["target"], "qa");
        assert!(read()["pending"][0]["timestamp"].is_string());

        write_escalation(dir.path(), &[]).unwrap();
        assert_eq!(read()["pending"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn the_shared_state_file_lists_every_agent_window_and_its_rule() {
        let dir = tempfile::tempdir().unwrap();
        let windows = vec![
            WindowState {
                id: "@0".into(),
                name: "dev1".into(),
                prompt: Some(prompt("Do you want to proceed? [y/N]\n")),
                agent: Some("opencode".into()),
                state: AgentState::Blocked,
                rule: Some("opencode-permission".into()),
            },
            WindowState {
                id: "@1".into(),
                name: "qa1".into(),
                prompt: None,
                agent: Some("codex".into()),
                state: AgentState::Working,
                rule: Some("codex-spinner".into()),
            },
        ];
        write_window_state(dir.path(), "work_state", true, &windows).unwrap();
        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join(STATE_FILE)).unwrap())
                .unwrap();
        assert_eq!(json["session"], "work_state");
        assert_eq!(json["live"], true);
        assert!(json["updated_at"].is_string());
        assert_eq!(json["windows"][0]["name"], "dev1");
        assert_eq!(json["windows"][0]["state"], "blocked");
        assert_eq!(json["windows"][0]["rule"], "opencode-permission");
        assert_eq!(json["windows"][0]["agent"], "opencode");
        assert_eq!(json["windows"][1]["state"], "working");
        assert_eq!(json["windows"][1]["agent"], "codex");
    }

    #[test]
    fn an_agent_change_alone_is_a_state_change_regression() {
        let window = |agent: &str| {
            vec![WindowState {
                id: "@0".into(),
                name: "qa1".into(),
                prompt: None,
                agent: Some(agent.into()),
                state: AgentState::Working,
                rule: Some("opencode-spinner".into()),
            }]
        };
        assert_ne!(
            state_signature(&window("codex")),
            state_signature(&window("opencode")),
            "the badge must be refreshed when the real agent changes"
        );
    }

    #[test]
    fn only_a_different_pending_list_counts_as_a_change() {
        let mut seen = Seen::new();
        let q = |text: &str| {
            vec![Pending {
                target: "dev1".into(),
                prompt: prompt(text),
            }]
        };
        assert!(
            changed(&mut seen, "/p", true, vec![]),
            "the first look always counts"
        );
        assert!(
            !changed(&mut seen, "/p", true, vec![]),
            "nothing before, nothing now"
        );
        assert!(changed(&mut seen, "/p", true, q("Continue? [y/N]\n")));
        assert!(!changed(&mut seen, "/p", true, q("Continue? [y/N]\n")));
        assert!(
            changed(&mut seen, "/p", true, vec![]),
            "the question went away"
        );
    }

    #[test]
    fn a_session_that_appears_or_goes_away_counts_as_a_change() {
        let mut seen = Seen::new();
        assert!(changed(&mut seen, "/p", false, vec![]));
        assert!(!changed(&mut seen, "/p", false, vec![]));
        assert!(
            changed(&mut seen, "/p", true, vec![]),
            "the session started"
        );
        assert!(changed(&mut seen, "/p", false, vec![]), "the session ended");
    }

    #[test]
    fn a_stale_escalation_file_is_cleared_on_the_first_look_regression() {
        let dir = tempfile::tempdir().unwrap();
        let stale = vec![Pending {
            target: "dev1".into(),
            prompt: prompt("Continue? [y/N]\n"),
        }];
        write_escalation(dir.path(), &stale).unwrap();

        let mut seen = Seen::new();
        let project = dir.path().to_string_lossy().into_owned();
        assert!(
            changed(&mut seen, &project, true, vec![]),
            "the first look reaches the cleanup"
        );
        refresh_escalation(dir.path(), &[]);

        let text = std::fs::read_to_string(dir.path().join(ESCALATION_FILE)).unwrap();
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(json["pending"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn no_file_is_created_when_there_is_nothing_to_say() {
        let dir = tempfile::tempdir().unwrap();
        refresh_escalation(dir.path(), &[]);
        assert!(!dir.path().join(ESCALATION_FILE).exists());
    }

    fn wait_for(what: &str, mut done: impl FnMut() -> bool) {
        let end = Instant::now() + Duration::from_secs(5);
        while !done() {
            assert!(Instant::now() < end, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn inspect_sees_a_blocked_window_and_answer_unblocks_it() {
        if !tmux::is_available() {
            return;
        }
        let session = format!(
            "wsdog_{:x}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        tmux::ensure_session(&session, Path::new("/tmp")).unwrap();
        let script = "printf 'Do you want to proceed? [y/N] '; read a; echo ANSWER=$a; sleep 30";
        tmux::new_window(&session, Some("dev1"), Path::new("/tmp"), Some(script)).unwrap();

        let pending_names = || {
            inspect(&session)
                .map(|i| {
                    i.pending()
                        .into_iter()
                        .map(|p| p.target)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        };
        wait_for("the prompt", || pending_names() == ["dev1"]);
        let windows = inspect(&session).unwrap().windows;
        assert_eq!(windows.len(), 1, "the shell window is not watched");
        assert_eq!(windows[0].state, AgentState::Blocked);
        assert_eq!(windows[0].agent.as_deref(), Some("opencode"));

        let explanation = explain(&session, "dev1").unwrap();
        assert_eq!(explanation.state, AgentState::Blocked);
        assert_eq!(explanation.rule.as_deref(), Some("opencode-permission"));
        assert!(explanation
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("contains"));

        answer(&session, "dev1", "n").unwrap();
        wait_for("the prompt to clear", || pending_names().is_empty());
        let _ = tmux::kill_session(&session);
    }
}
