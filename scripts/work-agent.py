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

HERE = Path(__file__).resolve().parent
DEFAULT_STATE = Path(".claude") / "dogwatch_state.json"
WAIT_POLL = 0.2
DEFAULT_TIMEOUT = 300.0

# CSI / OSC / single-character escapes emitted by terminal UIs.
ANSI_ESCAPE = re.compile(
    r"\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))"
)
BOX_ONLY = re.compile(r"^\s*[│┃|╭╰╮╯─┌└┐┘]+\s*$")
BOX_EDGE = re.compile(r"^[ \t│┃|]+(?=\S)|[ \t│┃|]+$")
SPINNER_ONLY = re.compile(r"^\s*[\u2800-\u28ff]+\s*$")
KEY_HINT = re.compile(r"^\s*(?:esc|enter|tab|ctrl\+?[a-z])\b.*\bto\b.*$", re.IGNORECASE)


class AgentError(Exception):
    """A user-facing error: reported on stderr with exit code 1."""


def load_tmux_module():
    path = HERE / "tmux-dogwatch.py"
    spec = importlib.util.spec_from_file_location("tmux_dogwatch_work_agent", path)
    if spec is None or spec.loader is None:
        raise AgentError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def resolve_session(tmux, root: Path, explicit: str | None, binary: str | None) -> str:
    if explicit:
        return explicit
    env = os.environ.get("WORK_TMUX_SESSION")
    if env:
        return env
    current = tmux.run_tmux(["display-message", "-p", "#S"], binary)
    if current.returncode == 0 and current.stdout.strip():
        return current.stdout.strip()
    prefix = tmux.sanitized_session_prefix(root)
    listed = tmux.run_tmux(["list-sessions", "-F", "#{session_name}"], binary)
    matches = (
        [s.strip() for s in listed.stdout.splitlines() if s.strip().startswith(prefix)]
        if listed.returncode == 0
        else []
    )
    if len(matches) == 1:
        return matches[0]
    if not matches:
        raise AgentError(f"no tmux session found for {prefix}")
    raise AgentError(f"more than one tmux session matches {prefix}: {', '.join(matches)}")


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
        if BOX_ONLY.match(line) or SPINNER_ONLY.match(line) or KEY_HINT.match(line):
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
    print(f"sent\t{target}")
    return 0


def cmd_wait(args, tmux, root: Path, path: Path, session: str) -> int:
    target = args.target
    until = args.until
    timeout = args.timeout
    deadline = None if timeout <= 0 else time.monotonic() + timeout
    state = current_state(tmux, path, session, args.tmux_bin, max_age=None)
    if window_of(state, target) is None:
        state = live_state(tmux, path, session, args.tmux_bin)
    if window_of(state, target) is None:
        if until == "done":
            print(f"{target}\tdone")
            return 0
        raise AgentError(f"agent window {target!r} not found in {session}")

    last_mtime: int | None = None
    while True:
        if last_mtime is None:
            window = window_of(state, target)
        else:
            try:
                mtime = path.stat().st_mtime_ns
            except OSError:
                mtime = None
            if mtime != last_mtime:
                fresh = read_state(path)
                if fresh and fresh.get("session") == session:
                    state = fresh
            window = window_of(state, target)
        try:
            last_mtime = path.stat().st_mtime_ns
        except OSError:
            last_mtime = None

        if window is None:
            if until == "done":
                print(f"{target}\tdone")
                return 0
            raise AgentError(f"agent window {target!r} disappeared from {session}")
        value = str(window.get("state", "idle"))
        if value == until or (until == "done" and value == "idle"):
            print(f"{target}\t{'done' if until == 'done' else value}")
            return 0
        if deadline is not None and time.monotonic() >= deadline:
            print(
                f"timeout waiting for {target} to become {until} (last state: {value})",
                file=sys.stderr,
            )
            return 2
        time.sleep(WAIT_POLL)


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
    parser = argparse.ArgumentParser(description="Coordinate the agents of a Work tmux session.")
    add_common(parser)
    sub = parser.add_subparsers(dest="command", required=True)

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
