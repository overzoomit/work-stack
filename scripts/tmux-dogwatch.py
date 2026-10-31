#!/usr/bin/env python3
"""tmux-dogwatch: watchdog for the agent windows of a project tmux session.

Scans the last lines of dev*, qa* and agent* windows, detects interactive
confirmation prompts or open questions, and records them in
.claude/escalation_to_pm.json so the PM can answer without the user having to
watch every terminal.

Usage:
    tmux-dogwatch.py --once [--session NAME] [--root DIR]
    tmux-dogwatch.py --check
    tmux-dogwatch.py --daemon [--interval SECONDS]
    tmux-dogwatch.py answer <target-window> <text> [--session NAME]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# Team windows the watchdog must watch: dev1, dev2..., qa, qa1..., agent1...
AGENT_WINDOW = re.compile(r"^(?:dev\d+|qa\d*|agent\d+|generico)$", re.IGNORECASE)

# Confirmation / permission prompts that block an agent until answered.
CONFIRMATION_PATTERNS = (
    ("permission", re.compile(
        r"do you want to proceed|allow (?:this|the)|approve (?:this|the)|permission (?:request|required|to)|trust the files",
        re.IGNORECASE,
    )),
    ("confirmation", re.compile(
        r"\[y/n\]|\(y/n\)|\byes\s*/\s*no\b|enter to confirm|press enter to continue|continue\?",
        re.IGNORECASE,
    )),
    ("selection", re.compile(r"^\s*[❯>]\s*\d+[.)]\s+\S", re.MULTILINE)),
)

OPEN_QUESTION = re.compile(r"\bplease (?:clarify|confirm|choose|provide|tell)\b", re.IGNORECASE)

NUMBERED_OPTION = re.compile(r"^\s*(?:[❯>]\s*)?\d+[.)]\s+(.+?)\s*$")
BARE_FLAG = re.compile(r"^\s*(?:\[[^\]]+\]|\([^)]*\))\s*$")

DEFAULT_FILE = Path(".claude") / "escalation_to_pm.json"


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def tmux_binary(explicit: str | None = None) -> str:
    return explicit or os.environ.get("TMUX_DOGWATCH_TMUX") or shutil.which("tmux") or "tmux"


def run_tmux(args: list[str], binary: str | None = None) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            [tmux_binary(binary), *args],
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        return subprocess.CompletedProcess([tmux_binary(binary), *args], 127, "", "tmux not found")


def sanitized_session_prefix(path: Path) -> str:
    base = path.name or "project"
    safe = "".join(c if (c.isascii() and (c.isalnum() or c in "-_")) else "_" for c in base)
    return f"work_{safe.strip('_')}"


def resolve_session(explicit: str | None = None, binary: str | None = None) -> str:
    """Use --session, WORK_TMUX_SESSION, the current pane, or the project prefix."""
    if explicit:
        return explicit
    env = os.environ.get("WORK_TMUX_SESSION")
    if env:
        return env
    current = run_tmux(["display-message", "-p", "#S"], binary)
    if current.returncode == 0 and current.stdout.strip():
        return current.stdout.strip()
    prefix = sanitized_session_prefix(Path.cwd())
    listed = run_tmux(["list-sessions", "-F", "#{session_name}"], binary)
    matches = [s for s in listed.stdout.splitlines() if s.strip().startswith(prefix)] if listed.returncode == 0 else []
    if len(matches) == 1:
        return matches[0].strip()
    if not matches:
        raise RuntimeError(f"no tmux session found for {prefix}")
    raise RuntimeError(f"more than one tmux session matches {prefix}: {', '.join(matches)}")


def parse_windows(raw: str) -> list[dict[str, object]]:
    windows = []
    for line in raw.splitlines():
        line = line.rstrip("\n")
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        windows.append({
            "id": parts[0].strip(),
            "name": parts[1].strip(),
            "active": len(parts) > 2 and parts[2].strip() == "1",
            "path": parts[3].strip() if len(parts) > 3 else "",
        })
    return windows


def agent_windows(session: str, binary: str | None = None) -> list[dict[str, object]]:
    out = run_tmux(
        ["list-windows", "-t", session, "-F", "#{window_id}\t#{window_name}\t#{window_active}\t#{pane_current_path}"],
        binary,
    )
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or f"cannot list windows of {session}")
    return [w for w in parse_windows(out.stdout) if AGENT_WINDOW.match(str(w["name"]))]


def capture_pane(session: str, name: str, lines: int = 30, binary: str | None = None) -> str:
    out = run_tmux(
        ["capture-pane", "-p", "-J", "-t", f"{session}:{name}", "-S", f"-{max(1, lines)}"],
        binary,
    )
    return out.stdout if out.returncode == 0 else ""


def extract_options(lines: list[str]) -> list[str]:
    options = []
    for line in lines:
        m = NUMBERED_OPTION.match(line)
        if m:
            options.append(m.group(1).strip())
    if options:
        return list(dict.fromkeys(options))
    joined = "\n".join(lines)
    if re.search(r"\[y/n\]|\(y/n\)|\byes\s*/\s*no\b", joined, re.IGNORECASE):
        return ["Yes", "No"]
    return []


def extract_question(lines: list[str]) -> str:
    for line in reversed(lines):
        text = line.strip()
        if is_prompt_chrome(text):
            continue
        return text
    return lines[-1].strip() if lines else ""


# Lines a prompt keeps drawing below its question: options, key hints, box borders.
PROMPT_CHROME = re.compile(
    r"^[\s│╭╰╮╯─┌└┐┘]*$|\b(?:esc|enter|tab|ctrl\S*)\b.*\bto\b|\b(?:esc|enter) to \w+",
    re.IGNORECASE,
)


BOX_EDGE = re.compile(r"^[ \t│]+(?=\S)|[ \t│]+$")


def is_prompt_chrome(line: str) -> bool:
    return bool(NUMBERED_OPTION.match(line) or BARE_FLAG.match(line) or PROMPT_CHROME.search(line))


def detect_prompt(text: str) -> dict[str, object] | None:
    """Return {prompt_type, question, options} for a prompt still waiting for input, else None.

    A prompt is pending only when nothing but its own options and key hints
    follows it: any other later line means the process went on.
    """
    lines = [BOX_EDGE.sub("", line) for line in text.splitlines()]
    tail = [line for line in lines if line.strip()][-12:]
    if not tail:
        return None

    start = len(tail)
    while start > 0 and is_prompt_chrome(tail[start - 1]):
        start -= 1
    block = tail[max(0, start - 1):]
    joined = "\n".join(block)
    prompt_type = next((kind for kind, rx in CONFIRMATION_PATTERNS if rx.search(joined)), None)
    if prompt_type is None:
        last = tail[-1].strip()
        if not last.endswith("?") and not OPEN_QUESTION.search(last):
            return None
        prompt_type = "question"
        block = [tail[-1]]

    return {"prompt_type": prompt_type, "question": extract_question(block), "options": extract_options(block)}


def scan_once(
    session: str,
    *,
    lines: int = 30,
    binary: str | None = None,
    timestamp: str | None = None,
) -> list[dict[str, object]]:
    """Scan every agent window and return the pending questions, if any."""
    stamp = timestamp or now_iso()
    pending = []
    for window in agent_windows(session, binary):
        name = str(window["name"])
        found = detect_prompt(capture_pane(session, name, lines, binary))
        if found:
            pending.append({"target": name, "timestamp": stamp, **found})
    return pending


def escalation_path(root: Path | None = None) -> Path:
    return (root or Path.cwd()) / DEFAULT_FILE


def write_escalation(path: Path, pending: list[dict[str, object]], timestamp: str | None = None) -> dict[str, object]:
    payload = {"updated_at": timestamp or now_iso(), "pending": pending}
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)
    return payload


def check(
    *,
    session: str | None = None,
    root: Path | None = None,
    lines: int = 30,
    binary: str | None = None,
    timestamp: str | None = None,
) -> dict[str, object]:
    resolved = resolve_session(session, binary)
    stamp = timestamp or now_iso()
    pending = scan_once(resolved, lines=lines, binary=binary, timestamp=stamp)
    payload = write_escalation(escalation_path(root), pending, stamp)
    return {"session": resolved, **payload}


def send_answer(
    target: str,
    text: str,
    *,
    session: str | None = None,
    binary: str | None = None,
    enter: bool = True,
) -> str:
    resolved = resolve_session(session, binary)
    pane = target if ":" in target else f"{resolved}:{target}"
    args = ["send-keys", "-t", pane, "-l", "--", text]
    out = run_tmux(args, binary)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or f"cannot send keys to {pane}")
    if enter:
        out = run_tmux(["send-keys", "-t", pane, "Enter"], binary)
        if out.returncode != 0:
            raise RuntimeError(out.stderr.strip() or f"cannot press Enter in {pane}")
    return pane


def emit(payload: dict[str, object]) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Watch agent tmux windows and escalate their questions to the PM.")
    parser.add_argument("--session", help="tmux session name (default: current or project session)")
    parser.add_argument("--root", type=Path, default=Path.cwd(), help="project root (default: cwd)")
    parser.add_argument("--file", type=Path, help=f"escalation file (default: ROOT/{DEFAULT_FILE})")
    parser.add_argument("--lines", type=int, default=30, help="pane lines to scan (default: 30)")
    parser.add_argument("--tmux-bin", help="tmux executable (tests can point at a stub)")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--once", action="store_true", help="scan once, print JSON and stop")
    mode.add_argument("--check", action="store_true", help="alias of --once")
    mode.add_argument("--daemon", action="store_true", help="poll continuously")
    parser.add_argument("--interval", type=float, default=5.0, help="daemon poll interval in seconds")

    sub = parser.add_subparsers(dest="command")
    answer = sub.add_parser("answer", help="send the PM's answer to a target window")
    answer.add_argument("target", help="window name, e.g. dev1")
    answer.add_argument("text", nargs="+", help="answer text")
    answer.add_argument("--no-enter", action="store_true", help="do not press Enter after the text")
    # Also accept the global flags after the subcommand (SUPPRESS keeps the
    # value parsed before it, when present).
    answer.add_argument("--session", default=argparse.SUPPRESS)
    answer.add_argument("--tmux-bin", default=argparse.SUPPRESS)
    answer.add_argument("--root", default=argparse.SUPPRESS, type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    binary = args.tmux_bin
    root = args.root
    path = args.file or escalation_path(root)

    if args.command == "answer":
        try:
            pane = send_answer(
                args.target,
                " ".join(args.text),
                session=args.session,
                binary=binary,
                enter=not args.no_enter,
            )
        except RuntimeError as exc:
            print(json.dumps({"error": str(exc)}, ensure_ascii=False))
            return 2
        emit({"sent": True, "pane": pane})
        return 0

    if args.daemon:
        try:
            while True:
                resolved = resolve_session(args.session, binary)
                pending = scan_once(resolved, lines=args.lines, binary=binary)
                emit({"session": resolved, **write_escalation(path, pending)})
                sys.stdout.flush()
                time.sleep(max(0.1, args.interval))
        except KeyboardInterrupt:
            return 0
        except RuntimeError as exc:
            print(json.dumps({"error": str(exc)}, ensure_ascii=False))
            return 2

    if args.once or args.check:
        try:
            resolved = resolve_session(args.session, binary)
            pending = scan_once(resolved, lines=args.lines, binary=binary)
        except RuntimeError as exc:
            print(json.dumps({"error": str(exc)}, ensure_ascii=False))
            return 2
        emit({"session": resolved, **write_escalation(path, pending)})
        return 0

    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
