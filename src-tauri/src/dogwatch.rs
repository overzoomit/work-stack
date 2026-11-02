// Dogwatch: finds the agent windows of a project's tmux session that wait for
// input and relays the PM's answers. The same job as scripts/tmux-dogwatch.py,
// built into Work: a watcher thread, two IPC commands and an event.
use crate::{store, tmux};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const POLL: Duration = Duration::from_secs(3);
const SCAN_LINES: &str = "-30";
const TAIL_LINES: usize = 12;
const ESCALATION_FILE: &str = ".claude/escalation_to_pm.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PromptType {
    Permission,
    Confirmation,
    Selection,
    Question,
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
            .filter_map(|w| {
                Some(Pending {
                    target: w.name.clone(),
                    prompt: w.prompt.clone()?,
                })
            })
            .collect()
    }
}

// ── Prompt parser ────────────────────────────────────────────

// dev1, qa, qa2, agent3, generico: the windows of the team.
pub fn is_agent_window(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    let digits = |rest: &str| rest.chars().all(|c| c.is_ascii_digit());
    name == "generico"
        || name.strip_prefix("qa").is_some_and(digits)
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

fn classify(block: &[&str]) -> Option<PromptType> {
    let lower = block.join("\n").to_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| lower.contains(n));
    if has(&[
        "do you want to proceed",
        "allow this",
        "allow the",
        "approve this",
        "approve the",
        "permission request",
        "permission required",
        "permission to",
        "trust the files",
    ]) {
        Some(PromptType::Permission)
    } else if has_yes_no(&lower)
        || has(&["enter to confirm", "press enter to continue", "continue?"])
    {
        Some(PromptType::Confirmation)
    } else if block
        .iter()
        .any(|l| numbered_option(l).is_some_and(|(_, cursor)| cursor))
    {
        Some(PromptType::Selection)
    } else {
        None
    }
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
pub fn parse_prompt(capture: &str) -> Option<Prompt> {
    let lines: Vec<&str> = capture
        .lines()
        .map(trim_box)
        .filter(|l| !l.is_empty())
        .collect();
    let tail = &lines[lines.len().saturating_sub(TAIL_LINES)..];
    let last = *tail.last()?;

    let from = tail.iter().rposition(|l| !is_chrome(l)).unwrap_or(0);
    let mut block = &tail[from..];
    let prompt_type = match classify(block) {
        Some(t) => t,
        None if last.ends_with('?') || last.to_lowercase().contains("please confirm") => {
            block = &tail[tail.len() - 1..];
            PromptType::Question
        }
        None => return None,
    };
    Some(Prompt {
        prompt_type,
        question: question_of(block),
        options: options_of(block),
    })
}

// ── Inspection and answers ───────────────────────────────────

// -J joins the lines the terminal wrapped, so a long question stays whole.
fn capture(session: &str, window_id: &str) -> Option<String> {
    let target = format!("{session}:{window_id}");
    tmux::run_tmux(&["capture-pane", "-p", "-J", "-t", &target, "-S", SCAN_LINES]).ok()
}

pub fn inspect(session: &str) -> Result<Inspection, String> {
    let windows = tmux::list_windows(session)?
        .into_iter()
        .filter(|w| is_agent_window(&w.name))
        .map(|w| WindowState {
            prompt: capture(session, &w.id).and_then(|c| parse_prompt(&c)),
            id: w.id,
            name: w.name,
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

fn now_iso() -> String {
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

// ── Watcher ──────────────────────────────────────────────────

type Seen = HashMap<String, (bool, Vec<Pending>)>;

// True when this project's session state (live or not) or pending list
// differs from the one last seen. The first look at a project always counts,
// even if empty: a stale escalation file from a previous run must be cleared then.
fn changed(seen: &mut Seen, project: &str, live: bool, now: Vec<Pending>) -> bool {
    let state = (live, now);
    seen.insert(project.to_string(), state.clone()).as_ref() != Some(&state)
}

// Writes the file when there is something to say, or an old one to clear.
fn refresh_escalation(root: &Path, pending: &[Pending]) {
    if !pending.is_empty() || root.join(ESCALATION_FILE).exists() {
        let _ = write_escalation(root, pending);
    }
}

// Polls the session of every open project. On a change it refreshes the
// escalation file (only if there is something to say, or a stale file to
// clear) and calls on_change(project, session, pending, live); live is false
// when the project has no tmux session to watch.
pub fn spawn(
    projects: impl Fn() -> Vec<String> + Send + 'static,
    on_change: impl Fn(&str, &str, &[Pending], bool) + Send + 'static,
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
                let now = inspection.map(|i| i.pending()).unwrap_or_default();
                if !changed(&mut seen, &project, live, now.clone()) {
                    continue;
                }
                refresh_escalation(root, &now);
                on_change(&project, &session, &now, live);
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
        for name in ["dev1", "DEV12", "qa", "qa2", "agent3", "generico"] {
            assert!(is_agent_window(name), "{name}");
        }
        for name in ["pm", "shell", "dev", "agent", "qatest", "dev1x", ""] {
            assert!(!is_agent_window(name), "{name}");
        }
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

        answer(&session, "dev1", "n").unwrap();
        wait_for("the prompt to clear", || pending_names().is_empty());
        let _ = tmux::kill_session(&session);
    }
}
