// Dogwatch: finds the agent windows of a project's tmux session that wait for
// input and relays the PM's answers. The same job as scripts/tmux-dogwatch.py,
// built into Work: a watcher thread, two IPC commands and an event.
use crate::{state_db, store, tmux};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cell::OnceCell;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::Path;
use std::process::Command;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const POLL: Duration = Duration::from_secs(3);
const SCAN_LINES: &str = "-30";
const TAIL_LINES: usize = 12;
const ESCALATION_FILE: &str = ".claude/escalation_to_pm.json";
const STATE_FILE: &str = ".claude/dogwatch_state.json";
const RELAY_FILE: &str = ".claude/dogwatch_relay.json";
const TAIL_PREVIEW: usize = 8;
const ACTIVITY_CHARS: usize = 200;

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
    // Idle and free: just added to the team, or standing by after its ping.
    // Only the shared database decides it (state_db::sync_windows).
    Ready,
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
    // pm, dev, qa, doc or generic: see role_of.
    pub role: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub state: AgentState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule: Option<String>,
    // Unix seconds since the window entered `state`, from .claude/work.db.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_changed_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_activity_line: Option<String>,
    #[serde(skip)]
    pub output: Output,
}

// What the window shows once the chrome is gone: kept in .claude/work.db only.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Output {
    pub hash: Option<String>,
    pub tail: Option<String>,
    pub command: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Pending {
    pub target: String,
    #[serde(flatten)]
    pub prompt: Prompt,
    pub relayed_to_pm: bool,
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
                    relayed_to_pm: false,
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

    #[cfg(test)]
    pub fn detect_agent(&self, name: &str, command: &str) -> &AgentManifest {
        self.detect_agent_in(name, &[command.to_string()]).0
    }

    // The hints go strongest first (see agent_hints): the first one naming an
    // agent wins and is returned with it. The tmux window name (the team
    // role: pm, dev1, qa1…) is the fallback when no hint names one.
    pub fn detect_agent_in<'h>(
        &self,
        name: &str,
        hints: &'h [String],
    ) -> (&AgentManifest, Option<&'h str>) {
        let specific = || self.manifests.iter().filter(|m| m.id != "generic");
        for hint in hints {
            let command = hint.to_lowercase();
            for manifest in specific() {
                if manifest
                    .aliases
                    .iter()
                    .filter(|alias| !ROLE_ALIASES.contains(&alias.as_str()))
                    .any(|alias| command_has_alias(&command, alias))
                {
                    return (manifest, Some(hint.as_str()));
                }
            }
        }
        (self.detect_role(name), None)
    }

    fn detect_role(&self, name: &str) -> &AgentManifest {
        let role = name.to_lowercase();
        for manifest in self.manifests.iter().filter(|m| m.id != "generic") {
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

    // "ollama" -> "opencode": the manifest id for an id or alias, else the name.
    pub fn canonical_agent(&self, name: &str) -> String {
        let name = name.trim().to_lowercase();
        self.manifests
            .iter()
            .find(|m| {
                m.id == name
                    || (m.aliases.contains(&name) && !ROLE_ALIASES.contains(&name.as_str()))
            })
            .map_or(name, |m| m.id.clone())
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

// Manifest aliases that name a team role, not a CLI: `npm run dev` or a
// "pm" in a title must not pick an agent.
const ROLE_ALIASES: &[&str] = &["pm", "dev", "qa", "doc", "agent", "generic", "generico"];

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
            .map(trim_box)
            .rev()
            .find(|line| !line.trim().is_empty() && !is_input_marker(line))
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

// Lines that only contain an interactive prompt symbol or input placeholder:
// ❯, >, $, %, #, ›, or "Chat ·", etc.
pub fn is_input_marker(line: &str) -> bool {
    let s = trim_box(line).trim();
    if s.is_empty() {
        return false;
    }
    if s == "❯" || s == ">" || s == "$" || s == "%" || s == "#" || s == "›" {
        return true;
    }
    let lower = s.to_lowercase();
    if lower == "ask anything..." || lower == "chat ·" || lower == "build ·" {
        return true;
    }
    if s.chars().count() <= 3 && s.starts_with(['❯', '>', '$', '%', '#', '›']) {
        return true;
    }
    false
}

// What a prompt keeps drawn around its question: options, key hints, borders, input markers.
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
        || is_input_marker(line)
        || lower.chars().all(|c| "╭╰╮╯─┌└┐┘".contains(c))
        || hint.iter().any(|h| lower.contains(h))
}

// Spinner frames, timers and key hints change while nothing else does: they
// stay out of the hash, so a frozen agent shows a still output.
fn is_spinner(line: &str) -> bool {
    line.chars()
        .next()
        .is_some_and(|c| ('\u{2800}'..='\u{28ff}').contains(&c) || "·✢✳✶✻✽".contains(c))
}

// The last meaningful line, the SHA-256 of the cleaned output and its last lines.
pub fn read_output(capture: &str) -> (Option<String>, Output) {
    let lines: Vec<&str> = capture
        .lines()
        .map(|l| trim_box(l).trim())
        .filter(|l| !l.is_empty() && !is_chrome(l) && !is_spinner(l))
        .collect();
    let digest = Sha256::digest(lines.join("\n").as_bytes());
    let tail = lines[lines.len().saturating_sub(TAIL_PREVIEW)..].join("\n");
    let last = lines
        .last()
        .map(|l| match l.char_indices().nth(ACTIVITY_CHARS) {
            Some((at, _)) => format!("{}…", &l[..at]),
            None => l.to_string(),
        });
    let output = Output {
        hash: Some(digest.iter().map(|b| format!("{b:02x}")).collect()),
        tail: Some(tail),
        command: None,
    };
    (last, output)
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

// ── Real agent of a window ───────────────────────────────────

// Shells and runtimes that host an agent started by hand: their process
// tree, not their name, says which agent runs.
const HOSTS: &[&str] = &["bash", "zsh", "sh", "fish", "dash", "ksh", "node"];

// What tmux knows of the pane: start command (team windows), foreground
// process, title and the pid of the process it started.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PaneCommand {
    pub start: String,
    pub current: String,
    pub title: String,
    pub pid: Option<u32>,
}

impl PaneCommand {
    pub fn parse(raw: &str) -> Self {
        let mut fields = raw.trim_end_matches(['\r', '\n']).split('\t');
        let mut next = || fields.next().unwrap_or("").trim().to_string();
        let (start, current, title, pid) = (next(), next(), next(), next());
        Self {
            start,
            current,
            title,
            pid: pid.parse().ok(),
        }
    }
}

fn window_command(session: &str, window_id: &str) -> PaneCommand {
    let target = format!("{session}:{window_id}");
    PaneCommand::parse(
        &tmux::run_tmux(&[
            "display-message",
            "-p",
            "-t",
            &target,
            "#{pane_start_command}\t#{pane_current_command}\t#{pane_title}\t#{pane_pid}",
        ])
        .unwrap_or_default(),
    )
}

pub type ProcessTable = Vec<(u32, u32, String)>;

// `ps -A -o pid=,ppid=,args=` output: (pid, ppid, args) per process.
pub fn parse_ps(text: &str) -> ProcessTable {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid = parts.next()?.parse().ok()?;
            let ppid = parts.next()?.parse().ok()?;
            Some((pid, ppid, parts.collect::<Vec<_>>().join(" ")))
        })
        .collect()
}

fn process_table() -> ProcessTable {
    Command::new("ps")
        .args(["-A", "-o", "pid=,ppid=,args="])
        .output()
        .map(|o| parse_ps(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default()
}

// The descendants of the pane process, parents first: the agent comes
// before the MCP servers and tools it spawns.
pub fn tree_commands(table: &ProcessTable, pid: u32) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::from([pid]);
    let mut queue = VecDeque::from([pid]);
    while let Some(parent) = queue.pop_front() {
        for (child, ppid, args) in table {
            if *ppid == parent && seen.insert(*child) {
                out.push(args.clone());
                queue.push_back(*child);
            }
        }
    }
    out
}

pub fn hosts_agent(current: &str) -> bool {
    let name = current
        .rsplit('/')
        .next()
        .unwrap_or("")
        .trim_start_matches('-');
    HOSTS.contains(&name)
}

// Strongest first: the live process tree (only under a shell or runtime),
// then the foreground command, the start command and the title.
pub fn agent_hints(pane: &PaneCommand, tree: &[String]) -> Vec<String> {
    let mut hints = if hosts_agent(&pane.current) {
        tree.to_vec()
    } else {
        Vec::new()
    };
    hints.extend([pane.current.clone(), pane.start.clone(), pane.title.clone()]);
    hints.retain(|h| !h.is_empty());
    hints
}

// "--model x", "--model=x" or "-m x" in a command line.
pub fn model_of(command: &str) -> Option<String> {
    static MODEL: OnceLock<Regex> = OnceLock::new();
    MODEL
        .get_or_init(|| {
            Regex::new(r#"(?:^|\s)(?:--model|-m)(?:=|\s+)["']?([^\s"']+)"#).expect("model regex")
        })
        .captures(command)
        .map(|c| c[1].to_string())
}

pub fn role_of(name: &str) -> &'static str {
    let name = name.to_ascii_lowercase();
    let digits = |rest: &str| rest.chars().all(|c| c.is_ascii_digit());
    if name == "pm" {
        "pm"
    } else if name
        .strip_prefix("dev")
        .is_some_and(|r| !r.is_empty() && digits(r))
    {
        "dev"
    } else if name.strip_prefix("qa").is_some_and(digits) {
        "qa"
    } else if name.strip_prefix("doc").is_some_and(digits) {
        "doc"
    } else {
        "generic"
    }
}

struct Detection<'a> {
    manifest: &'a AgentManifest,
    start_command: Option<String>,
    model: Option<String>,
    current: Option<String>,
}

// `ps` runs once per look, and only if some pane hosts a shell or runtime.
fn detect_window<'a>(
    engine: &'a ManifestEngine,
    session: &str,
    window: &tmux::TmuxWindow,
    table: &OnceCell<ProcessTable>,
) -> Detection<'a> {
    let pane = window_command(session, &window.id);
    let tree = match pane.pid {
        Some(pid) if hosts_agent(&pane.current) => {
            tree_commands(table.get_or_init(process_table), pid)
        }
        _ => Vec::new(),
    };
    let hints = agent_hints(&pane, &tree);
    let (manifest, matched) = engine.detect_agent_in(&window.name, &hints);
    // Started in an interactive shell: the child that runs the agent.
    let start_command = Some(pane.start.clone())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            matched
                .filter(|m| tree.iter().any(|t| t == m))
                .map(String::from)
        })
        .or_else(|| tree.first().cloned());
    let model = matched
        .and_then(model_of)
        .or_else(|| start_command.as_deref().and_then(model_of));
    Detection {
        manifest,
        start_command,
        model,
        current: Some(pane.current).filter(|c| !c.is_empty()),
    }
}

// The agent id running in a window of the session, for plane-dogwatch routing.
pub fn window_agent(session: &str, window: &str) -> Option<String> {
    let found = tmux::list_windows(session)
        .ok()?
        .into_iter()
        .find(|w| w.name == window)?;
    Some(
        detect_window(engine(), session, &found, &OnceCell::new())
            .manifest
            .id
            .clone(),
    )
}

pub fn canonical_agent(name: &str) -> String {
    engine().canonical_agent(name)
}

pub fn inspect(session: &str) -> Result<Inspection, String> {
    let engine = engine();
    let table = OnceCell::new();
    let windows = tmux::list_windows(session)?
        .into_iter()
        .filter(|w| is_agent_window(&w.name))
        .map(|w| {
            let detection = detect_window(engine, session, &w, &table);
            let manifest = detection.manifest;
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
            let (last_activity_line, mut output) =
                captured.as_deref().map(read_output).unwrap_or_default();
            output.command = detection.current;
            WindowState {
                prompt,
                role: role_of(&w.name),
                start_command: detection.start_command,
                model: detection.model,
                id: w.id,
                name: w.name,
                agent: Some(manifest.id.clone()),
                state: classification.state,
                rule: classification.rule,
                state_changed_at: None,
                last_activity_line,
                output,
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
        // Give the target TUI (Ink / Codex / readline) time to swallow and settle
        // before pressing Enter, especially for long or pasted text.
        std::thread::sleep(std::time::Duration::from_millis(350));
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

// The last activity line is part of it, so the team card follows an agent
// that keeps printing; spinners and timers never reach that line.
fn state_signature(windows: &[WindowState]) -> String {
    windows
        .iter()
        .map(|w| {
            format!(
                "{}:{}:{}:{}:{}",
                w.name,
                serde_json::to_string(&w.state).unwrap_or_default(),
                w.rule.as_deref().unwrap_or(""),
                w.agent.as_deref().unwrap_or(""),
                w.last_activity_line.as_deref().unwrap_or("")
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

// ── Relay to the PM ──────────────────────────────────────────
//
// A blocked worker's question reaches the PM's window once, while the PM is
// idle. What was relayed is kept in RELAY_FILE (target -> fingerprint), shared
// with scripts/tmux-dogwatch.py, so neither side repeats the other's message.

pub type Relayed = BTreeMap<String, String>;

#[derive(Serialize, Deserialize, Default)]
struct RelayFile {
    #[serde(default)]
    relayed: Relayed,
}

// Same digest as the script: SHA-256 over the fields joined by \x1e, options
// joined by \x1f, first 8 bytes in hex. A new question gets a new fingerprint.
pub fn fingerprint(target: &str, prompt: &Prompt) -> String {
    let kind = serde_json::to_value(prompt.prompt_type).unwrap_or_default();
    let kind = kind.as_str().unwrap_or_default();
    let options = prompt.options.join("\x1f");
    let raw = [target, kind, prompt.question.as_str(), options.as_str()].join("\x1e");
    Sha256::digest(raw.as_bytes())
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn format_pm_escalation(target: &str, agent: &str, prompt: &Prompt) -> String {
    let kind = serde_json::to_value(prompt.prompt_type).unwrap_or_default();
    let kind = kind.as_str().unwrap_or_default();
    let options = if prompt.options.is_empty() {
        "nessuna".to_string()
    } else {
        prompt.options.join(" | ")
    };
    format!(
        "[DOGWATCH] {target} ({agent}) è bloccato. Tipo: {kind}. Domanda: {question}. Opzioni: {options}. \
Se è una questione tecnica nota o una conferma di routine, rispondi tu: python3 scripts/tmux-dogwatch.py answer {target} \"<risposta>\". \
Altrimenti inoltra all'utente con python3 scripts/telegram-pm.py send \"<messaggio>\" e, appena arriva la sua risposta, passala con python3 scripts/tmux-dogwatch.py answer {target} \"<risposta>\".",
        question = prompt.question,
    )
}

// Marks what the PM already has and sends the first unseen question while the
// PM is idle. One send per call: the PM is busy afterwards, so the rest wait
// for its next idle look. A target that stops being pending forgets its
// fingerprint, so its next block is relayed again. Returns whether `relayed`
// changed and must be saved.
pub fn relay_to_pm(
    relayed: &mut Relayed,
    windows: &[WindowState],
    pending: &mut [Pending],
    send: impl FnOnce(&str) -> Result<(), String>,
) -> bool {
    let before = relayed.clone();
    relayed.retain(|target, fp| {
        pending
            .iter()
            .any(|p| &p.target == target && fingerprint(&p.target, &p.prompt) == *fp)
    });
    for entry in pending.iter_mut() {
        entry.relayed_to_pm =
            relayed.get(&entry.target) == Some(&fingerprint(&entry.target, &entry.prompt));
    }

    let pm_idle = windows.iter().any(|w| {
        w.name.eq_ignore_ascii_case("pm") && matches!(w.state, AgentState::Idle | AgentState::Ready)
    });
    if pm_idle {
        if let Some(entry) = pending.iter_mut().find(|e| !e.relayed_to_pm) {
            let agent = windows
                .iter()
                .find(|w| w.name == entry.target)
                .and_then(|w| w.agent.as_deref())
                .unwrap_or("generic");
            let text = format_pm_escalation(&entry.target, agent, &entry.prompt);
            if send(&text).is_ok() {
                relayed.insert(
                    entry.target.clone(),
                    fingerprint(&entry.target, &entry.prompt),
                );
                entry.relayed_to_pm = true;
            }
        }
    }
    *relayed != before
}

fn load_relayed(root: &Path) -> Relayed {
    std::fs::read_to_string(root.join(RELAY_FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<RelayFile>(&text).ok())
        .map(|file| file.relayed)
        .unwrap_or_default()
}

fn save_relayed(root: &Path, relayed: &Relayed) -> std::io::Result<()> {
    store::save(
        &root.join(RELAY_FILE),
        &serde_json::json!({ "relayed": relayed }),
    )
}

// True when a question was typed into the PM window.
fn relay_pending(
    root: &Path,
    session: &str,
    windows: &[WindowState],
    pending: &mut [Pending],
) -> bool {
    let mut relayed = load_relayed(root);
    let mut sent = false;
    let changed = relay_to_pm(&mut relayed, windows, pending, |text| {
        answer(session, "pm", text)?;
        sent = true;
        Ok(())
    });
    if changed {
        let _ = save_relayed(root, &relayed);
    }
    sent
}

// ── Shared database ──────────────────────────────────────────

// A project without a session gets no database until it has one to describe.
fn open_db(root: &Path, live: bool) -> Option<rusqlite::Connection> {
    let path = root.join(state_db::DB_FILE);
    (live || path.is_file())
        .then(|| state_db::open(&path).ok())
        .flatten()
}

// Persists the look and runs the watchdog; returns the active anomalies as a
// signature, so a new or resolved one counts as a change for the renderer.
fn track(
    db: &mut rusqlite::Connection,
    session: &str,
    live: bool,
    windows: &mut [WindowState],
) -> String {
    let now = state_db::now();
    let _ = state_db::sync_windows(db, session, live, windows, now);
    state_db::evaluate_anomalies(db, now)
        .unwrap_or_default()
        .iter()
        .map(|a| format!("{}:{}", a.id, a.window_name))
        .collect::<Vec<_>>()
        .join(",")
}

// The window answered from Work: its session's folder holds the database.
fn record_answer(session: &str, window: &str, text: &str) {
    let Ok(dir) = tmux::run_tmux(&[
        "display-message",
        "-p",
        "-t",
        &format!("={session}:"),
        "#{session_path}",
    ]) else {
        return;
    };
    let path = Path::new(dir.trim()).join(state_db::DB_FILE);
    if !path.is_file() {
        return;
    }
    if let Ok(db) = state_db::open(&path) {
        let _ = state_db::record_answer(&db, window, text, "work-ui", state_db::now());
    }
}

// Polls the session of every open project. On a change it relays new questions
// to the PM, refreshes the escalation file (only if there is something to say,
// or a stale file to clear) and calls on_change(project, session, pending, live,
// windows); live is false when the project has no tmux session to watch. The
// windows carry the real agent detected in each pane, so the renderer can
// update its badges.
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
                let (mut now, mut windows) = inspection
                    .map(|i| (i.pending(), i.windows))
                    .unwrap_or_default();
                let mut db = open_db(root, live);
                let anomalies = db
                    .as_mut()
                    .map(|db| track(db, &session, live, &mut windows))
                    .unwrap_or_default();
                let states = format!("{}#{anomalies}", state_signature(&windows));
                let mut sent = false;
                if changed_full(&mut seen, &project, live, now.clone(), states) {
                    sent = relay_pending(root, &session, &windows, &mut now);
                    refresh_escalation(root, &now);
                    if let Some(db) = db.as_mut() {
                        let _ = state_db::sync_escalations(db, &now, state_db::now());
                    }
                    let _ = write_window_state(root, &session, live, &windows);
                    on_change(&project, &session, &now, live, &windows);
                }
                // One message per look: a relayed question already reached the PM.
                if let (Some(db), false) = (db.as_ref(), sent) {
                    let _ = state_db::alert_pm(db, state_db::now(), |text| {
                        answer(&session, "pm", text)
                    });
                }
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
    let manifest = detect_window(engine, session, &found, &OnceCell::new()).manifest;
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
    self::answer(&session, &window, &answer)?;
    record_answer(&session, &window, &answer);
    Ok(())
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
    fn opencode_working_above_its_build_bar_is_working() {
        let busy = "  ⠦ Thinking…\n  ■■■■■■⬝⬝ esc interrupt\n┃\n┃  Build · deepseek-v4.1-flash:cloud\n╹▀▀▀▀▀▀▀▀▀\n  …/work-st…  shift+tab agents  ctrl+p commands\n  ⊙ 1 MCP\n";
        assert_eq!(classified("opencode", busy).state, AgentState::Working);
        let idle = "  done\n┃  Ask anything… \"What is the tech stack\"\n┃\n┃  Build · deepseek-v4.1-flash:cloud\n╹▀▀▀▀▀▀▀▀▀\n  …/work-st…  shift+tab agents  ctrl+p commands\n  ⊙ 1 MCP\n";
        assert_eq!(classified("opencode", idle).state, AgentState::Idle);
    }

    #[test]
    fn claude_cooking_under_a_multi_line_statusline_is_working() {
        let busy = "⏺ Reading src/main.rs\n\n✢ Cooking… (2m · ↓ 3.1k tokens · thinking)\n\n╭──────────────╮\n│ >            │\n╰──────────────╯\n  ~/work-stack (main) · Opus\n  ctx 42% · $1.20\n  ⏵⏵ auto mode on (shift+tab to cycle)\n";
        let working = classified("claude", busy);
        assert_eq!(working.state, AgentState::Working);
        assert_eq!(working.rule.as_deref(), Some("claude-thinking"));
        let done = busy.replace(
            "✢ Cooking… (2m · ↓ 3.1k tokens · thinking)",
            "✻ Cooked for 2m 3s",
        );
        assert_eq!(classified("claude", &done).state, AgentState::Idle);
    }

    #[test]
    fn a_ready_pm_gets_the_relayed_question() {
        let ready = [window("pm", AgentState::Ready)];
        let mut relayed = Relayed::new();
        let mut pending = vec![blocked("dev1", "Continue? [y/N]")];
        let mut sent = Vec::new();
        assert!(relay(&mut relayed, &ready, &mut pending, &mut sent));
        assert_eq!(sent.len(), 1);
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
        for name in [
            "pm", "dev1", "DEV12", "qa", "qa2", "agent3", "doc1", "DOC2", "doc", "generico",
        ] {
            assert!(is_agent_window(name), "{name}");
        }
        for name in [
            "shell", "dev", "agent", "qatest", "dev1x", "docx", "docs", "",
        ] {
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
                    role: "generic",
                    start_command: None,
                    model: None,
                    state: AgentState::Blocked,
                    rule: Some("antigravity-confirmation".into()),
                    state_changed_at: None,
                    last_activity_line: None,
                    output: Output::default(),
                },
                WindowState {
                    id: "@1".into(),
                    name: "dev1".into(),
                    prompt: Some(prompt),
                    agent: Some("opencode".into()),
                    role: "generic",
                    start_command: None,
                    model: None,
                    state: AgentState::Blocked,
                    rule: Some("opencode-confirmation".into()),
                    state_changed_at: None,
                    last_activity_line: None,
                    output: Output::default(),
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
            relayed_to_pm: true,
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
            relayed_to_pm: false,
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
                role: "generic",
                start_command: None,
                model: None,
                state: AgentState::Blocked,
                rule: Some("opencode-permission".into()),
                state_changed_at: None,
                last_activity_line: None,
                output: Output::default(),
            },
            WindowState {
                id: "@1".into(),
                name: "qa1".into(),
                prompt: None,
                agent: Some("codex".into()),
                role: "generic",
                start_command: None,
                model: None,
                state: AgentState::Working,
                rule: Some("codex-spinner".into()),
                state_changed_at: None,
                last_activity_line: None,
                output: Output::default(),
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
                role: "generic",
                start_command: None,
                model: None,
                state: AgentState::Working,
                rule: Some("opencode-spinner".into()),
                state_changed_at: None,
                last_activity_line: None,
                output: Output::default(),
            }]
        };
        assert_ne!(
            state_signature(&window("codex")),
            state_signature(&window("opencode")),
            "the badge must be refreshed when the real agent changes"
        );
    }

    #[test]
    fn a_new_activity_line_alone_is_a_state_change_regression() {
        let window = |capture: &str| {
            let (last_activity_line, output) = read_output(capture);
            vec![WindowState {
                id: "@0".into(),
                name: "dev1".into(),
                prompt: None,
                agent: Some("claude".into()),
                role: "generic",
                start_command: None,
                model: None,
                state: AgentState::Working,
                rule: Some("claude-interrupt-hint".into()),
                state_changed_at: None,
                last_activity_line,
                output,
            }]
        };
        let first = state_signature(&window("cargo build\n✻ Working… (3s · esc to interrupt)\n"));
        assert_ne!(
            first,
            state_signature(&window(
                "cargo build\ncargo test\n✻ Working… (3s · esc to interrupt)\n"
            )),
            "the card must show the new line"
        );
        assert_eq!(
            first,
            state_signature(&window("cargo build\n✶ Working… (9s · esc to interrupt)\n")),
            "a ticking spinner is not news"
        );
    }

    #[test]
    fn only_a_different_pending_list_counts_as_a_change() {
        let mut seen = Seen::new();
        let q = |text: &str| {
            vec![Pending {
                target: "dev1".into(),
                prompt: prompt(text),
                relayed_to_pm: false,
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
            relayed_to_pm: false,
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

    fn question(text: &str) -> Prompt {
        Prompt {
            prompt_type: PromptType::Confirmation,
            question: text.into(),
            options: vec!["Yes".into(), "No".into()],
        }
    }

    fn blocked(name: &str, text: &str) -> Pending {
        Pending {
            target: name.into(),
            prompt: question(text),
            relayed_to_pm: false,
        }
    }

    fn window(name: &str, state: AgentState) -> WindowState {
        WindowState {
            id: "@0".into(),
            name: name.into(),
            prompt: None,
            agent: Some("codex".into()),
            role: role_of(name),
            start_command: None,
            model: None,
            state,
            rule: None,
            state_changed_at: None,
            last_activity_line: None,
            output: Output::default(),
        }
    }

    // Records what would reach the PM window: relay_to_pm needs no tmux.
    fn relay(
        relayed: &mut Relayed,
        windows: &[WindowState],
        pending: &mut [Pending],
        sent: &mut Vec<String>,
    ) -> bool {
        relay_to_pm(relayed, windows, pending, |text| {
            sent.push(text.to_string());
            Ok(())
        })
    }

    #[test]
    fn the_fingerprint_matches_the_script_so_both_sides_share_one_memory() {
        assert_eq!(
            fingerprint("dev1", &question("Continue? [y/N]")),
            "ff6de19081094bae"
        );
    }

    #[test]
    fn a_question_reaches_an_idle_pm_once() {
        let idle = [window("pm", AgentState::Idle)];
        let mut relayed = Relayed::new();
        let mut pending = vec![blocked("dev1", "Continue? [y/N]")];
        let mut sent = Vec::new();

        assert!(relay(&mut relayed, &idle, &mut pending, &mut sent));
        assert_eq!(sent.len(), 1);
        assert!(pending[0].relayed_to_pm);

        let mut again = vec![blocked("dev1", "Continue? [y/N]")];
        assert!(!relay(&mut relayed, &idle, &mut again, &mut sent));
        assert_eq!(sent.len(), 1, "the same block is not announced twice");
        assert!(again[0].relayed_to_pm);
    }

    #[test]
    fn a_busy_pm_gets_nothing_until_it_is_idle() {
        let mut relayed = Relayed::new();
        let mut pending = vec![blocked("dev1", "Continue? [y/N]")];
        let mut sent = Vec::new();

        let busy = [window("pm", AgentState::Working)];
        assert!(!relay(&mut relayed, &busy, &mut pending, &mut sent));
        assert!(sent.is_empty());
        assert!(!pending[0].relayed_to_pm);

        let idle = [window("pm", AgentState::Idle)];
        relay(&mut relayed, &idle, &mut pending, &mut sent);
        assert_eq!(sent.len(), 1);
    }

    #[test]
    fn a_missing_pm_window_is_never_a_reason_to_send() {
        let mut relayed = Relayed::new();
        let mut pending = vec![blocked("dev1", "Continue? [y/N]")];
        let mut sent = Vec::new();
        relay(
            &mut relayed,
            &[window("dev1", AgentState::Blocked)],
            &mut pending,
            &mut sent,
        );
        assert!(sent.is_empty());
    }

    #[test]
    fn one_send_per_idle_look_and_the_rest_follow_later() {
        let idle = [window("pm", AgentState::Idle)];
        let mut relayed = Relayed::new();
        let mut sent = Vec::new();
        let both = || {
            vec![
                blocked("dev1", "Continue? [y/N]"),
                blocked("qa1", "Deploy now? [y/N]"),
            ]
        };

        let mut pending = both();
        relay(&mut relayed, &idle, &mut pending, &mut sent);
        assert_eq!(sent.len(), 1);
        assert!(sent[0].contains("dev1"));
        assert!(!pending[1].relayed_to_pm);

        let mut pending = both();
        relay(&mut relayed, &idle, &mut pending, &mut sent);
        assert_eq!(sent.len(), 2);
        assert!(sent[1].contains("qa1"));
    }

    #[test]
    fn an_unblocked_target_forgets_its_block_so_the_next_one_is_relayed() {
        let idle = [window("pm", AgentState::Idle)];
        let mut relayed = Relayed::new();
        let mut sent = Vec::new();
        let mut pending = vec![blocked("dev1", "Continue? [y/N]")];
        relay(&mut relayed, &idle, &mut pending, &mut sent);

        let mut none: Vec<Pending> = Vec::new();
        assert!(relay(&mut relayed, &idle, &mut none, &mut sent));
        assert!(
            relayed.is_empty(),
            "the key is cleared once the window unblocks"
        );

        let mut pending = vec![blocked("dev1", "Continue? [y/N]")];
        relay(&mut relayed, &idle, &mut pending, &mut sent);
        assert_eq!(
            sent.len(),
            2,
            "a new block of the same question is relayed again"
        );
    }

    #[test]
    fn a_new_question_from_the_same_target_is_relayed_again() {
        let idle = [window("pm", AgentState::Idle)];
        let mut relayed = Relayed::new();
        let mut sent = Vec::new();
        let mut pending = vec![blocked("dev1", "Continue? [y/N]")];
        relay(&mut relayed, &idle, &mut pending, &mut sent);

        let mut pending = vec![blocked("dev1", "Delete the branch? [y/N]")];
        relay(&mut relayed, &idle, &mut pending, &mut sent);
        assert_eq!(sent.len(), 2);
    }

    #[test]
    fn the_relayed_map_survives_a_restart_through_the_shared_file() {
        let dir = tempfile::tempdir().unwrap();
        assert!(
            load_relayed(dir.path()).is_empty(),
            "no file, nothing relayed"
        );

        let mut relayed = Relayed::new();
        relayed.insert(
            "dev1".into(),
            fingerprint("dev1", &question("Continue? [y/N]")),
        );
        save_relayed(dir.path(), &relayed).unwrap();
        assert_eq!(load_relayed(dir.path()), relayed);
    }

    #[test]
    fn the_activity_line_skips_chrome_and_the_hash_ignores_spinners() {
        let busy = "⏺ Running the tests\n  npm test passed\n✻ Thinking… (12s · esc to interrupt)\n╭───╮\n│ > │\n╰───╯\n";
        let (line, output) = read_output(busy);
        assert_eq!(line.as_deref(), Some("npm test passed"));
        assert_eq!(
            output.tail.as_deref(),
            Some("⏺ Running the tests\nnpm test passed")
        );
        // scripts/work_db.py computes the same digest (test/work-agent.test.mjs).
        assert_eq!(
            output.hash.as_deref(),
            Some("c226aa322ef97bd9a89063feb23d72fadff39516ef444cc4295a7b781fc28351")
        );

        let later = busy.replace("12s", "13s").replace('✻', "✶");
        assert_eq!(
            read_output(&later).1.hash,
            output.hash,
            "a ticking spinner is not new output"
        );
        let moved = format!("{busy}done\n");
        assert_ne!(read_output(&moved).1.hash, output.hash);
    }

    #[test]
    fn the_activity_line_is_clipped_and_the_tail_keeps_eight_lines() {
        let long = "x".repeat(300);
        assert_eq!(
            read_output(&long).0.unwrap().chars().count(),
            ACTIVITY_CHARS + 1
        );
        let many: String = (1..=12).map(|n| format!("line {n}\n")).collect();
        let tail = read_output(&many).1.tail.unwrap();
        assert_eq!(tail.lines().count(), 8);
        assert!(tail.starts_with("line 5"));
        assert_eq!(read_output("").0, None);
    }

    #[test]
    fn the_state_file_carries_the_state_start_and_the_activity_line() {
        let dir = tempfile::tempdir().unwrap();
        let mut windows = vec![WindowState {
            id: "@1".into(),
            name: "dev1".into(),
            prompt: None,
            agent: Some("claude".into()),
            role: "generic",
            start_command: None,
            model: None,
            state: AgentState::Working,
            rule: None,
            state_changed_at: None,
            last_activity_line: Some("cargo test".into()),
            output: read_output("cargo test\n").1,
        }];
        let mut db = state_db::open(&dir.path().join(state_db::DB_FILE)).unwrap();
        assert_eq!(track(&mut db, "work_s", true, &mut windows), "");
        assert!(windows[0].state_changed_at.is_some());
        write_window_state(dir.path(), "work_s", true, &windows).unwrap();
        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join(STATE_FILE)).unwrap())
                .unwrap();
        assert_eq!(json["windows"][0]["last_activity_line"], "cargo test");
        assert!(json["windows"][0]["state_changed_at"].is_u64());
        assert!(json["windows"][0].get("output").is_none());
    }

    #[test]
    fn a_project_without_a_session_gets_no_database() {
        let dir = tempfile::tempdir().unwrap();
        assert!(open_db(dir.path(), false).is_none());
        assert!(!dir.path().join(state_db::DB_FILE).exists());
        assert!(open_db(dir.path(), true).is_some());
        assert!(
            open_db(dir.path(), false).is_some(),
            "an existing one is kept up to date"
        );
    }

    #[test]
    fn the_model_comes_from_the_command_line() {
        assert_eq!(
            model_of("ollama launch opencode --model deepseek-v4.1-flash:cloud").as_deref(),
            Some("deepseek-v4.1-flash:cloud")
        );
        assert_eq!(
            model_of("claude --model=opus --yolo").as_deref(),
            Some("opus")
        );
        assert_eq!(
            model_of("codex -m 'gpt-5' --full-auto").as_deref(),
            Some("gpt-5")
        );
        assert_eq!(model_of("claude --dangerously-skip-permissions"), None);
        assert_eq!(model_of("npm run build-model"), None);
    }

    #[test]
    fn the_role_comes_from_the_window_name() {
        for (name, role) in [
            ("pm", "pm"),
            ("dev1", "dev"),
            ("DEV12", "dev"),
            ("qa", "qa"),
            ("qa2", "qa"),
            ("doc", "doc"),
            ("doc1", "doc"),
            ("agent3", "generic"),
            ("generico", "generic"),
            ("dev", "generic"),
        ] {
            assert_eq!(role_of(name), role, "{name}");
        }
    }

    #[test]
    fn the_process_tree_lists_the_descendants_parents_first() {
        let table = parse_ps(
            "  100     1 -zsh\n  200   100 node /home/u/.npm/bin/claude --model opus\n  300   200 npx @playwright/mcp\n  400     1 codex\n bad line\n",
        );
        assert_eq!(table.len(), 4);
        assert_eq!(
            tree_commands(&table, 100),
            [
                "node /home/u/.npm/bin/claude --model opus",
                "npx @playwright/mcp"
            ]
        );
        assert!(tree_commands(&table, 999).is_empty());
    }

    #[test]
    fn an_agent_started_by_hand_in_a_shell_beats_the_role_default() {
        let engine = ManifestEngine::builtin();
        let tree = vec!["node /home/u/.npm/bin/claude --model opus".to_string()];
        let pane = PaneCommand::parse("\tzsh\tqa1-host\t100\n");
        assert_eq!(pane.pid, Some(100));
        let hints = agent_hints(&pane, &tree);
        let (manifest, matched) = engine.detect_agent_in("qa1", &hints);
        assert_eq!(
            manifest.id, "claude",
            "not the codex default of a qa window"
        );
        assert_eq!(matched.and_then(model_of).as_deref(), Some("opus"));

        // Not under a shell: the tree is not read, the foreground command decides.
        let busy = PaneCommand::parse("opencode\tcodex\t\t100");
        let (manifest, _) = engine.detect_agent_in("dev1", &agent_hints(&busy, &tree));
        assert_eq!(
            manifest.id, "codex",
            "the foreground command beats the start command"
        );

        let idle_shell = PaneCommand::parse("\tbash\tdev2\t7");
        let tree = vec!["npm run dev".to_string()];
        let hints = agent_hints(&idle_shell, &tree);
        let (manifest, matched) = engine.detect_agent_in("dev2", &hints);
        assert_eq!(
            manifest.id, "opencode",
            "role fallback, not the token dev in npm run dev"
        );
        assert_eq!(matched, None);
    }

    #[test]
    fn agent_names_and_aliases_map_to_the_manifest_id() {
        assert_eq!(canonical_agent("Claude"), "claude");
        assert_eq!(canonical_agent("ollama"), "opencode");
        assert_eq!(canonical_agent("qa"), "qa", "a role alias is not an agent");
        assert_eq!(canonical_agent("aider"), "aider");
    }

    #[test]
    fn the_prompt_sent_to_the_pm_carries_both_ways_to_answer() {
        let text = format_pm_escalation("dev1", "opencode", &question("Continue? [y/N]"));
        assert!(text.contains("tmux-dogwatch.py answer dev1"));
        assert!(text.contains("telegram-pm.py send"));
        assert!(text.contains("Opzioni: Yes | No"));
    }

    #[test]
    fn open_question_with_cursor_marker_on_last_line_is_extracted() {
        let capture =
            "Everything compiled successfully. Do you want me to commit and push the changes?\n❯ ";
        let classification = classified("claude", capture);
        assert_eq!(classification.state, AgentState::Blocked);
        assert_eq!(classification.prompt_type, Some(PromptType::Question));
        let p = parse_prompt(capture).expect("a prompt");
        assert_eq!(p.prompt_type, PromptType::Question);
        assert_eq!(
            p.question,
            "Everything compiled successfully. Do you want me to commit and push the changes?"
        );
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
