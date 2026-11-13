#!/usr/bin/env python3
"""work-agent: deterministic coordination between Work's tmux agents.

The CLI is meant to be called from inside a terminal or an agent window of a
Work project. It reads the shared Dogwatch snapshot
(.claude/dogwatch_state.json) instead of polling tmux panes, so waiting for a
colleague does not add noise to the terminal.

Commands:
    work-agent list [--role ROLE] [--agent ID]
    work-agent prompt [--clean|--no-clean] [--require-agent ID] <window|role> "<instruction>"
    work-agent wait [--clean] <target_role> [--until blocked|idle|done] [--timeout SEC]
    work-agent read <target_role> [--lines N] [--clean]
    work-agent status [--role ROLE] [--agent ID] [--json]
    work-agent log [--window W] [--limit N] [--json]
    work-agent inspect <window> [--json]

status, log and inspect read the shared database .claude/work.db.

Exit codes: 0 success, 1 error, 2 timeout.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import NoReturn

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import work_db  # noqa: E402

DEFAULT_STATE = Path(".claude") / "dogwatch_state.json"
WAIT_POLL = 0.2
DEFAULT_TIMEOUT = 300.0
# status refreshes from tmux when no dogwatch wrote the database for this long.
STALE_POLL = 60
# Local marker written by `prompt` and read by `wait`: it closes the race where
# an idle snapshot taken before the agent starts would look like "done".
PROMPT_MARKS = "work-agent_prompts.json"
PROMPT_MARK_TTL = 3600.0
# Only a prompt issued moments ago needs the "watch it start first" barrier;
# an old marker must not make a later wait hang on an agent that already ran.
PROMPT_BARRIER = 60.0
PLAIN_SESSION = re.compile(r"^[A-Za-z0-9_-]+$")
PTY_CLIENT = re.compile(r"_pty_\d+$")
# OpenCode's TUI (also when started through `ollama launch opencode`) resets
# with /new, whose documented alias is /clear. One active session per task.
OPENCODE_AGENTS = {"opencode", "ollama"}
OPENCODE_RESET = "/new"
# Claude Code, Codex and Gemini start a fresh conversation with /clear.
CLEAR_RESET = "/clear"
# Give the TUI a moment to open the fresh session before typing the task.
RESET_SETTLE = float(os.environ.get("WORK_AGENT_RESET_SETTLE", "0.4"))

# CSI / OSC / single-character escapes emitted by terminal UIs.
ANSI_ESCAPE = re.compile(
    r"\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))"
)
BOX_ONLY = re.compile(r"^\s*[│┃|╭╰╮╯─┌└┐┘]+\s*$")
BOX_EDGE = re.compile(r"^[ \t│┃|]+(?=\S)|[ \t│┃|]+$")
SPINNER_ONLY = re.compile(r"^\s*[\u2800-\u28ff]+\s*$")
STATUS_CHROME = re.compile(
    r"^\s*(?:[\u2800-\u28ff]\s+)?(?:working|thinking|generating|loading)[\u2026.]?\s*\(esc to interrupt\)\s*$",
    re.IGNORECASE,
)
KEY_HINT = re.compile(r"^\s*(?:esc|enter|tab|ctrl\+?[a-z])\b.*\bto\b.*$", re.IGNORECASE)


class AgentError(Exception):
    """A user-facing error: reported on stderr with exit code 1."""


class CliParser(argparse.ArgumentParser):
    """argparse exits 2 on usage errors; the CLI reserves 2 for `wait` timeouts."""

    def error(self, message: str) -> NoReturn:
        self.print_usage(sys.stderr)
        self.exit(1, f"{self.prog}: error: {message}\n")


def load_tmux_module():
    path = HERE / "tmux-dogwatch.py"
    spec = importlib.util.spec_from_file_location("tmux_dogwatch_work_agent", path)
    if spec is None or spec.loader is None:
        raise AgentError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def normalize_session(name: str) -> str:
    """A pane of Work is attached through `<base>_pty_<id>`: use the base session."""
    return PTY_CLIENT.sub("", name.strip())


def project_sessions(tmux, binary: str | None) -> list[str]:
    listed = tmux.run_tmux(["list-sessions", "-F", "#{session_name}"], binary)
    if listed.returncode != 0:
        return []
    names: list[str] = []
    for raw in listed.stdout.splitlines():
        name = raw.strip()
        # Grouped client sessions mirror their base session: never target one.
        if not name or PTY_CLIENT.search(name):
            continue
        names.append(name)
    return names


def resolve_session(tmux, root: Path, explicit: str | None, binary: str | None) -> str:
    """Resolve the project session without borrowing an unrelated tmux client.

    Inside tmux the current pane is authoritative (Work attaches panes through
    a grouped `<session>_pty_<id>` client, normalized to its base). Outside
    tmux `display-message` answers for the most recently used client, which may
    belong to another project: the directory decides instead.
    """
    if explicit:
        return normalize_session(explicit)
    env = os.environ.get("WORK_TMUX_SESSION")
    if env:
        return normalize_session(env)
    if os.environ.get("TMUX"):
        current = tmux.run_tmux(["display-message", "-p", "#S"], binary)
        if current.returncode == 0 and current.stdout.strip():
            return normalize_session(current.stdout)

    names = project_sessions(tmux, binary)
    # Work adopts a plain folder name when the session already exists.
    if PLAIN_SESSION.match(root.name) and root.name in names:
        return root.name
    prefix = tmux.sanitized_session_prefix(root)
    match_prefix = prefix if prefix.endswith("_") else f"{prefix}_"
    matches = sorted(name for name in names if name.startswith(match_prefix))
    if len(matches) == 1:
        return matches[0]
    if not matches:
        raise AgentError(f"no tmux session found for {match_prefix}")
    raise AgentError(f"more than one tmux session matches {match_prefix}: {', '.join(matches)}")


def read_state(path: Path) -> dict[str, object] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("windows"), list):
        return None
    return data


def write_state(tmux, path: Path, session: str, windows: list[dict[str, object]]) -> dict[str, object]:
    stamp = tmux.now_iso()
    tmux.write_state(path, session, windows, stamp)
    return {
        "updated_at": stamp,
        "session": session,
        "live": True,
        "windows": windows,
    }


def live_state(tmux, path: Path, session: str, binary: str | None, lines: int = 30) -> dict[str, object]:
    try:
        windows = tmux.scan_windows(session, lines=lines, binary=binary)
    except RuntimeError as exc:
        raise AgentError(str(exc)) from exc
    return write_state(tmux, path, session, windows)


def current_state(
    tmux,
    path: Path,
    session: str,
    binary: str | None,
    *,
    max_age: float | None = 60.0,
) -> dict[str, object]:
    data = read_state(path)
    if data and data.get("session") == session:
        fresh = max_age is None
        if max_age is not None:
            try:
                fresh = time.time() - path.stat().st_mtime <= max_age
            except OSError:
                fresh = False
        if fresh and data["windows"]:
            return data
    return live_state(tmux, path, session, binary)


def marks_path(state_path: Path) -> Path:
    return state_path.parent / PROMPT_MARKS


def _mark_key(session: str, target: str) -> str:
    return f"{session}:{target.lower()}"


def read_marks(state_path: Path) -> dict[str, float]:
    try:
        data = json.loads(marks_path(state_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {str(k): float(v) for k, v in data.items() if isinstance(v, (int, float))}


def write_mark(state_path: Path, session: str, target: str) -> None:
    path = marks_path(state_path)
    marks = read_marks(state_path)
    now = time.time()
    marks = {k: v for k, v in marks.items() if now - v <= PROMPT_MARK_TTL}
    marks[_mark_key(session, target)] = now
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(marks, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except OSError:
        # A read-only .claude must not make `prompt` fail after the keys were sent.
        pass


def prompt_mark(state_path: Path, session: str, target: str) -> float | None:
    stamp = read_marks(state_path).get(_mark_key(session, target))
    if stamp is None or time.time() - stamp > PROMPT_MARK_TTL:
        return None
    return stamp


def db_file(state_path: Path) -> Path:
    return state_path.with_name("work.db")


def read_barrier(state_path: Path, target: str) -> dict | None:
    if not db_file(state_path).is_file():
        return None
    found: dict = {}
    work_db.safely(db_file(state_path), lambda db: found.update(dict(work_db.barrier(db, target) or {})))
    return found or None


def sender_name(tmux, binary: str | None) -> str | None:
    pane = os.environ.get("TMUX_PANE")
    if not pane:
        return None
    out = tmux.run_tmux(["display-message", "-p", "-t", pane, "#W"], binary)
    return (out.stdout.strip() or None) if out.returncode == 0 else None


def clear_mark(state_path: Path, session: str, target: str) -> None:
    if db_file(state_path).is_file():
        work_db.safely(db_file(state_path), lambda db: work_db.clear_barrier(db, target))
    path = marks_path(state_path)
    marks = read_marks(state_path)
    if marks.pop(_mark_key(session, target), None) is None:
        return
    try:
        path.write_text(json.dumps(marks, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except OSError:
        pass


def target_live_state(tmux, session: str, target: str, binary: str | None) -> str | None:
    """Read just the target pane, for the short race before a shared update."""
    text = tmux.capture_pane(session, target, lines=30, binary=binary)
    if not text.strip():
        return None
    state, _rule, _prompt_type = tmux.classify(text, target)
    if tmux.detect_prompt(text, target) is not None:
        return "blocked"
    return state


def window_of(state: dict[str, object], target: str) -> dict[str, object] | None:
    for window in state.get("windows", []):
        if str(window.get("name", "")).lower() == target.lower():
            return window
    return None


def send_literal(tmux, pane: str, text: str, binary: str | None) -> None:
    sent = tmux.run_tmux(["send-keys", "-t", pane, "-l", "--", text], binary)
    if sent.returncode != 0:
        raise AgentError(sent.stderr.strip() or f"cannot send the prompt to {pane}")
    enter = tmux.run_tmux(["send-keys", "-t", pane, "Enter"], binary)
    if enter.returncode != 0:
        raise AgentError(enter.stderr.strip() or f"cannot press Enter in {pane}")


def reset_session(tmux, pane: str, binary: str | None, command: str = OPENCODE_RESET) -> None:
    """Open a fresh session with the agent's own reset command."""
    send_literal(tmux, pane, command, binary)
    if RESET_SETTLE > 0:
        time.sleep(RESET_SETTLE)


def target_is_opencode(tmux, session: str, target: str, window: dict[str, object] | None, binary: str | None) -> bool:
    """The snapshot can name the role (qa1) instead of the CLI actually running."""
    out = tmux.run_tmux(
        ["display-message", "-p", "-t", f"{session}:{target}", "#{pane_start_command}\t#{pane_current_command}"],
        binary,
    )
    command = out.stdout.lower() if out.returncode == 0 else ""
    if command.strip():
        return "opencode" in command
    agent = str((window or {}).get("agent") or "").lower()
    return agent in OPENCODE_AGENTS


def explicit_reset(tmux, session: str, target: str, window: dict[str, object] | None, binary: str | None) -> str | None:
    """--clean: /new for OpenCode/Ollama, /clear for any other known agent, None otherwise."""
    if target_is_opencode(tmux, session, target, window, binary):
        return OPENCODE_RESET
    agent = str((window or {}).get("agent") or "")
    return CLEAR_RESET if agent and agent != "generic" else None


def strip_ansi(text: str) -> str:
    return ANSI_ESCAPE.sub("", text).replace("\r", "")


def clean_output(text: str) -> str:
    """Drop terminal chrome while keeping the agent's actual answer."""
    lines: list[str] = []
    for raw in text.splitlines():
        line = BOX_EDGE.sub("", raw).rstrip()
        if (
            BOX_ONLY.match(line)
            or SPINNER_ONLY.match(line)
            or STATUS_CHROME.match(line)
            or KEY_HINT.match(line)
        ):
            continue
        lines.append(line)
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    # Collapse repeated blank lines left by removed UI blocks.
    out: list[str] = []
    for line in lines:
        if not line.strip() and out and not out[-1].strip():
            continue
        out.append(line)
    return "\n".join(out)


ROLES = ("pm", "dev", "qa", "doc", "generic")
# Free for a task: ready is idle with nothing assigned yet.
IDLE_LIKE = ("idle", "ready")


def role_of(window: dict) -> str:
    return str(window.get("role") or work_db.role_of(str(window.get("name", ""))))


def matches(args, tmux, window: dict) -> bool:
    """--role and --agent filters; an agent alias (ollama) names its manifest (opencode)."""
    if getattr(args, "role", None) and role_of(window) != args.role:
        return False
    agent = getattr(args, "agent", None)
    return not agent or str(window.get("agent") or "") == tmux.canonical_agent(agent)


def agent_label(window: dict, compact: bool = False) -> str:
    agent = str(window.get("agent") or "-")
    model = window.get("model")
    if not model:
        return agent
    return f"{agent}({model})" if compact else f"{agent} ({model})"


def roles_line(windows: list[dict]) -> str:
    """roles: dev=dev1:claude · qa=qa1:opencode(model)"""
    parts = []
    for role in ROLES:
        members = [w for w in windows if role_of(w) == role and w.get("state") != "offline"]
        if members:
            parts.append(f"{role}=" + ",".join(f"{w['name']}:{agent_label(w, compact=True)}" for w in members))
    return "roles: " + (" · ".join(parts) if parts else "-")


def cmd_list(args, tmux, root: Path, path: Path, session: str) -> int:
    max_age = None if getattr(args, "state", None) else 60.0
    state = current_state(tmux, path, session, args.tmux_bin, max_age=max_age)
    windows = [w for w in state.get("windows", []) if matches(args, tmux, w)]
    if not windows:
        print("(no agent windows)")
        return 0
    for window in windows:
        name = str(window.get("name", "?"))
        status = str(window.get("state", "idle"))
        agent = str(window.get("agent") or "-")
        rule = window.get("rule")
        suffix = f"\t{rule}" if rule else ""
        print(f"{name}\t{status}\t{agent}{suffix}")
    return 0


def pick_role_window(state: dict, role: str, need: str | None) -> dict:
    """The first idle window of the role (tmux index order) running the agent."""
    members = [w for w in state.get("windows", []) if role_of(w) == role]
    for window in members:
        if window.get("state") in IDLE_LIKE and (need is None or window.get("agent") == need):
            return window
    seen = ", ".join(f"{w['name']}: {w.get('agent') or '-'} {w.get('state')}" for w in members) or "none"
    wanted = f" running {need}" if need else ""
    raise AgentError(f"no idle {role} window{wanted} ({seen})")


def cmd_prompt(args, tmux, root: Path, path: Path, session: str) -> int:
    target = args.target
    need = tmux.canonical_agent(args.require_agent) if args.require_agent else None
    max_age = None if getattr(args, "state", None) else 60.0
    state = current_state(tmux, path, session, args.tmux_bin, max_age=max_age)
    if window_of(state, target) is None:
        state = live_state(tmux, path, session, args.tmux_bin)
    window = window_of(state, target)
    # A role instead of a window: its first idle window, read live.
    if window is None and target.lower() in ROLES:
        window = pick_role_window(state, target.lower(), need)
        target = str(window["name"])
    if window is None:
        raise AgentError(f"agent window {target!r} not found in {session}")
    if need and window.get("agent") != need:
        raise AgentError(f"{target} runs {window.get('agent') or 'no known agent'}, not {need}")
    text = " ".join(args.text)
    pane = f"{session}:{target}"
    # A new task starts from a clean session automatically for OpenCode/Ollama
    # only, and only when the target is idle (a follow-up to a running task
    # keeps its context). --clean forces the agent's own reset (/clear for
    # Claude, Codex, Gemini), --no-clean disables the automatic one.
    command = None
    if args.clean is None:
        idle = str(window.get("state", "idle")) in IDLE_LIKE
        if idle and target_is_opencode(tmux, session, target, window, args.tmux_bin):
            command = OPENCODE_RESET
    elif args.clean:
        command = explicit_reset(tmux, session, target, window, args.tmux_bin)
        if command is None:
            print(f"work-agent: {target} runs no known agent; no session reset", file=sys.stderr)
    if command:
        reset_session(tmux, pane, args.tmux_bin, command)
    send_literal(tmux, pane, text, args.tmux_bin)
    # The agent may still look idle for one Dogwatch poll: remember the prompt
    # so an immediate `wait --until done` cannot accept that pre-start snapshot.
    write_mark(path, session, target)
    sender = sender_name(tmux, args.tmux_bin)
    work_db.safely(db_file(path), lambda db: work_db.set_barrier(db, session, target, sender, text))
    try:
        live_state(tmux, path, session, args.tmux_bin)
    except AgentError:
        # The instruction was delivered; `wait` will refresh the state itself.
        pass
    print(f"sent\t{target}")
    return 0


def state_mtime(path: Path) -> int | None:
    try:
        return path.stat().st_mtime_ns
    except OSError:
        return None


def clean_after_wait(args, tmux, state: dict[str, object], session: str, target: str, binary: str | None) -> None:
    if not getattr(args, "clean", False):
        return
    command = explicit_reset(tmux, session, target, window_of(state, target), binary)
    if command is None:
        return
    try:
        reset_session(tmux, f"{session}:{target}", binary, command)
    except AgentError as exc:
        # The task did complete: a failed reset must not turn it into a timeout.
        print(f"work-agent: session reset for {target} failed: {exc}", file=sys.stderr)


def cmd_wait(args, tmux, root: Path, path: Path, session: str) -> int:
    target = args.target
    until = args.until
    timeout = args.timeout
    deadline = None if timeout <= 0 else time.monotonic() + timeout
    # A prompt just sent by this CLI is a barrier: after it, an "idle" snapshot
    # is meaningful only once the agent has actually started working.
    shared = read_barrier(path, target)
    if shared and shared.get("session") not in (None, session):
        shared = None
    stamps = [m for m in (prompt_mark(path, session, target), shared and shared["sent_at_ms"] / 1000) if m]
    mark = max(stamps) if stamps else None
    barrier = mark is not None and time.time() - mark <= PROMPT_BARRIER
    # Never trust a snapshot written before the wait started: take one now.
    state = live_state(tmux, path, session, args.tmux_bin)
    if window_of(state, target) is None:
        if until == "done":
            clear_mark(path, session, target)
            print(f"{target}\tdone")
            return 0
        raise AgentError(f"agent window {target!r} not found in {session}")

    last_mtime = state_mtime(path)
    seen_active = False
    active_mtime: int | None = None
    next_probe = 0.0

    def note(value: str, snapshot_mtime: int | None) -> None:
        nonlocal seen_active, active_mtime
        if not seen_active and value in ("working", "blocked"):
            seen_active = True
            active_mtime = snapshot_mtime

    window = window_of(state, target)
    note(str(window.get("state", "idle")) if window else "idle", last_mtime)

    while True:
        window = window_of(state, target)
        if window is None:
            if until == "done":
                clear_mark(path, session, target)
                print(f"{target}\tdone")
                return 0
            raise AgentError(f"agent window {target!r} disappeared from {session}")
        value = str(window.get("state", "idle"))
        note(value, last_mtime)

        # While the prompt is still not seen running, probe its pane directly:
        # Dogwatch may update only every few seconds, and the start of the task
        # can fall between two snapshots.
        if barrier and not seen_active and time.monotonic() >= next_probe:
            next_probe = time.monotonic() + 0.5
            live = target_live_state(tmux, session, target, args.tmux_bin)
            if live in ("working", "blocked"):
                note(live, last_mtime)
            elif (read_barrier(path, target) or {}).get("observed_busy_at_ms"):
                # Work's dogwatch saw it busy between two of these probes.
                note("working", last_mtime)

        matched = value == until or (until in ("idle", "done") and value in IDLE_LIKE)
        if matched:
            pre_start = barrier and until in ("idle", "done") and not seen_active
            stale = (
                barrier
                and until in ("idle", "done")
                and active_mtime is not None
                and (last_mtime is None or last_mtime <= active_mtime)
            )
            if not pre_start and not stale:
                clean_after_wait(args, tmux, state, session, target, args.tmux_bin)
                clear_mark(path, session, target)
                print(f"{target}\t{'done' if until == 'done' else value}")
                return 0

        if deadline is not None and time.monotonic() >= deadline:
            print(
                f"timeout waiting for {target} to become {until} (last state: {value})",
                file=sys.stderr,
            )
            return 2

        time.sleep(WAIT_POLL)
        mtime = state_mtime(path)
        if mtime != last_mtime:
            fresh = read_state(path)
            if fresh and fresh.get("session") == session:
                state = fresh
            last_mtime = mtime


def cmd_read(args, tmux, root: Path, path: Path, session: str) -> int:
    target = args.target
    max_age = None if getattr(args, "state", None) else 60.0
    state = current_state(tmux, path, session, args.tmux_bin, max_age=max_age)
    if window_of(state, target) is None:
        state = live_state(tmux, path, session, args.tmux_bin)
    if window_of(state, target) is None:
        raise AgentError(f"agent window {target!r} not found in {session}")
    pane = f"{session}:{target}"
    captured = tmux.run_tmux(
        ["capture-pane", "-p", "-J", "-t", pane, "-S", f"-{max(1, args.lines)}"],
        args.tmux_bin,
    )
    if captured.returncode != 0:
        raise AgentError(captured.stderr.strip() or f"cannot read {pane}")
    text = strip_ansi(captured.stdout)
    if args.clean:
        text = clean_output(text)
    sys.stdout.write(text if text.endswith("\n") else f"{text}\n")
    return 0


# ── PM dashboard: status / log / inspect ─────────────────────


def fmt_duration(seconds: float | None) -> str:
    if seconds is None:
        return "-"
    seconds = max(0, int(seconds))
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m{seconds % 60:02d}s"
    return f"{seconds // 3600}h{seconds % 3600 // 60:02d}m"


def fmt_time(stamp: int) -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(stamp))


def open_db(path: Path):
    if not db_file(path).is_file():
        raise AgentError(f"no shared state yet ({db_file(path)}): start Work or scripts/tmux-dogwatch.py")
    try:
        return work_db.connect(db_file(path))
    except Exception as exc:  # noqa: BLE001 - sqlite3 or filesystem
        raise AgentError(f"cannot open {db_file(path)}: {exc}") from exc


def ticket_label(issue: dict | None) -> str:
    if not issue:
        return "-"
    return f"[{issue.get('sequence_id') or '?'}] {issue.get('state')}"


def dashboard(path: Path) -> dict:
    db = open_db(path)
    try:
        stamp = work_db.now()
        held = {a["assigned_window"]: a for a in work_db.assignments(db)}
        windows = []
        # Only members still in the team: an older database may hold offline rows.
        for w in (w for w in work_db.windows(db) if w["state"] != "offline"):
            w["duration"] = stamp - w["state_changed_at"]
            w["ticket"] = held.get(w["name"])
            windows.append(w)
        return {
            "now": stamp,
            "meta": work_db.meta(db),
            "windows": windows,
            "escalations": work_db.open_escalations(db),
            "anomalies": work_db.active_anomalies(db),
        }
    finally:
        db.close()


def emit_json(payload: object) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def cmd_status(args, tmux, root: Path, path: Path, session: str | None) -> int:
    last_poll = None
    if db_file(path).is_file():
        db = open_db(path)
        last_poll = work_db.meta(db).get("dogwatch_last_poll_at")
        db.close()
    # Without Work or the sentinel running, the database is refreshed here.
    if session and (last_poll is None or work_db.now() - int(last_poll) > STALE_POLL):
        try:
            live_state(tmux, path, session, args.tmux_bin)
        except AgentError:
            pass
    data = dashboard(path)
    roles = roles_line(data["windows"])
    data["windows"] = [w for w in data["windows"] if matches(args, tmux, w)]
    if args.json:
        emit_json({**data, "roles": roles})
        return 0
    meta = data["meta"]
    polled = meta.get("dogwatch_last_poll_at")
    age = f"{fmt_duration(data['now'] - int(polled))} ago" if polled else "never"
    print(f"session {meta.get('session_name', '-')} · last dogwatch look {age}")
    print(roles)
    rows = [("WINDOW", "ROLE", "STATE", "FOR", "AGENT", "TICKET", "LAST ACTIVITY")]
    for w in data["windows"]:
        rows.append((
            w["name"], role_of(w), w["state"], fmt_duration(w["duration"]), agent_label(w),
            ticket_label(w["ticket"]), w.get("last_activity_line") or "",
        ))
    widths = [max(len(str(r[i])) for r in rows) for i in range(6)]
    for r in rows:
        print("  ".join(str(c).ljust(widths[i]) for i, c in enumerate(r[:6])) + f"  {r[6]}".rstrip())
    if data["escalations"]:
        print("\npending questions:")
        for e in data["escalations"]:
            options = " | ".join(json.loads(e["options_json"] or "[]"))
            print(f"  {e['window_name']} ({e['status']}, {fmt_duration(data['now'] - e['created_at'])}): {e['question']}"
                  + (f" [{options}]" if options else ""))
    if data["anomalies"]:
        print("\nanomalies:")
        for a in data["anomalies"]:
            print(f"  {a['window_name']} {a['kind']}: {a['message']}")
    return 0


def print_events(events: list[dict]) -> None:
    for e in events:
        print(f"{fmt_time(e['timestamp'])}  {e['category']}/{e['kind']}  {e.get('window_name') or '-'}  {e['summary']}")


def cmd_log(args, tmux, root: Path, path: Path, session: str | None) -> int:
    db = open_db(path)
    try:
        events = work_db.events(db, args.window, max(1, args.limit))
    finally:
        db.close()
    if args.json:
        emit_json(events)
    elif not events:
        print("(no events)")
    else:
        print_events(events)
    return 0


def cmd_inspect(args, tmux, root: Path, path: Path, session: str | None) -> int:
    data = dashboard(path)
    window = next((w for w in data["windows"] if w["name"].lower() == args.target.lower()), None)
    if window is None:
        raise AgentError(f"window {args.target!r} not found in {db_file(path)}")
    name = window["name"]
    db = open_db(path)
    try:
        events = work_db.events(db, name, 10)
    finally:
        db.close()
    card = {
        "window": window,
        "escalation": next((e for e in data["escalations"] if e["window_name"] == name), None),
        "anomalies": [a for a in data["anomalies"] if a["window_name"] == name],
        "events": events,
    }
    if args.json:
        emit_json(card)
        return 0
    ticket = window["ticket"]
    print(f"{name} · {window['state']} for {fmt_duration(window['duration'])} · agent {window.get('agent') or '-'}"
          + (f" · rule {window['rule']}" if window.get("rule") else ""))
    print(f"ticket: {ticket_label(ticket)}" + (f" {ticket.get('title') or ''}" if ticket else ""))
    print(f"command: {window.get('current_command') or '-'}")
    print(f"last activity: {window.get('last_activity_line') or '-'}")
    if card["escalation"]:
        print(f"pending question ({card['escalation']['status']}): {card['escalation']['question']}")
    for a in card["anomalies"]:
        print(f"anomaly {a['kind']}: {a['message']}")
    print("--- tail ---")
    print(window.get("tail_preview") or "")
    print("--- recent events ---")
    print_events(events)
    return 0


def add_common(parser: argparse.ArgumentParser, *, suppress: bool = False) -> None:
    default = argparse.SUPPRESS if suppress else None
    parser.add_argument("--session", default=default, help="tmux session (default: current project session)")
    parser.add_argument("--root", type=Path, default=default if suppress else Path.cwd(), help="project root (default: cwd)")
    parser.add_argument("--state", type=Path, default=default, help=f"Dogwatch state file (default: ROOT/{DEFAULT_STATE})")
    parser.add_argument("--tmux-bin", default=default, help="tmux executable (tests can point at a stub)")


def add_filters(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--role", choices=ROLES, help="only windows of this role")
    parser.add_argument("--agent", metavar="ID", help="only windows running this agent (claude, opencode, codex…)")


def build_parser() -> argparse.ArgumentParser:
    parser = CliParser(description="Coordinate the agents of a Work tmux session.")
    add_common(parser)
    sub = parser.add_subparsers(dest="command", required=True, parser_class=CliParser)

    listing = sub.add_parser("list", help="list agent windows with their Dogwatch state")
    add_common(listing, suppress=True)
    add_filters(listing)

    prompt = sub.add_parser("prompt", help="send an instruction to another agent")
    add_common(prompt, suppress=True)
    prompt.add_argument("target", help="window name (dev1) or role (dev, qa, doc, pm, generic)")
    prompt.add_argument("text", nargs="+", help="instruction text")
    clean = prompt.add_mutually_exclusive_group()
    clean.add_argument(
        "--clean",
        dest="clean",
        action="store_true",
        default=None,
        help="reset the session before the prompt: /new for OpenCode/Ollama, /clear for other agents (default: OpenCode/Ollama only, when idle)",
    )
    clean.add_argument("--no-clean", dest="clean", action="store_false", help="never reset the session before the prompt")
    prompt.add_argument(
        "--require-agent",
        metavar="ID",
        help="fail unless the target runs this agent; with a role as target, pick its first idle window running it",
    )

    wait = sub.add_parser("wait", help="wait until an agent reaches a state")
    add_common(wait, suppress=True)
    wait.add_argument("target", help="role/window name, e.g. dev1")
    wait.add_argument("--until", choices=("blocked", "idle", "done"), default="idle", help="state to wait for (default: idle; done is an alias for idle/finished)")
    wait.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT, help=f"seconds before exit 2 (default: {DEFAULT_TIMEOUT:g}; 0 waits forever)")
    wait.add_argument("--clean", action="store_true", help="reset the session once the target reaches the state: /new for OpenCode/Ollama, /clear for other agents")

    read = sub.add_parser("read", help="read an agent's recent output")
    add_common(read, suppress=True)
    read.add_argument("target", help="role/window name, e.g. dev1")
    read.add_argument("--lines", type=int, default=200, help="pane lines to read (default: 200)")
    read.add_argument("--clean", action="store_true", help="drop ANSI, box borders and key-hint chrome")

    status = sub.add_parser("status", help="every agent window with state, duration, ticket and anomalies")
    add_common(status, suppress=True)
    status.add_argument("--json", action="store_true", help="print JSON")
    add_filters(status)

    log = sub.add_parser("log", help="latest events from the shared database")
    add_common(log, suppress=True)
    log.add_argument("--window", help="only this window's events")
    log.add_argument("--limit", type=int, default=20, help="events to show (default: 20)")
    log.add_argument("--json", action="store_true", help="print JSON")

    inspect = sub.add_parser("inspect", help="detailed card of one agent window")
    add_common(inspect, suppress=True)
    inspect.add_argument("target", help="window name, e.g. dev1")
    inspect.add_argument("--json", action="store_true", help="print JSON")

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    root = (args.root or Path.cwd()).expanduser().resolve()
    path = args.state or (root / DEFAULT_STATE)
    tmux = load_tmux_module()
    try:
        try:
            session = resolve_session(tmux, root, args.session, args.tmux_bin)
        except AgentError:
            # The database is readable without a live tmux session.
            if args.command not in ("status", "log", "inspect"):
                raise
            session = None
        commands = {
            "list": cmd_list,
            "prompt": cmd_prompt,
            "wait": cmd_wait,
            "read": cmd_read,
            "status": cmd_status,
            "log": cmd_log,
            "inspect": cmd_inspect,
        }
        return commands[args.command](args, tmux, root, path, session)
    except AgentError as exc:
        print(f"work-agent: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
