// The team's shared state: one SQLite file per project (.claude/work.db, WAL)
// written by the dogwatch watchers here and by the Python scripts
// (scripts/work_db.py holds the same schema). The JSON files under .claude/
// are still written next to it for older readers.
use crate::dogwatch::{fingerprint, AgentState, Pending, WindowState};
use crate::fsops::{guard, Roots};
use rusqlite::types::ValueRef;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::State;

pub const DB_FILE: &str = ".claude/work.db";
const SCHEMA_VERSION: &str = "2";
const MAX_EVENTS: i64 = 1000;
const SNAPSHOT_EVENTS: i64 = 50;
pub const ORPHAN_AFTER: i64 = 90;
pub const FROZEN_AFTER: i64 = 300;
pub const BLOCKED_AFTER: i64 = 180;
// A PM that went idle a moment ago may still be reading what it was just sent.
const PM_SETTLE: i64 = 5;

// Keep in step with SCHEMA in scripts/work_db.py.
const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS windows(name TEXT PRIMARY KEY, window_id TEXT, session TEXT, agent TEXT, state TEXT NOT NULL, rule TEXT, state_changed_at INTEGER NOT NULL, last_output_change_at INTEGER NOT NULL, output_hash TEXT, last_activity_line TEXT, tail_preview TEXT, current_command TEXT, updated_at INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'generic', start_command TEXT, model TEXT);
CREATE TABLE IF NOT EXISTS escalations(id INTEGER PRIMARY KEY AUTOINCREMENT, window_name TEXT NOT NULL, fingerprint TEXT NOT NULL, prompt_type TEXT NOT NULL, question TEXT NOT NULL, options_json TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, relayed_at INTEGER, resolved_at INTEGER, answer_text TEXT, answered_by TEXT);
CREATE TABLE IF NOT EXISTS plane_issues(issue_id TEXT PRIMARY KEY, sequence_id INTEGER, title TEXT, state TEXT NOT NULL, role TEXT, assigned_window TEXT, fingerprint TEXT, handled_state TEXT, delegated_at INTEGER, state_updated_at INTEGER, last_error TEXT);
CREATE TABLE IF NOT EXISTS prompt_barriers(window_name TEXT PRIMARY KEY, session TEXT, sender TEXT, instruction_preview TEXT, sent_at_ms INTEGER NOT NULL, observed_busy_at_ms INTEGER);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, window_name TEXT, category TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, details_json TEXT);
CREATE TABLE IF NOT EXISTS anomalies(id INTEGER PRIMARY KEY AUTOINCREMENT, window_name TEXT NOT NULL, issue_id TEXT, kind TEXT NOT NULL, message TEXT NOT NULL, detected_at INTEGER NOT NULL, notified_to_pm_at INTEGER, resolved_at INTEGER);
";

// Columns added after schema 1: added in place to an existing database.
const WINDOW_COLUMNS: &[(&str, &str)] = &[
    ("role", "TEXT NOT NULL DEFAULT 'generic'"),
    ("start_command", "TEXT"),
    ("model", "TEXT"),
];

// Upsert that keeps state_changed_at while the state holds, and
// last_output_change_at while the cleaned output hash holds.
const UPSERT_WINDOW: &str = "
INSERT INTO windows(name, window_id, session, agent, state, rule, state_changed_at, last_output_change_at, output_hash, last_activity_line, tail_preview, current_command, updated_at, role, start_command, model)
VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9, ?10, ?11, ?7, ?12, ?13, ?14)
ON CONFLICT(name) DO UPDATE SET
  window_id = excluded.window_id, session = excluded.session, agent = excluded.agent, rule = excluded.rule,
  role = excluded.role, start_command = excluded.start_command, model = excluded.model,
  state_changed_at = CASE WHEN windows.state = excluded.state THEN windows.state_changed_at ELSE excluded.state_changed_at END,
  state = excluded.state,
  last_output_change_at = CASE WHEN excluded.output_hash IS NULL OR windows.output_hash IS excluded.output_hash THEN windows.last_output_change_at ELSE excluded.last_output_change_at END,
  output_hash = COALESCE(excluded.output_hash, windows.output_hash),
  last_activity_line = COALESCE(excluded.last_activity_line, windows.last_activity_line),
  tail_preview = COALESCE(excluded.tail_preview, windows.tail_preview),
  current_command = COALESCE(excluded.current_command, windows.current_command),
  updated_at = excluded.updated_at";

// ?9 is the delegation time of this cycle (NULL when none): a ticket already
// held when first seen counts as delegated then.
const UPSERT_ISSUE: &str = "
INSERT INTO plane_issues(issue_id, sequence_id, title, state, role, assigned_window, fingerprint, handled_state, delegated_at, state_updated_at, last_error)
VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, COALESCE(?9, CASE WHEN ?6 IS NOT NULL THEN ?10 END), ?10, ?11)
ON CONFLICT(issue_id) DO UPDATE SET
  sequence_id = excluded.sequence_id, title = excluded.title, role = excluded.role,
  assigned_window = excluded.assigned_window, fingerprint = excluded.fingerprint, handled_state = excluded.handled_state,
  delegated_at = CASE WHEN ?9 IS NOT NULL THEN ?9 ELSE COALESCE(plane_issues.delegated_at, excluded.delegated_at) END,
  last_error = CASE WHEN ?9 IS NOT NULL THEN excluded.last_error ELSE COALESCE(excluded.last_error, plane_issues.last_error) END,
  state_updated_at = CASE WHEN plane_issues.state = excluded.state THEN plane_issues.state_updated_at ELSE excluded.state_updated_at END,
  state = excluded.state";

const HELD: &str =
    "((role = 'dev' AND lower(state) = 'in progress') OR (role = 'qa' AND lower(state) = 'test'))";

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

pub fn open(path: &Path) -> Result<Connection, String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let conn = Connection::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    configure(&conn).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(conn)
}

fn configure(conn: &Connection) -> rusqlite::Result<()> {
    conn.busy_timeout(Duration::from_millis(5000))?;
    conn.query_row("PRAGMA journal_mode=WAL", [], |_| Ok(()))?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.execute_batch(SCHEMA)?;
    migrate(conn)?;
    // opencode_last_prune_at is "0" until the first OpenCode prune.
    conn.execute(
        "INSERT OR IGNORE INTO meta(key, value, updated_at) VALUES('schema_version', ?1, ?2), ('opencode_last_prune_at', '0', ?2)",
        params![SCHEMA_VERSION, now()],
    )?;
    Ok(())
}

// Idempotent: a column another process added a moment ago is not an error.
fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let present: Vec<String> = conn
        .prepare("SELECT name FROM pragma_table_info('windows')")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for (column, ddl) in WINDOW_COLUMNS {
        if present.iter().any(|c| c == column) {
            continue;
        }
        match conn.execute(
            &format!("ALTER TABLE windows ADD COLUMN {column} {ddl}"),
            [],
        ) {
            Err(e) if e.to_string().contains("duplicate column") => {}
            other => {
                other?;
            }
        }
    }
    set_meta(conn, "schema_version", SCHEMA_VERSION, now())
}

pub fn set_meta(conn: &Connection, key: &str, value: &str, now: i64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO meta(key, value, updated_at) VALUES(?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value, now],
    )?;
    Ok(())
}

fn clip(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_string(),
    }
}

// Every insert trims the table to the newest MAX_EVENTS rows.
pub fn log_event(
    conn: &Connection,
    now: i64,
    window: Option<&str>,
    category: &str,
    kind: &str,
    summary: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO events(timestamp, window_name, category, kind, summary) VALUES(?1, ?2, ?3, ?4, ?5)",
        params![now, window, category, kind, clip(summary, 300)],
    )?;
    conn.execute(
        "DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ?1",
        [MAX_EVENTS],
    )?;
    Ok(())
}

fn state_name(state: AgentState) -> &'static str {
    match state {
        AgentState::Working => "working",
        AgentState::Blocked => "blocked",
        AgentState::Idle => "idle",
    }
}

// One dogwatch look: upserts every agent window, puts the ones that left the
// session offline, logs each transition and fills state_changed_at back in.
pub fn sync_windows(
    conn: &mut Connection,
    session: &str,
    live: bool,
    windows: &mut [WindowState],
    now: i64,
) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    for w in windows.iter_mut() {
        let state = state_name(w.state);
        let before: Option<String> = tx
            .query_row(
                "SELECT state FROM windows WHERE name = ?1",
                [&w.name],
                |r| r.get(0),
            )
            .optional()?;
        tx.execute(
            UPSERT_WINDOW,
            params![
                w.name,
                w.id,
                session,
                w.agent,
                state,
                w.rule,
                now,
                w.output.hash,
                w.last_activity_line,
                w.output.tail,
                w.output.command,
                w.role,
                w.start_command,
                w.model,
            ],
        )?;
        if before.as_deref() != Some(state) {
            let from = before.as_deref().unwrap_or("new");
            let summary = format!("{} {from} -> {state}", w.name);
            log_event(&tx, now, Some(&w.name), "window", "state", &summary)?;
        }
        // The wait of `work-agent prompt` needs to know the target started.
        if matches!(w.state, AgentState::Working | AgentState::Blocked) {
            tx.execute(
                "UPDATE prompt_barriers SET observed_busy_at_ms = ?1 WHERE window_name = ?2 AND observed_busy_at_ms IS NULL",
                params![now * 1000, w.name],
            )?;
        }
        w.state_changed_at = tx
            .query_row(
                "SELECT state_changed_at FROM windows WHERE name = ?1",
                [&w.name],
                |r| r.get::<_, i64>(0),
            )
            .ok()
            .map(|t| t as u64);
    }
    let gone: Vec<String> = {
        let mut stmt = tx.prepare("SELECT name FROM windows WHERE state != 'offline'")?;
        let names = stmt.query_map([], |r| r.get::<_, String>(0))?;
        names
            .filter_map(Result::ok)
            .filter(|n| !windows.iter().any(|w| &w.name == n))
            .collect()
    };
    for name in gone {
        tx.execute(
            "UPDATE windows SET state = 'offline', state_changed_at = ?1, updated_at = ?1 WHERE name = ?2",
            params![now, name],
        )?;
        log_event(
            &tx,
            now,
            Some(&name),
            "window",
            "state",
            &format!("{name} -> offline"),
        )?;
    }
    set_meta(&tx, "session_name", session, now)?;
    set_meta(&tx, "session_live", if live { "1" } else { "0" }, now)?;
    set_meta(&tx, "dogwatch_last_poll_at", &now.to_string(), now)?;
    tx.commit()
}

// pending -> relayed -> answered|cleared. A question is closed when it leaves
// the pane: answered if someone recorded an answer, cleared otherwise.
pub fn sync_escalations(
    conn: &mut Connection,
    pending: &[Pending],
    now: i64,
) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    let open: Vec<(i64, String, String, String, bool)> = {
        let mut stmt = tx.prepare(
            "SELECT id, window_name, fingerprint, status, answer_text IS NOT NULL FROM escalations WHERE status IN ('pending', 'relayed')",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let current: Vec<(String, &Pending)> = pending
        .iter()
        .map(|p| (fingerprint(&p.target, &p.prompt), p))
        .collect();
    for (id, window, fp, _, answered) in &open {
        if current.iter().any(|(f, p)| f == fp && &p.target == window) {
            continue;
        }
        let status = if *answered { "answered" } else { "cleared" };
        tx.execute(
            "UPDATE escalations SET status = ?1, resolved_at = ?2 WHERE id = ?3",
            params![status, now, id],
        )?;
        let summary = format!("{window}: question {status}");
        log_event(&tx, now, Some(window), "escalation", status, &summary)?;
    }
    for (fp, p) in &current {
        let known = open
            .iter()
            .find(|(_, w, f, _, _)| w == &p.target && f == fp);
        match known {
            Some((id, _, _, status, _)) if p.relayed_to_pm && status == "pending" => {
                tx.execute(
                    "UPDATE escalations SET status = 'relayed', relayed_at = ?1 WHERE id = ?2",
                    params![now, id],
                )?;
                let summary = format!("{}: question relayed to the PM", p.target);
                log_event(&tx, now, Some(&p.target), "escalation", "relayed", &summary)?;
            }
            Some(_) => {}
            None => {
                let kind = serde_json::to_value(p.prompt.prompt_type).unwrap_or_default();
                let (status, relayed_at) = if p.relayed_to_pm {
                    ("relayed", Some(now))
                } else {
                    ("pending", None)
                };
                tx.execute(
                    "INSERT INTO escalations(window_name, fingerprint, prompt_type, question, options_json, status, created_at, relayed_at) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        p.target,
                        fp,
                        kind.as_str().unwrap_or_default(),
                        p.prompt.question,
                        serde_json::to_string(&p.prompt.options).unwrap_or_default(),
                        status,
                        now,
                        relayed_at,
                    ],
                )?;
                let summary = format!("{} blocked: {}", p.target, p.prompt.question);
                log_event(&tx, now, Some(&p.target), "escalation", "blocked", &summary)?;
            }
        }
    }
    tx.commit()
}

// The answer is kept on the open question; it is closed once it leaves the pane.
pub fn record_answer(
    conn: &Connection,
    window: &str,
    text: &str,
    by: &str,
    now: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE escalations SET answer_text = ?1, answered_by = ?2 WHERE window_name = ?3 AND status IN ('pending', 'relayed')",
        params![text, by, window],
    )?;
    let summary = format!("{by} -> {window}: {text}");
    log_event(conn, now, Some(window), "escalation", "answer", &summary)
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct IssueRow {
    pub issue_id: String,
    pub sequence_id: Option<u64>,
    pub title: String,
    pub state: String,
    pub role: Option<String>,
    pub assigned_window: Option<String>,
    pub fingerprint: Option<String>,
    pub handled_state: Option<String>,
    pub delegated: bool,
    pub last_error: Option<String>,
}

pub fn sync_plane_issues(
    conn: &mut Connection,
    rows: &[IssueRow],
    now: i64,
) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    for r in rows {
        let before: Option<String> = tx
            .query_row(
                "SELECT state FROM plane_issues WHERE issue_id = ?1",
                [&r.issue_id],
                |row| row.get(0),
            )
            .optional()?;
        tx.execute(
            UPSERT_ISSUE,
            params![
                r.issue_id,
                r.sequence_id.map(|n| n as i64),
                r.title,
                r.state,
                r.role,
                r.assigned_window,
                r.fingerprint,
                r.handled_state,
                r.delegated.then_some(now),
                now,
                r.last_error,
            ],
        )?;
        let seq = r.sequence_id.map_or("?".into(), |n| n.to_string());
        let window = r.assigned_window.as_deref();
        if r.delegated {
            let summary = format!("[{seq}] delegated to {}", window.unwrap_or("?"));
            log_event(&tx, now, window, "plane", "delegated", &summary)?;
        }
        if let Some(before) = before.filter(|b| b != &r.state) {
            let summary = format!("[{seq}] {before} -> {}", r.state);
            log_event(&tx, now, window, "plane", "state", &summary)?;
        }
    }
    set_meta(&tx, "plane_dogwatch_last_poll_at", &now.to_string(), now)?;
    tx.commit()
}

// ── Watchdog ─────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Anomaly {
    pub id: i64,
    pub window_name: String,
    pub issue_id: Option<String>,
    pub kind: String,
    pub message: String,
    pub detected_at: i64,
    pub notified_to_pm_at: Option<i64>,
}

type Found = (String, Option<String>, &'static str, String);

fn found_anomalies(conn: &Connection, now: i64) -> rusqlite::Result<Vec<Found>> {
    let mut found: Vec<Found> = Vec::new();
    let mut orphan = conn.prepare(&format!(
        "SELECT w.name, p.issue_id, p.sequence_id, p.state, ?1 - w.state_changed_at FROM windows w
         JOIN (SELECT * FROM plane_issues WHERE {HELD}) p ON p.assigned_window = w.name
         WHERE w.state = 'idle' AND w.state_changed_at <= ?1 - ?2 AND COALESCE(p.delegated_at, 0) <= ?1 - ?2"
    ))?;
    let rows = orphan.query_map(params![now, ORPHAN_AFTER], |r| {
        let (name, issue, seq, state, idle): (String, String, Option<i64>, String, i64) =
            (r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?);
        let seq = seq.map_or("?".into(), |n| n.to_string());
        let message = format!(
            "{name} è idle da {idle}s ma detiene il ticket [{seq}] ({state}): verifica se ha finito o va sollecitato. Dettagli: python3 scripts/work-agent.py inspect {name}"
        );
        Ok((name, Some(issue), "orphan_ticket", message))
    })?;
    found.extend(rows.filter_map(Result::ok));

    let mut frozen = conn.prepare(
        "SELECT name, ?1 - MAX(state_changed_at, last_output_change_at) FROM windows
         WHERE state = 'working' AND MAX(state_changed_at, last_output_change_at) <= ?1 - ?2",
    )?;
    let rows = frozen.query_map(params![now, FROZEN_AFTER], |r| {
        let (name, still): (String, i64) = (r.get(0)?, r.get(1)?);
        let message = format!(
            "{name} risulta working ma il suo output è fermo da {still}s: potrebbe essere bloccato. Dettagli: python3 scripts/work-agent.py inspect {name}"
        );
        Ok((name, None, "frozen_working", message))
    })?;
    found.extend(rows.filter_map(Result::ok));

    let mut blocked = conn.prepare(
        "SELECT window_name, question, ?1 - relayed_at FROM escalations
         WHERE status = 'relayed' AND relayed_at <= ?1 - ?2",
    )?;
    let rows = blocked.query_map(params![now, BLOCKED_AFTER], |r| {
        let (name, question, waited): (String, String, i64) = (r.get(0)?, r.get(1)?, r.get(2)?);
        let message = format!(
            "{name} aspetta una risposta da {waited}s: \"{question}\". Rispondi con python3 scripts/tmux-dogwatch.py answer {name} \"<risposta>\""
        );
        Ok((name, None, "long_blocked", message))
    })?;
    found.extend(rows.filter_map(Result::ok));
    Ok(found)
}

pub fn active_anomalies(conn: &Connection) -> rusqlite::Result<Vec<Anomaly>> {
    let mut stmt = conn.prepare(
        "SELECT id, window_name, issue_id, kind, message, detected_at, notified_to_pm_at FROM anomalies WHERE resolved_at IS NULL ORDER BY id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Anomaly {
            id: r.get(0)?,
            window_name: r.get(1)?,
            issue_id: r.get(2)?,
            kind: r.get(3)?,
            message: r.get(4)?,
            detected_at: r.get(5)?,
            notified_to_pm_at: r.get(6)?,
        })
    })?;
    rows.collect()
}

// Opens a row for each new orphan_ticket / frozen_working / long_blocked and
// resolves the active ones whose condition is gone. Returns the active ones.
pub fn evaluate_anomalies(conn: &mut Connection, now: i64) -> rusqlite::Result<Vec<Anomaly>> {
    let tx = conn.transaction()?;
    let found = found_anomalies(&tx, now)?;
    let same = |a: &Anomaly, f: &Found| a.window_name == f.0 && a.issue_id == f.1 && a.kind == f.2;
    let active = active_anomalies(&tx)?;
    for a in active.iter().filter(|a| !found.iter().any(|f| same(a, f))) {
        tx.execute(
            "UPDATE anomalies SET resolved_at = ?1 WHERE id = ?2",
            params![now, a.id],
        )?;
        let summary = format!("{} resolved: {}", a.kind, a.window_name);
        log_event(
            &tx,
            now,
            Some(&a.window_name),
            "anomaly",
            "resolved",
            &summary,
        )?;
    }
    for f in found.iter().filter(|f| !active.iter().any(|a| same(a, f))) {
        tx.execute(
            "INSERT INTO anomalies(window_name, issue_id, kind, message, detected_at) VALUES(?1, ?2, ?3, ?4, ?5)",
            params![f.0, f.1, f.2, f.3, now],
        )?;
        log_event(&tx, now, Some(&f.0), "anomaly", f.2, &f.3)?;
    }
    let active = active_anomalies(&tx)?;
    tx.commit()?;
    Ok(active)
}

// One [WATCHDOG] alert per call, for the oldest anomaly the PM has not heard
// of, and only while the PM window has been idle for a few seconds.
pub fn alert_pm(
    conn: &Connection,
    now: i64,
    send: impl FnOnce(&str) -> Result<(), String>,
) -> rusqlite::Result<bool> {
    let pm_idle = conn
        .query_row(
            "SELECT 1 FROM windows WHERE lower(name) = 'pm' AND state = 'idle' AND state_changed_at <= ?1",
            [now - PM_SETTLE],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !pm_idle {
        return Ok(false);
    }
    let next: Option<(i64, String, String)> = conn
        .query_row(
            "SELECT id, window_name, message FROM anomalies WHERE resolved_at IS NULL AND notified_to_pm_at IS NULL ORDER BY id LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((id, window, message)) = next else {
        return Ok(false);
    };
    if send(&format!("[WATCHDOG] {message}")).is_err() {
        return Ok(false);
    }
    conn.execute(
        "UPDATE anomalies SET notified_to_pm_at = ?1 WHERE id = ?2",
        params![now, id],
    )?;
    let summary = format!("PM alerted about {window}");
    log_event(conn, now, Some(&window), "anomaly", "notified", &summary)?;
    Ok(true)
}

// ── Snapshot ─────────────────────────────────────────────────

fn json_rows(
    conn: &Connection,
    sql: &str,
    args: impl rusqlite::Params,
) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = conn.prepare(sql)?;
    let names: Vec<String> = stmt.column_names().into_iter().map(String::from).collect();
    let rows = stmt.query_map(args, |row| {
        let mut obj = Map::new();
        for (i, name) in names.iter().enumerate() {
            let value = match row.get_ref(i)? {
                ValueRef::Integer(n) => n.into(),
                ValueRef::Real(f) => json!(f),
                ValueRef::Text(t) => String::from_utf8_lossy(t).into(),
                ValueRef::Null | ValueRef::Blob(_) => Value::Null,
            };
            obj.insert(name.clone(), value);
        }
        Ok(Value::Object(obj))
    })?;
    rows.collect()
}

pub fn snapshot(conn: &Connection, now: i64) -> rusqlite::Result<Value> {
    let meta: Map<String, Value> = json_rows(conn, "SELECT key, value FROM meta", [])?
        .into_iter()
        .map(|r| {
            (
                r["key"].as_str().unwrap_or_default().to_string(),
                r["value"].clone(),
            )
        })
        .collect();
    let windows = json_rows(conn, "SELECT * FROM windows ORDER BY name", [])?;
    let mut roles = Map::new();
    for role in ["pm", "dev", "qa", "doc", "generic"] {
        roles.insert(role.into(), json!([]));
    }
    for w in windows.iter().filter(|w| w["state"] != "offline") {
        let role = w["role"].as_str().unwrap_or("generic");
        if let Some(Value::Array(list)) = roles.get_mut(role) {
            list.push(json!({
                "name": w["name"], "agent": w["agent"], "model": w["model"], "state": w["state"],
            }));
        }
    }
    Ok(json!({
        "now": now,
        "meta": meta,
        "roles": roles,
        "windows": windows,
        "escalations": json_rows(conn, "SELECT * FROM escalations WHERE status IN ('pending', 'relayed') ORDER BY id", [])?,
        "assignments": json_rows(conn, &format!("SELECT * FROM plane_issues WHERE assigned_window IS NOT NULL AND {HELD} ORDER BY sequence_id"), [])?,
        "anomalies": json_rows(conn, "SELECT * FROM anomalies WHERE resolved_at IS NULL ORDER BY id", [])?,
        "events": json_rows(conn, "SELECT * FROM events ORDER BY id DESC LIMIT ?1", [SNAPSHOT_EVENTS])?,
    }))
}

// The shared state of an open project; an empty one before the first look.
#[tauri::command]
pub async fn work_state_snapshot(
    roots: State<'_, Roots>,
    project: String,
) -> Result<Value, String> {
    let root = guard(&roots.get(), Path::new(&project), true)?;
    let path = root.join(DB_FILE);
    let conn = if path.is_file() {
        open(&path)?
    } else {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        configure(&conn).map_err(|e| e.to_string())?;
        conn
    };
    snapshot(&conn, now()).map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dogwatch::{Output, Prompt, PromptType};

    fn db() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join(DB_FILE)).unwrap();
        (dir, conn)
    }

    fn win(name: &str, state: AgentState, hash: &str) -> WindowState {
        WindowState {
            id: format!("@{name}"),
            name: name.into(),
            prompt: None,
            agent: Some("claude".into()),
            role: crate::dogwatch::role_of(name),
            start_command: Some(format!("claude --model m-{name}")),
            model: Some(format!("m-{name}")),
            state,
            rule: None,
            state_changed_at: None,
            last_activity_line: Some(format!("{name} line")),
            output: Output {
                hash: Some(hash.into()),
                tail: Some("a\nb".into()),
                command: Some("claude".into()),
            },
        }
    }

    fn sync(conn: &mut Connection, windows: &mut [WindowState], now: i64) {
        sync_windows(conn, "work_t", true, windows, now).unwrap();
    }

    fn one<T: rusqlite::types::FromSql>(conn: &Connection, sql: &str) -> T {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    fn pending(target: &str, question: &str, relayed: bool) -> Pending {
        Pending {
            target: target.into(),
            prompt: Prompt {
                prompt_type: PromptType::Confirmation,
                question: question.into(),
                options: vec!["Yes".into(), "No".into()],
            },
            relayed_to_pm: relayed,
        }
    }

    fn held(window: &str, state: &str, delegated: bool) -> IssueRow {
        IssueRow {
            issue_id: "i-1".into(),
            sequence_id: Some(7),
            title: "T".into(),
            state: state.into(),
            role: Some("dev".into()),
            assigned_window: Some(window.into()),
            delegated,
            ..Default::default()
        }
    }

    fn kinds(active: &[Anomaly]) -> Vec<(String, String)> {
        active
            .iter()
            .map(|a| (a.window_name.clone(), a.kind.clone()))
            .collect()
    }

    #[test]
    fn the_database_is_wal_with_every_table_and_a_schema_version() {
        let (_dir, conn) = db();
        let mode: String = one(&conn, "PRAGMA journal_mode");
        assert_eq!(mode, "wal");
        let busy: i64 = one(&conn, "PRAGMA busy_timeout");
        assert_eq!(busy, 5000);
        let fk: i64 = one(&conn, "PRAGMA foreign_keys");
        assert_eq!(fk, 1);
        for table in [
            "meta",
            "windows",
            "escalations",
            "plane_issues",
            "prompt_barriers",
            "events",
            "anomalies",
        ] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "{table}");
        }
        let version: String = one(&conn, "SELECT value FROM meta WHERE key = 'schema_version'");
        assert_eq!(version, SCHEMA_VERSION);
        let pruned: String = one(
            &conn,
            "SELECT value FROM meta WHERE key = 'opencode_last_prune_at'",
        );
        assert_eq!(pruned, "0", "present before the first prune");
    }

    #[test]
    fn an_old_database_gets_the_role_columns_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let old = Connection::open(&path).unwrap();
        old.execute_batch(
            "CREATE TABLE windows(name TEXT PRIMARY KEY, window_id TEXT, session TEXT, agent TEXT, state TEXT NOT NULL, rule TEXT, state_changed_at INTEGER NOT NULL, last_output_change_at INTEGER NOT NULL, output_hash TEXT, last_activity_line TEXT, tail_preview TEXT, current_command TEXT, updated_at INTEGER NOT NULL);
             INSERT INTO windows(name, state, state_changed_at, last_output_change_at, updated_at) VALUES('dev1', 'idle', 1, 1, 1);
             CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
             INSERT INTO meta VALUES('schema_version', '1', 1);",
        )
        .unwrap();
        drop(old);
        let conn = open(&path).unwrap();
        drop(open(&path).unwrap());
        let role: String = one(&conn, "SELECT role FROM windows WHERE name = 'dev1'");
        assert_eq!(role, "generic", "old rows get the default");
        let version: String = one(&conn, "SELECT value FROM meta WHERE key = 'schema_version'");
        assert_eq!(version, SCHEMA_VERSION);
        let mut conn = conn;
        sync(&mut conn, &mut [win("dev1", AgentState::Idle, "h")], 5);
        let row: (String, String, String) = conn
            .query_row(
                "SELECT role, start_command, model FROM windows WHERE name = 'dev1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            row,
            (
                "dev".into(),
                "claude --model m-dev1".into(),
                "m-dev1".into()
            )
        );
    }

    #[test]
    fn the_snapshot_groups_live_windows_by_role() {
        let (_dir, mut conn) = db();
        sync(
            &mut conn,
            &mut [
                win("dev1", AgentState::Working, "h"),
                win("qa1", AgentState::Idle, "h"),
                win("agent1", AgentState::Idle, "h"),
            ],
            0,
        );
        sync(
            &mut conn,
            &mut [
                win("dev1", AgentState::Working, "h"),
                win("qa1", AgentState::Idle, "h"),
            ],
            1,
        );
        let snap = snapshot(&conn, 1).unwrap();
        assert_eq!(
            snap["roles"]["dev"],
            json!([{ "name": "dev1", "agent": "claude", "model": "m-dev1", "state": "working" }])
        );
        assert_eq!(snap["roles"]["qa"][0]["name"], "qa1");
        assert_eq!(snap["roles"]["generic"], json!([]), "agent1 went offline");
        assert_eq!(snap["roles"]["pm"], json!([]));
    }

    #[test]
    fn state_changed_at_holds_until_the_state_changes_and_each_change_is_an_event() {
        let (_dir, mut conn) = db();
        let mut w = [win("dev1", AgentState::Working, "h1")];
        sync(&mut conn, &mut w, 100);
        assert_eq!(w[0].state_changed_at, Some(100));
        sync(&mut conn, &mut w, 130);
        assert_eq!(w[0].state_changed_at, Some(100), "same state, same start");

        let mut w = [win("dev1", AgentState::Idle, "h1")];
        sync(&mut conn, &mut w, 160);
        assert_eq!(w[0].state_changed_at, Some(160));
        let events: Vec<String> = json_rows(&conn, "SELECT summary FROM events ORDER BY id", [])
            .unwrap()
            .into_iter()
            .map(|r| r["summary"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(events, ["dev1 new -> working", "dev1 working -> idle"]);
        let line: String = one(&conn, "SELECT last_activity_line FROM windows");
        assert_eq!(line, "dev1 line");
        let live: String = one(&conn, "SELECT value FROM meta WHERE key = 'session_live'");
        assert_eq!(live, "1");
    }

    #[test]
    fn the_output_clock_moves_only_with_the_hash() {
        let (_dir, mut conn) = db();
        sync(
            &mut conn,
            &mut [win("dev1", AgentState::Working, "h1")],
            100,
        );
        sync(
            &mut conn,
            &mut [win("dev1", AgentState::Working, "h1")],
            150,
        );
        let at: i64 = one(&conn, "SELECT last_output_change_at FROM windows");
        assert_eq!(at, 100);
        sync(
            &mut conn,
            &mut [win("dev1", AgentState::Working, "h2")],
            200,
        );
        let at: i64 = one(&conn, "SELECT last_output_change_at FROM windows");
        assert_eq!(at, 200);
    }

    #[test]
    fn a_window_that_leaves_the_session_goes_offline() {
        let (_dir, mut conn) = db();
        sync(
            &mut conn,
            &mut [
                win("dev1", AgentState::Idle, "h"),
                win("qa1", AgentState::Idle, "h"),
            ],
            100,
        );
        sync(&mut conn, &mut [win("dev1", AgentState::Idle, "h")], 110);
        let state: String = one(&conn, "SELECT state FROM windows WHERE name = 'qa1'");
        assert_eq!(state, "offline");
        let at: i64 = one(
            &conn,
            "SELECT state_changed_at FROM windows WHERE name = 'qa1'",
        );
        assert_eq!(at, 110);
    }

    #[test]
    fn the_event_ring_buffer_keeps_the_newest_thousand() {
        let (_dir, conn) = db();
        for i in 0..1005 {
            log_event(&conn, i, None, "test", "tick", &format!("e{i}")).unwrap();
        }
        let n: i64 = one(&conn, "SELECT COUNT(*) FROM events");
        assert_eq!(n, 1000);
        let first: String = one(&conn, "SELECT summary FROM events ORDER BY id LIMIT 1");
        assert_eq!(first, "e5");
    }

    #[test]
    fn an_escalation_goes_pending_relayed_then_answered_or_cleared() {
        let (_dir, mut conn) = db();
        sync_escalations(&mut conn, &[pending("dev1", "Go?", false)], 100).unwrap();
        sync_escalations(&mut conn, &[pending("dev1", "Go?", true)], 110).unwrap();
        let (status, relayed): (String, i64) = conn
            .query_row("SELECT status, relayed_at FROM escalations", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!((status.as_str(), relayed), ("relayed", 110));

        record_answer(&conn, "dev1", "yes", "pm", 120).unwrap();
        sync_escalations(&mut conn, &[pending("dev1", "Go?", true)], 125).unwrap();
        let n: i64 = one(&conn, "SELECT COUNT(*) FROM escalations");
        assert_eq!(n, 1, "the same question still on screen is not a new one");
        sync_escalations(&mut conn, &[], 130).unwrap();
        let row: (String, i64, String) = conn
            .query_row(
                "SELECT status, resolved_at, answered_by FROM escalations",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(row, ("answered".into(), 130, "pm".into()));

        sync_escalations(&mut conn, &[pending("qa1", "Deploy?", false)], 140).unwrap();
        sync_escalations(&mut conn, &[], 150).unwrap();
        let status: String = one(
            &conn,
            "SELECT status FROM escalations WHERE window_name = 'qa1'",
        );
        assert_eq!(status, "cleared");
    }

    #[test]
    fn plane_issues_keep_delegation_time_and_log_state_moves() {
        let (_dir, mut conn) = db();
        sync_plane_issues(&mut conn, &[held("dev1", "In Progress", true)], 100).unwrap();
        sync_plane_issues(&mut conn, &[held("dev1", "In Progress", false)], 200).unwrap();
        let at: i64 = one(&conn, "SELECT delegated_at FROM plane_issues");
        assert_eq!(at, 100);
        sync_plane_issues(&mut conn, &[held("dev1", "Test", false)], 300).unwrap();
        let at: i64 = one(&conn, "SELECT state_updated_at FROM plane_issues");
        assert_eq!(at, 300);
        let kinds: Vec<String> = json_rows(
            &conn,
            "SELECT kind FROM events WHERE category = 'plane' ORDER BY id",
            [],
        )
        .unwrap()
        .into_iter()
        .map(|r| r["kind"].as_str().unwrap().to_string())
        .collect();
        assert_eq!(kinds, ["delegated", "state"]);
    }

    #[test]
    fn an_idle_window_holding_a_ticket_becomes_an_orphan_then_resolves() {
        let (_dir, mut conn) = db();
        sync_plane_issues(&mut conn, &[held("dev1", "In Progress", true)], 0).unwrap();
        sync(&mut conn, &mut [win("dev1", AgentState::Idle, "h")], 10);
        assert!(
            evaluate_anomalies(&mut conn, 90).unwrap().is_empty(),
            "idle 80s"
        );
        let active = evaluate_anomalies(&mut conn, 101).unwrap();
        assert_eq!(kinds(&active), [("dev1".into(), "orphan_ticket".into())]);
        assert_eq!(active[0].issue_id.as_deref(), Some("i-1"));
        assert!(active[0].message.contains("[7]"));
        assert_eq!(
            evaluate_anomalies(&mut conn, 120).unwrap(),
            active,
            "one row, not one per look"
        );

        sync(&mut conn, &mut [win("dev1", AgentState::Working, "h")], 130);
        assert!(evaluate_anomalies(&mut conn, 131).unwrap().is_empty());
        let resolved: i64 = one(&conn, "SELECT resolved_at FROM anomalies");
        assert_eq!(resolved, 131);
    }

    #[test]
    fn a_ticket_out_of_its_working_state_is_not_an_orphan() {
        let (_dir, mut conn) = db();
        sync_plane_issues(&mut conn, &[held("dev1", "Test", true)], 0).unwrap();
        sync(&mut conn, &mut [win("dev1", AgentState::Idle, "h")], 0);
        assert!(evaluate_anomalies(&mut conn, 500).unwrap().is_empty());
    }

    #[test]
    fn a_working_window_with_still_output_is_frozen() {
        let (_dir, mut conn) = db();
        sync(&mut conn, &mut [win("dev1", AgentState::Working, "h")], 0);
        assert!(evaluate_anomalies(&mut conn, 299).unwrap().is_empty());
        let active = evaluate_anomalies(&mut conn, 300).unwrap();
        assert_eq!(kinds(&active), [("dev1".into(), "frozen_working".into())]);

        sync(
            &mut conn,
            &mut [win("dev1", AgentState::Working, "h2")],
            310,
        );
        assert!(evaluate_anomalies(&mut conn, 311).unwrap().is_empty());
    }

    #[test]
    fn a_window_that_starts_working_is_not_frozen_by_its_idle_past() {
        let (_dir, mut conn) = db();
        sync(&mut conn, &mut [win("dev1", AgentState::Idle, "h")], 0);
        sync(
            &mut conn,
            &mut [win("dev1", AgentState::Working, "h")],
            1000,
        );
        assert!(evaluate_anomalies(&mut conn, 1010).unwrap().is_empty());
    }

    #[test]
    fn a_relayed_question_left_unanswered_is_long_blocked() {
        let (_dir, mut conn) = db();
        sync_escalations(&mut conn, &[pending("qa1", "Deploy?", true)], 0).unwrap();
        assert!(evaluate_anomalies(&mut conn, 179).unwrap().is_empty());
        let active = evaluate_anomalies(&mut conn, 180).unwrap();
        assert_eq!(kinds(&active), [("qa1".into(), "long_blocked".into())]);
        assert!(active[0].message.contains("Deploy?"));

        sync_escalations(&mut conn, &[], 200).unwrap();
        assert!(evaluate_anomalies(&mut conn, 201).unwrap().is_empty());
    }

    #[test]
    fn the_pm_hears_of_each_anomaly_once_and_only_while_idle() {
        let (_dir, mut conn) = db();
        sync(
            &mut conn,
            &mut [
                win("dev1", AgentState::Working, "h"),
                win("pm", AgentState::Blocked, "p"),
            ],
            0,
        );
        evaluate_anomalies(&mut conn, 400).unwrap();
        let mut sent = Vec::new();
        assert!(!alert_pm(&conn, 400, |t| {
            sent.push(t.to_string());
            Ok(())
        })
        .unwrap());

        sync(
            &mut conn,
            &mut [
                win("dev1", AgentState::Working, "h"),
                win("pm", AgentState::Idle, "p"),
            ],
            400,
        );
        assert!(
            !alert_pm(&conn, 402, |_| Ok(())).unwrap(),
            "the PM just went idle"
        );
        assert!(alert_pm(&conn, 410, |t| {
            sent.push(t.to_string());
            Ok(())
        })
        .unwrap());
        assert!(!alert_pm(&conn, 420, |t| {
            sent.push(t.to_string());
            Ok(())
        })
        .unwrap());
        assert_eq!(sent.len(), 1);
        assert!(sent[0].starts_with("[WATCHDOG] dev1 risulta working"));
        let notified: i64 = one(&conn, "SELECT notified_to_pm_at FROM anomalies");
        assert_eq!(notified, 410);
    }

    #[test]
    fn the_snapshot_lists_windows_open_questions_tickets_and_anomalies() {
        let (_dir, mut conn) = db();
        sync(&mut conn, &mut [win("dev1", AgentState::Idle, "h")], 0);
        sync_plane_issues(&mut conn, &[held("dev1", "In Progress", true)], 0).unwrap();
        sync_escalations(&mut conn, &[pending("dev1", "Go?", false)], 0).unwrap();
        evaluate_anomalies(&mut conn, 100).unwrap();
        let snap = snapshot(&conn, 100).unwrap();
        assert_eq!(snap["meta"]["session_name"], "work_t");
        assert_eq!(snap["windows"][0]["name"], "dev1");
        assert_eq!(snap["windows"][0]["state_changed_at"], 0);
        assert_eq!(snap["escalations"][0]["question"], "Go?");
        assert_eq!(snap["assignments"][0]["sequence_id"], 7);
        assert_eq!(snap["anomalies"][0]["kind"], "orphan_ticket");
        assert!(!snap["events"].as_array().unwrap().is_empty());
    }

    #[test]
    fn a_prompt_barrier_is_marked_busy_when_the_target_works() {
        let (_dir, mut conn) = db();
        conn.execute(
            "INSERT INTO prompt_barriers(window_name, session, sent_at_ms) VALUES('dev1', 'work_t', 1000)",
            [],
        )
        .unwrap();
        sync(&mut conn, &mut [win("dev1", AgentState::Idle, "h")], 1);
        let seen: Option<i64> = one(&conn, "SELECT observed_busy_at_ms FROM prompt_barriers");
        assert_eq!(seen, None);
        sync(&mut conn, &mut [win("dev1", AgentState::Working, "h")], 2);
        let seen: Option<i64> = one(&conn, "SELECT observed_busy_at_ms FROM prompt_barriers");
        assert_eq!(seen, Some(2000));
    }
}
