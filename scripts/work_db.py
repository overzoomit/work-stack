"""work_db: the team's shared state in .claude/work.db (SQLite, WAL).

The Python side of src-tauri/src/state_db.rs: same schema, same upserts, same
cleaned-output hash, so the scripts and Work can write the same file. Every
writer here is best effort: callers wrap them in `safely`, and a broken or
locked database never stops a dogwatch cycle.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import re
import sqlite3
import time
from pathlib import Path

DB_FILE = Path(".claude") / "work.db"
SCHEMA_VERSION = "2"
MAX_EVENTS = 1000
TAIL_PREVIEW = 8
ACTIVITY_CHARS = 200

# Keep in step with SCHEMA in src-tauri/src/state_db.rs.
SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS windows(name TEXT PRIMARY KEY, window_id TEXT, session TEXT, agent TEXT, state TEXT NOT NULL, rule TEXT, state_changed_at INTEGER NOT NULL, last_output_change_at INTEGER NOT NULL, output_hash TEXT, last_activity_line TEXT, tail_preview TEXT, current_command TEXT, updated_at INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'generic', start_command TEXT, model TEXT);
CREATE TABLE IF NOT EXISTS escalations(id INTEGER PRIMARY KEY AUTOINCREMENT, window_name TEXT NOT NULL, fingerprint TEXT NOT NULL, prompt_type TEXT NOT NULL, question TEXT NOT NULL, options_json TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, relayed_at INTEGER, resolved_at INTEGER, answer_text TEXT, answered_by TEXT);
CREATE TABLE IF NOT EXISTS plane_issues(issue_id TEXT PRIMARY KEY, sequence_id INTEGER, title TEXT, state TEXT NOT NULL, role TEXT, assigned_window TEXT, fingerprint TEXT, handled_state TEXT, delegated_at INTEGER, state_updated_at INTEGER, last_error TEXT);
CREATE TABLE IF NOT EXISTS prompt_barriers(window_name TEXT PRIMARY KEY, session TEXT, sender TEXT, instruction_preview TEXT, sent_at_ms INTEGER NOT NULL, observed_busy_at_ms INTEGER);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, window_name TEXT, category TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, details_json TEXT);
CREATE TABLE IF NOT EXISTS anomalies(id INTEGER PRIMARY KEY AUTOINCREMENT, window_name TEXT NOT NULL, issue_id TEXT, kind TEXT NOT NULL, message TEXT NOT NULL, detected_at INTEGER NOT NULL, notified_to_pm_at INTEGER, resolved_at INTEGER);
"""

# Columns added after schema 1 (WINDOW_COLUMNS in state_db.rs).
WINDOW_COLUMNS = (("role", "TEXT NOT NULL DEFAULT 'generic'"), ("start_command", "TEXT"), ("model", "TEXT"))

UPSERT_WINDOW = """
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
  updated_at = excluded.updated_at
"""

UPSERT_ISSUE = """
INSERT INTO plane_issues(issue_id, sequence_id, title, state, role, assigned_window, fingerprint, handled_state, delegated_at, state_updated_at, last_error)
VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, COALESCE(?9, CASE WHEN ?6 IS NOT NULL THEN ?10 END), ?10, ?11)
ON CONFLICT(issue_id) DO UPDATE SET
  sequence_id = excluded.sequence_id, title = excluded.title, role = excluded.role,
  assigned_window = excluded.assigned_window, fingerprint = excluded.fingerprint, handled_state = excluded.handled_state,
  delegated_at = CASE WHEN ?9 IS NOT NULL THEN ?9 ELSE COALESCE(plane_issues.delegated_at, excluded.delegated_at) END,
  last_error = CASE WHEN ?9 IS NOT NULL THEN excluded.last_error ELSE COALESCE(excluded.last_error, plane_issues.last_error) END,
  state_updated_at = CASE WHEN plane_issues.state = excluded.state THEN plane_issues.state_updated_at ELSE excluded.state_updated_at END,
  state = excluded.state
"""

HELD = "((role = 'dev' AND lower(state) = 'in progress') OR (role = 'qa' AND lower(state) = 'test'))"
# The standby ping every new worker sends (READY_PING in state_db.rs).
READY_PING = "Sono pronto e a disposizione del PM"

# The chrome dogwatch.rs leaves out of the hash (is_chrome + is_spinner there).
# capture-pane -p carries no escapes; a stub or `-e` capture might.
ANSI_ESCAPE = re.compile(r"\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
BOX_TRIM = re.compile(r"^[\s│]+|[\s│]+$")
NUMBERED_OPTION = re.compile(r"^(?:[❯>]\s*)?\d+[.)]\s+\S")
BARE_FLAG = re.compile(r"^(?:\[[^\]]+\]|\([^)]+\))$")
INPUT_MARKERS = ("❯", ">", "$", "%", "#", "›")
BOX_CHARS = set("╭╰╮╯─┌└┐┘")
HINTS = ("esc to ", "enter to ", "tab to ", "ctrl+c to ", "ctrl-c to ")
SPINNER_CHARS = set("·✢✳✶✻✽")


def now() -> int:
    return int(time.time())


def db_path(root: Path) -> Path:
    return root / DB_FILE


def connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=5, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SCHEMA)
    migrate(conn)
    # opencode_last_prune_at is "0" until the first OpenCode prune.
    conn.execute(
        "INSERT OR IGNORE INTO meta(key, value, updated_at) VALUES('schema_version', ?1, ?2), ('opencode_last_prune_at', '0', ?2)",
        (SCHEMA_VERSION, now()),
    )
    return conn


def migrate(conn: sqlite3.Connection) -> None:
    """Add the newer windows columns to an old database; idempotent."""
    present = {row[1] for row in conn.execute("PRAGMA table_info(windows)")}
    for column, ddl in WINDOW_COLUMNS:
        if column in present:
            continue
        try:
            conn.execute(f"ALTER TABLE windows ADD COLUMN {column} {ddl}")
        except sqlite3.OperationalError as exc:
            if "duplicate column" not in str(exc):
                raise
    set_meta(conn, "schema_version", SCHEMA_VERSION, now())


def role_of(name: str) -> str:
    """pm, dev, qa, doc or generic (role_of in dogwatch.rs)."""
    name = name.lower()
    if name == "pm":
        return "pm"
    if re.fullmatch(r"dev\d+", name):
        return "dev"
    if re.fullmatch(r"qa\d*", name):
        return "qa"
    if re.fullmatch(r"doc\d*", name):
        return "doc"
    return "generic"


@contextlib.contextmanager
def transaction(conn: sqlite3.Connection):
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")


def safely(path: Path, write) -> None:
    """Run write(conn) on the database at path; any database error is ignored."""
    try:
        conn = connect(path)
    except (sqlite3.Error, OSError):
        return
    try:
        write(conn)
    except sqlite3.Error:
        pass
    finally:
        conn.close()


def set_meta(conn: sqlite3.Connection, key: str, value: str, stamp: int) -> None:
    conn.execute(
        "INSERT INTO meta(key, value, updated_at) VALUES(?, ?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        (key, value, stamp),
    )


def clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else f"{text[:limit]}…"


def log_event(conn: sqlite3.Connection, stamp: int, window: str | None, category: str, kind: str, summary: str) -> None:
    conn.execute(
        "INSERT INTO events(timestamp, window_name, category, kind, summary) VALUES(?, ?, ?, ?, ?)",
        (stamp, window, category, kind, clip(summary, 300)),
    )
    conn.execute("DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ?", (MAX_EVENTS,))


# ── Cleaned output ───────────────────────────────────────────


def _is_chrome(line: str) -> bool:
    lower = line.lower()
    marker = line in INPUT_MARKERS or (len(line) <= 3 and line[0] in INPUT_MARKERS)
    return bool(
        NUMBERED_OPTION.match(line)
        or BARE_FLAG.match(line)
        or marker
        or lower in ("ask anything...", "chat ·", "build ·")
        or all(c in BOX_CHARS for c in line)
        or any(h in lower for h in HINTS)
    )


def _is_spinner(line: str) -> bool:
    return "⠀" <= line[0] <= "⣿" or line[0] in SPINNER_CHARS


def activity(text: str) -> dict[str, str | None]:
    """The last meaningful line, the SHA-256 of the cleaned output, its last lines."""
    lines = [BOX_TRIM.sub("", raw) for raw in ANSI_ESCAPE.sub("", text).splitlines()]
    lines = [line for line in lines if line and not _is_chrome(line) and not _is_spinner(line)]
    return {
        "last_activity_line": clip(lines[-1], ACTIVITY_CHARS) if lines else None,
        "output_hash": hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest(),
        "tail_preview": "\n".join(lines[-TAIL_PREVIEW:]),
    }


# ── Writers ──────────────────────────────────────────────────


def drop_window(conn: sqlite3.Connection, name: str, stamp: int) -> None:
    """A team member that left: its row goes, with what was still open for it."""
    conn.execute("DELETE FROM windows WHERE name = ?", (name,))
    conn.execute("UPDATE anomalies SET resolved_at = ? WHERE window_name = ? AND resolved_at IS NULL", (stamp, name))
    conn.execute(
        "UPDATE escalations SET status = 'cleared', resolved_at = ? WHERE window_name = ? AND status IN ('pending', 'relayed')",
        (stamp, name),
    )
    conn.execute("DELETE FROM prompt_barriers WHERE lower(window_name) = lower(?)", (name,))
    conn.execute("UPDATE plane_issues SET assigned_window = NULL WHERE assigned_window = ?", (name,))
    log_event(conn, stamp, name, "team", "removed", f"{name} removed from team")


def stays_ready(conn: sqlite3.Connection, w: dict, before: str | None) -> bool:
    """Idle with no ticket, once registered as ready or after the standby ping."""
    if w.get("state", "idle") != "idle":
        return False
    pinged = any(READY_PING in str(w.get(k) or "") for k in ("tail_preview", "last_activity_line"))
    if before != "ready" and not pinged:
        return False
    held = conn.execute(f"SELECT 1 FROM plane_issues WHERE assigned_window = ? AND {HELD}", (str(w["name"]),)).fetchone()
    return held is None


def sync_windows(conn: sqlite3.Connection, session: str, windows: list[dict], live: bool = True, stamp: int | None = None) -> None:
    """Upsert every agent window, log each transition, drop the ones that left the session."""
    stamp = now() if stamp is None else stamp
    with transaction(conn):
        for w in windows:
            name = str(w["name"])
            row = conn.execute("SELECT state FROM windows WHERE name = ?", (name,)).fetchone()
            if stays_ready(conn, w, row["state"] if row else None):
                w["state"] = "ready"
            state = str(w.get("state") or "idle")
            conn.execute(
                UPSERT_WINDOW,
                (
                    name, w.get("id"), session, w.get("agent"), state, w.get("rule"), stamp,
                    w.get("output_hash"), w.get("last_activity_line"), w.get("tail_preview"), w.get("current_command"),
                    w.get("role") or role_of(name), w.get("start_command"), w.get("model"),
                ),
            )
            before = row["state"] if row else None
            if before != state:
                log_event(conn, stamp, name, "window", "state", f"{name} {before or 'new'} -> {state}")
            if state in ("working", "blocked"):
                conn.execute(
                    "UPDATE prompt_barriers SET observed_busy_at_ms = ? WHERE window_name = ? AND observed_busy_at_ms IS NULL",
                    (stamp * 1000, name),
                )
            changed = conn.execute("SELECT state_changed_at FROM windows WHERE name = ?", (name,)).fetchone()
            w["state_changed_at"] = changed["state_changed_at"]
        names = {str(w["name"]) for w in windows}
        for row in conn.execute("SELECT name FROM windows").fetchall():
            if row["name"] not in names:
                drop_window(conn, row["name"], stamp)
        set_meta(conn, "session_name", session, stamp)
        set_meta(conn, "session_live", "1" if live else "0", stamp)
        set_meta(conn, "dogwatch_last_poll_at", str(stamp), stamp)


def sync_escalations(conn: sqlite3.Connection, pending: list[dict], fingerprint, stamp: int | None = None) -> None:
    """pending -> relayed -> answered|cleared, like state_db::sync_escalations."""
    stamp = now() if stamp is None else stamp
    with transaction(conn):
        open_rows = conn.execute(
            "SELECT id, window_name, fingerprint, status, answer_text FROM escalations WHERE status IN ('pending', 'relayed')"
        ).fetchall()
        current = [(fingerprint(str(p["target"]), p), p) for p in pending]
        for row in open_rows:
            if any(fp == row["fingerprint"] and str(p["target"]) == row["window_name"] for fp, p in current):
                continue
            status = "answered" if row["answer_text"] is not None else "cleared"
            conn.execute("UPDATE escalations SET status = ?, resolved_at = ? WHERE id = ?", (status, stamp, row["id"]))
            log_event(conn, stamp, row["window_name"], "escalation", status, f"{row['window_name']}: question {status}")
        for fp, p in current:
            target = str(p["target"])
            known = next((r for r in open_rows if r["window_name"] == target and r["fingerprint"] == fp), None)
            relayed = bool(p.get("relayed_to_pm"))
            if known is not None:
                if relayed and known["status"] == "pending":
                    conn.execute("UPDATE escalations SET status = 'relayed', relayed_at = ? WHERE id = ?", (stamp, known["id"]))
                    log_event(conn, stamp, target, "escalation", "relayed", f"{target}: question relayed to the PM")
                continue
            conn.execute(
                "INSERT INTO escalations(window_name, fingerprint, prompt_type, question, options_json, status, created_at, relayed_at) "
                "VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    target, fp, str(p.get("prompt_type", "")), str(p.get("question", "")),
                    json.dumps(list(p.get("options", [])), ensure_ascii=False),
                    "relayed" if relayed else "pending", stamp, stamp if relayed else None,
                ),
            )
            log_event(conn, stamp, target, "escalation", "blocked", f"{target} blocked: {p.get('question', '')}")


def record_answer(conn: sqlite3.Connection, window: str, text: str, by: str, stamp: int | None = None) -> None:
    stamp = now() if stamp is None else stamp
    conn.execute(
        "UPDATE escalations SET answer_text = ?, answered_by = ? WHERE window_name = ? AND status IN ('pending', 'relayed')",
        (text, by, window),
    )
    log_event(conn, stamp, window, "escalation", "answer", f"{by} -> {window}: {text}")


def sync_plane_issues(conn: sqlite3.Connection, rows: list[dict], stamp: int | None = None) -> None:
    """rows: issue_id, sequence_id, title, state, role, assigned_window, fingerprint, handled_state, delegated, last_error."""
    stamp = now() if stamp is None else stamp
    with transaction(conn):
        for r in rows:
            before = conn.execute("SELECT state FROM plane_issues WHERE issue_id = ?", (r["issue_id"],)).fetchone()
            conn.execute(
                UPSERT_ISSUE,
                (
                    r["issue_id"], r.get("sequence_id"), r.get("title"), r["state"], r.get("role"),
                    r.get("assigned_window"), r.get("fingerprint"), r.get("handled_state"),
                    stamp if r.get("delegated") else None, stamp, r.get("last_error"),
                ),
            )
            seq = r.get("sequence_id") if r.get("sequence_id") is not None else "?"
            window = r.get("assigned_window")
            if r.get("delegated"):
                log_event(conn, stamp, window, "plane", "delegated", f"[{seq}] delegated to {window or '?'}")
            if before is not None and before["state"] != r["state"]:
                log_event(conn, stamp, window, "plane", "state", f"[{seq}] {before['state']} -> {r['state']}")
        set_meta(conn, "plane_dogwatch_last_poll_at", str(stamp), stamp)


def ticket_workers(conn: sqlite3.Connection, sequence_id: int) -> list[str]:
    """The windows a ticket was delegated to, in delegation order.

    shortcut: read from the events ring buffer (MAX_EVENTS rows), so a delegation
    older than the buffer is missed; a per-ticket history table would keep it.
    """
    rows = conn.execute(
        "SELECT window_name FROM events WHERE category = 'plane' AND kind = 'delegated' "
        "AND window_name IS NOT NULL AND summary LIKE ? GROUP BY window_name ORDER BY MIN(id)",
        (f"[{sequence_id}] delegated to %",),
    )
    return [row[0] for row in rows]


def window_state(conn: sqlite3.Connection, name: str) -> str | None:
    row = conn.execute("SELECT state FROM windows WHERE name = ?", (name,)).fetchone()
    return row[0] if row else None


def set_barrier(conn: sqlite3.Connection, session: str, window: str, sender: str | None, instruction: str) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO prompt_barriers(window_name, session, sender, instruction_preview, sent_at_ms, observed_busy_at_ms) "
        "VALUES(?, ?, ?, ?, ?, NULL)",
        (window.lower(), session, sender, clip(instruction, 200), int(time.time() * 1000)),
    )


def barrier(conn: sqlite3.Connection, window: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM prompt_barriers WHERE window_name = ?", (window.lower(),)).fetchone()


def mark_busy(conn: sqlite3.Connection, window: str) -> None:
    conn.execute(
        "UPDATE prompt_barriers SET observed_busy_at_ms = ? WHERE window_name = ? AND observed_busy_at_ms IS NULL",
        (int(time.time() * 1000), window.lower()),
    )


def clear_barrier(conn: sqlite3.Connection, window: str) -> None:
    conn.execute("DELETE FROM prompt_barriers WHERE window_name = ?", (window.lower(),))


# ── Readers for the PM (work-agent status / log / inspect) ──


def _dicts(cursor) -> list[dict]:
    return [dict(row) for row in cursor.fetchall()]


def windows(conn: sqlite3.Connection) -> list[dict]:
    return _dicts(conn.execute("SELECT * FROM windows ORDER BY name"))


def assignments(conn: sqlite3.Connection) -> list[dict]:
    return _dicts(conn.execute(f"SELECT * FROM plane_issues WHERE assigned_window IS NOT NULL AND {HELD} ORDER BY sequence_id"))


def open_escalations(conn: sqlite3.Connection) -> list[dict]:
    return _dicts(conn.execute("SELECT * FROM escalations WHERE status IN ('pending', 'relayed') ORDER BY id"))


def active_anomalies(conn: sqlite3.Connection) -> list[dict]:
    return _dicts(conn.execute("SELECT * FROM anomalies WHERE resolved_at IS NULL ORDER BY id"))


def events(conn: sqlite3.Connection, window: str | None = None, limit: int = 20) -> list[dict]:
    """The newest events, oldest first."""
    if window:
        rows = conn.execute(
            "SELECT * FROM events WHERE lower(window_name) = lower(?) ORDER BY id DESC LIMIT ?", (window, limit)
        )
    else:
        rows = conn.execute("SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,))
    return list(reversed(_dicts(rows)))


def meta(conn: sqlite3.Connection) -> dict[str, str]:
    return {row["key"]: row["value"] for row in conn.execute("SELECT key, value FROM meta")}
