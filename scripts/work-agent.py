#!/usr/bin/env python3
"""work-agent: deterministic coordination between Work's tmux agents.

The CLI is meant to be called from inside a terminal or an agent window of a
Work project. It reads the shared Dogwatch snapshot
(.claude/dogwatch_state.json) instead of polling tmux panes, so waiting for a
colleague does not add noise to the terminal.

Commands:
    work-agent list
    work-agent prompt <target_role> "<instruction>"
    work-agent wait <target_role> [--until blocked|idle|done] [--timeout SEC]
    work-agent read <target_role> [--lines N] [--clean]

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
DEFAULT_STATE = Path(".claude") / "dogwatch_state.json"
WAIT_POLL = 0.2
DEFAULT_TIMEOUT = 300.0
# Local marker written by `prompt` and read by `wait`: it closes the race where
# an idle snapshot taken before the agent starts would look like "done".
PROMPT_MARKS = "work-agent_prompts.json"
PROMPT_MARK_TTL = 3600.0
# Only a prompt issued moments ago needs the "watch it start first" barrier;
# an old marker must not make a later wait hang on an agent that already ran.
PROMPT_BARRIER = 60.0
PLAIN_SESSION = re.compile(r"^[A-Za-z0-9_-]+$")
PTY_CLIENT = re.compile(r"_pty_\d+$")

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


def clear_mark(state_path: Path, session: str, target: str) -> None:
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


def cmd_list(args, tmux, root: Path, path: Path, session: str) -> int:
    max_age = None if getattr(args, "state", None) else 60.0
    state = current_state(tmux, path, session, args.tmux_bin, max_age=max_age)
    windows = state.get("windows", [])
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


def cmd_prompt(args, tmux, root: Path, path: Path, session: str) -> int:
    target = args.target
    max_age = None if getattr(args, "state", None) else 60.0
    state = current_state(tmux, path, session, args.tmux_bin, max_age=max_age)
    if window_of(state, target) is None:
        state = live_state(tmux, path, session, args.tmux_bin)
    if window_of(state, target) is None:
        raise AgentError(f"agent window {target!r} not found in {session}")
    text = " ".join(args.text)
    pane = f"{session}:{target}"
    sent = tmux.run_tmux(["send-keys", "-t", pane, "-l", "--", text], args.tmux_bin)
    if sent.returncode != 0:
        raise AgentError(sent.stderr.strip() or f"cannot send the prompt to {pane}")
    enter = tmux.run_tmux(["send-keys", "-t", pane, "Enter"], args.tmux_bin)
    if enter.returncode != 0:
        raise AgentError(enter.stderr.strip() or f"cannot press Enter in {pane}")
    # The agent may still look idle for one Dogwatch poll: remember the prompt
    # so an immediate `wait --until done` cannot accept that pre-start snapshot.
    write_mark(path, session, target)
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


def cmd_wait(args, tmux, root: Path, path: Path, session: str) -> int:
    target = args.target
    until = args.until
    timeout = args.timeout
    deadline = None if timeout <= 0 else time.monotonic() + timeout
    # A prompt just sent by this CLI is a barrier: after it, an "idle" snapshot
    # is meaningful only once the agent has actually started working.
    mark = prompt_mark(path, session, target)
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

        matched = value == until or (until == "done" and value == "idle")
        if matched:
            pre_start = barrier and until in ("idle", "done") and not seen_active
            stale = (
                barrier
                and until in ("idle", "done")
                and active_mtime is not None
                and (last_mtime is None or last_mtime <= active_mtime)
            )
            if not pre_start and not stale:
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


def add_common(parser: argparse.ArgumentParser, *, suppress: bool = False) -> None:
    default = argparse.SUPPRESS if suppress else None
    parser.add_argument("--session", default=default, help="tmux session (default: current project session)")
    parser.add_argument("--root", type=Path, default=default if suppress else Path.cwd(), help="project root (default: cwd)")
    parser.add_argument("--state", type=Path, default=default, help=f"Dogwatch state file (default: ROOT/{DEFAULT_STATE})")
    parser.add_argument("--tmux-bin", default=default, help="tmux executable (tests can point at a stub)")


def build_parser() -> argparse.ArgumentParser:
    parser = CliParser(description="Coordinate the agents of a Work tmux session.")
    add_common(parser)
    sub = parser.add_subparsers(dest="command", required=True, parser_class=CliParser)

    listing = sub.add_parser("list", help="list agent windows with their Dogwatch state")
    add_common(listing, suppress=True)

    prompt = sub.add_parser("prompt", help="send an instruction to another agent")
    add_common(prompt, suppress=True)
    prompt.add_argument("target", help="role/window name, e.g. dev1")
    prompt.add_argument("text", nargs="+", help="instruction text")

    wait = sub.add_parser("wait", help="wait until an agent reaches a state")
    add_common(wait, suppress=True)
    wait.add_argument("target", help="role/window name, e.g. dev1")
    wait.add_argument("--until", choices=("blocked", "idle", "done"), default="idle", help="state to wait for (default: idle; done is an alias for idle/finished)")
    wait.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT, help=f"seconds before exit 2 (default: {DEFAULT_TIMEOUT:g}; 0 waits forever)")

    read = sub.add_parser("read", help="read an agent's recent output")
    add_common(read, suppress=True)
    read.add_argument("target", help="role/window name, e.g. dev1")
    read.add_argument("--lines", type=int, default=200, help="pane lines to read (default: 200)")
    read.add_argument("--clean", action="store_true", help="drop ANSI, box borders and key-hint chrome")

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    root = (args.root or Path.cwd()).expanduser().resolve()
    path = args.state or (root / DEFAULT_STATE)
    tmux = load_tmux_module()
    try:
        session = resolve_session(tmux, root, args.session, args.tmux_bin)
        commands = {
            "list": cmd_list,
            "prompt": cmd_prompt,
            "wait": cmd_wait,
            "read": cmd_read,
        }
        return commands[args.command](args, tmux, root, path, session)
    except AgentError as exc:
        print(f"work-agent: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
