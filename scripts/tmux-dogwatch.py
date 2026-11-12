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
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import work_db  # noqa: E402

try:
    import tomllib
except ModuleNotFoundError:  # Python < 3.11
    try:
        import tomli as tomllib
    except ModuleNotFoundError:
        tomllib = None

# Team windows the watchdog must watch: dev1, qa1, doc1, agent1...
AGENT_WINDOW = re.compile(r"^(?:pm|dev\d+|qa\d*|doc\d*|agent\d+|generico)$", re.IGNORECASE)

# Declarative manifests shared with the Rust dogwatch (src-tauri/detect/manifests).
MANIFEST_DIR = Path(__file__).resolve().parent.parent / "src-tauri" / "detect" / "manifests"

NUMBERED_OPTION = re.compile(r"^\s*(?:[❯>]\s*)?\d+[.)]\s+(.+?)\s*$")
BARE_FLAG = re.compile(r"^\s*(?:\[[^\]]+\]|\([^)]*\))\s*$")

DEFAULT_FILE = Path(".claude") / "escalation_to_pm.json"
DEFAULT_STATE = Path(".claude") / "dogwatch_state.json"
DEFAULT_RELAY = Path(".claude") / "dogwatch_relay.json"


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


INPUT_MARKER = re.compile(
    r"^\s*(?:[│|┃]\s*)?(?:[>❯›$#%]|(?:\? )|(?:Build|Ask|Chat)\s*·)\s*$",
    re.IGNORECASE,
)


def is_input_marker(line: str) -> bool:
    line = line.strip().strip("│|┃").strip()
    if not line:
        return False
    if line in {"❯", ">", "$", "%", "#", "›"}:
        return True
    if len(line) <= 3 and line[0] in {"❯", ">", "$", "%", "#", "›"}:
        return True
    lower = line.lower()
    return lower in {"ask anything...", "chat ·", "build ·"} or bool(INPUT_MARKER.match(line))


def is_prompt_chrome(line: str) -> bool:
    return bool(
        NUMBERED_OPTION.match(line)
        or BARE_FLAG.match(line)
        or is_input_marker(line)
        or PROMPT_CHROME.search(line)
    )


# ── Declarative manifests (same files as src-tauri/detect/manifests) ──

_MANIFESTS: list[dict[str, object]] | None = None


def _python_regex(pattern: str) -> re.Pattern[str] | None:
    # The Rust regex syntax accepts \u{2800}; Python wants the literal char.
    pattern = re.sub(
        r"\\u\{([0-9a-fA-F]+)\}",
        lambda m: chr(int(m.group(1), 16)),
        pattern,
    )
    try:
        return re.compile(pattern, re.IGNORECASE)
    except re.error:
        return None


def _parse_manifest_toml(text: str) -> dict[str, object]:
    """Fallback TOML parser for agent manifests when tomllib/tomli is unavailable."""
    data: dict[str, object] = {"rules": []}
    current_rule: dict[str, object] | None = None
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        i += 1
        if not line or line.startswith("#"):
            continue
        if line == "[[rules]]":
            current_rule = {"predicates": {}}
            data["rules"].append(current_rule)
            continue
        if "=" in line:
            key, val = line.split("=", 1)
            key = key.strip()
            val = val.strip()
            if val.startswith("[") and not val.endswith("]"):
                array_parts = [val[1:]]
                while i < len(lines):
                    sub = lines[i].strip()
                    i += 1
                    if sub.endswith("]"):
                        array_parts.append(sub[:-1])
                        break
                    array_parts.append(sub)
                val_items = []
                for part in array_parts:
                    for item in part.split(","):
                        item = item.strip()
                        if item and (item.startswith('"') or item.startswith("'")):
                            val_items.append(item[1:-1])
                val_parsed = val_items
            elif val.startswith("[") and val.endswith("]"):
                inner = val[1:-1].strip()
                val_parsed = [
                    item.strip()[1:-1]
                    for item in inner.split(",")
                    if item.strip() and (item.strip().startswith('"') or item.strip().startswith("'"))
                ]
            elif (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
                val_parsed = val[1:-1]
            elif val.isdigit():
                val_parsed = int(val)
            else:
                val_parsed = val

            target = current_rule if current_rule is not None else data
            if key.startswith("predicates."):
                pred_key = key.split(".", 1)[1]
                target["predicates"][pred_key] = val_parsed
            else:
                target[key] = val_parsed
    return data


def load_manifests() -> list[dict[str, object]]:
    """Read the TOML manifests once; invalid rules are skipped, not fatal."""
    global _MANIFESTS
    if _MANIFESTS is not None:
        return _MANIFESTS
    manifests: list[dict[str, object]] = []
    if MANIFEST_DIR.is_dir():
        paths = sorted(MANIFEST_DIR.glob("*.toml"), key=lambda p: (p.name == "generic.toml", p.name))
        for path in paths:
            try:
                content = path.read_text(encoding="utf-8")
                if tomllib is not None:
                    raw = tomllib.loads(content)
                else:
                    raw = _parse_manifest_toml(content)
            except Exception:
                continue
            rules = []
            for rule in raw.get("rules", []):
                predicates = rule.get("predicates", {})
                rules.append({
                    "id": rule.get("id", ""),
                    "state": rule.get("state", "idle"),
                    "priority": int(rule.get("priority", 0)),
                    "region": rule.get("region", "whole_recent"),
                    "prompt_type": rule.get("prompt_type"),
                    "contains": [s.lower() for s in predicates.get("contains", [])],
                    "regex": [rx for p in predicates.get("regex", []) if (rx := _python_regex(p))],
                    "line_regex": [rx for p in predicates.get("line_regex", []) if (rx := _python_regex(p))],
                })
            manifests.append({
                "id": raw.get("id", path.stem),
                "aliases": [a.lower() for a in raw.get("aliases", [])],
                "version": raw.get("version", 0),
                "rules": sorted(rules, key=lambda r: -r["priority"]),
            })
    _MANIFESTS = manifests
    return manifests


def _role_matches(alias: str, role: str) -> bool:
    return role == alias or (role.startswith(alias) and role[len(alias):].isdigit())


def manifest_for_window(name: str) -> dict[str, object] | None:
    role = name.lower()
    manifests = load_manifests()
    for manifest in manifests:
        if manifest["id"] == "generic":
            continue
        if any(_role_matches(alias, role) for alias in manifest["aliases"]):
            return manifest
    return next((m for m in manifests if m["id"] == "generic"), manifests[-1] if manifests else None)


def prompt_block_lines(text: str) -> list[str]:
    lines = [BOX_EDGE.sub("", line) for line in text.splitlines()]
    tail = [line for line in lines if line.strip()][-12:]
    if not tail:
        return []
    start = len(tail)
    while start > 0 and is_prompt_chrome(tail[start - 1]):
        start -= 1
    return tail[max(0, start - 1):]


def _region_text(region: str, text: str) -> str:
    if region == "prompt_block":
        return "\n".join(prompt_block_lines(text))
    if region == "last_non_empty_line":
        for line in reversed(text.splitlines()):
            stripped = line.strip().strip("│|┃").strip()
            if stripped and not is_input_marker(stripped):
                return line
        return ""
    match = re.fullmatch(r"bottom_non_empty_lines\((\d+)\)", region)
    if match:
        lines = [line for line in text.splitlines() if line.strip()]
        return "\n".join(lines[-max(1, int(match.group(1))):])
    return text


def _rule_matches(rule: dict[str, object], text: str) -> bool:
    region = _region_text(str(rule["region"]), text)
    if not region.strip():
        return False
    lower = region.lower()
    if any(needle in lower for needle in rule["contains"]):
        return True
    if any(rx.search(region) for rx in rule["regex"]):
        return True
    return any(rx.search(line) for rx in rule["line_regex"] for line in region.splitlines())


def classify(text: str, window_name: str = "generic") -> tuple[str, str | None, str | None]:
    """(state, rule id, prompt type) from the window's agent manifest."""
    manifest = manifest_for_window(window_name)
    if not manifest:
        return "idle", None, None
    for rule in manifest["rules"]:
        if _rule_matches(rule, text):
            return str(rule["state"]), str(rule["id"]), rule["prompt_type"]
    return "idle", None, None


def detect_prompt(text: str, window_name: str = "generic") -> dict[str, object] | None:
    """Return {prompt_type, question, options} for a prompt still waiting for input, else None.

    A prompt is pending only when nothing but its own options and key hints
    follows it: any other later line means the process went on.
    """
    state, _rule, prompt_type = classify(text, window_name)
    if state != "blocked" or not prompt_type:
        return None
    block = prompt_block_lines(text)
    if not block:
        return None
    return {"prompt_type": prompt_type, "question": extract_question(block), "options": extract_options(block)}


def scan_windows(
    session: str,
    *,
    lines: int = 30,
    binary: str | None = None,
) -> list[dict[str, object]]:
    """Every agent window with its manifest-decided state and pending prompt."""
    windows = []
    for window in agent_windows(session, binary):
        name = str(window["name"])
        text = capture_pane(session, name, lines, binary)
        state, rule, _prompt_type = classify(text, name)
        prompt = detect_prompt(text, name)
        if prompt is not None:
            state = "blocked"
        manifest = manifest_for_window(name)
        windows.append({
            "id": window["id"],
            "name": name,
            "agent": manifest["id"] if manifest else None,
            "state": state,
            "rule": rule,
            "prompt": prompt,
            **(work_db.activity(text) if text.strip() else {}),
        })
    return windows


def pending_from_windows(windows: list[dict[str, object]], timestamp: str) -> list[dict[str, object]]:
    pending = []
    for window in windows:
        name = str(window["name"])
        prompt = window.get("prompt")
        if name.lower() == "pm" or not prompt:
            continue  # the PM answers, it is never an escalation target
        pending.append({"target": name, "timestamp": timestamp, "relayed_to_pm": False, **prompt})
    return pending


def scan_session(
    session: str,
    *,
    lines: int = 30,
    binary: str | None = None,
    timestamp: str | None = None,
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    stamp = timestamp or now_iso()
    windows = scan_windows(session, lines=lines, binary=binary)
    return windows, pending_from_windows(windows, stamp)


def scan_once(
    session: str,
    *,
    lines: int = 30,
    binary: str | None = None,
    timestamp: str | None = None,
) -> list[dict[str, object]]:
    """Scan every agent window and return the pending questions, if any."""
    _windows, pending = scan_session(
        session, lines=lines, binary=binary, timestamp=timestamp
    )
    return pending


def escalation_path(root: Path | None = None) -> Path:
    return (root or Path.cwd()) / DEFAULT_FILE


def state_path(root: Path | None = None) -> Path:
    return (root or Path.cwd()) / DEFAULT_STATE


def _atomic_json(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def write_escalation(path: Path, pending: list[dict[str, object]], timestamp: str | None = None) -> dict[str, object]:
    payload = {"updated_at": timestamp or now_iso(), "pending": pending}
    _atomic_json(path, payload)
    return payload


def write_state(
    path: Path,
    session: str,
    windows: list[dict[str, object]],
    timestamp: str | None = None,
    *,
    live: bool = True,
) -> dict[str, object]:
    # The database first: it gives each window its state_changed_at.
    work_db.safely(path.with_name("work.db"), lambda db: work_db.sync_windows(db, session, windows, live))
    payload = {
        "updated_at": timestamp or now_iso(),
        "session": session,
        "live": live,
        "windows": windows,
    }
    _atomic_json(path, payload)
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
    windows, pending = scan_session(
        resolved, lines=lines, binary=binary, timestamp=stamp
    )
    payload = write_escalation(escalation_path(root), pending, stamp)
    write_state(state_path(root), resolved, windows, stamp)
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
        if text:
            time.sleep(0.35)
        out = run_tmux(["send-keys", "-t", pane, "Enter"], binary)
        if out.returncode != 0:
            raise RuntimeError(out.stderr.strip() or f"cannot press Enter in {pane}")
    return pane


def relay_path(root: Path | None = None) -> Path:
    return (root or Path.cwd()) / DEFAULT_RELAY


# Same digest as the Rust side (src-tauri/src/dogwatch.rs): the first 8 bytes of
# SHA-256 over the fields joined by \x1e, options joined by \x1f.
def fingerprint(target: str, entry: dict[str, object]) -> str:
    options = "\x1f".join(str(option) for option in entry.get("options", []))
    raw = "\x1e".join([target, str(entry["prompt_type"]), str(entry["question"]), options])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def format_pm_escalation(target: str, agent: str, entry: dict[str, object]) -> str:
    options = " | ".join(str(option) for option in entry.get("options", [])) or "nessuna"
    return (
        f"[DOGWATCH] {target} ({agent}) è bloccato. Tipo: {entry['prompt_type']}. "
        f"Domanda: {entry['question']}. Opzioni: {options}. "
        "Se è una questione tecnica nota o una conferma di routine, rispondi tu: "
        f'python3 scripts/tmux-dogwatch.py answer {target} "<risposta>". '
        "Altrimenti inoltra all'utente con "
        'python3 scripts/telegram-pm.py send "<messaggio>" e, appena arriva la sua risposta, passala con '
        f'python3 scripts/tmux-dogwatch.py answer {target} "<risposta>".'
    )


def load_relayed(path: Path) -> dict[str, str]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    relayed = data.get("relayed") if isinstance(data, dict) else None
    if not isinstance(relayed, dict):
        return {}
    return {str(target): str(fp) for target, fp in relayed.items()}


# One send per call, to the first question the PM has not seen, while the PM is
# idle. The fingerprints live in the shared relay file, so the daemon and the
# Work app never announce the same block twice.
def relay_to_pm(
    pending: list[dict[str, object]],
    windows: list[dict[str, object]],
    root: Path | None = None,
    *,
    session: str,
    binary: str | None = None,
) -> list[dict[str, object]]:
    path = relay_path(root)
    before = load_relayed(path)
    relayed = {
        target: fp
        for target, fp in before.items()
        if any(
            str(e["target"]) == target and fingerprint(target, e) == fp for e in pending
        )
    }
    for entry in pending:
        target = str(entry["target"])
        entry["relayed_to_pm"] = relayed.get(target) == fingerprint(target, entry)

    pm_idle = any(str(w["name"]).lower() == "pm" and w["state"] == "idle" for w in windows)
    waiting = next((e for e in pending if not e["relayed_to_pm"]), None)
    if pm_idle and waiting is not None:
        target = str(waiting["target"])
        agent = next((w["agent"] for w in windows if w["name"] == target), None) or "generic"
        try:
            send_answer("pm", format_pm_escalation(target, str(agent), waiting), session=session, binary=binary)
        except RuntimeError:
            pass
        else:
            relayed[target] = fingerprint(target, waiting)
            waiting["relayed_to_pm"] = True

    if relayed != before:
        _atomic_json(path, {"relayed": relayed})
    return pending


def record_escalations(root: Path | None, pending: list[dict[str, object]]) -> None:
    work_db.safely(
        work_db.db_path(root or Path.cwd()),
        lambda db: work_db.sync_escalations(db, pending, fingerprint),
    )


def record_answer(root: Path | None, target: str, text: str) -> None:
    path = work_db.db_path(root or Path.cwd())
    if path.is_file():
        work_db.safely(path, lambda db: work_db.record_answer(db, target, text, "pm"))


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
    parser.add_argument(
        "--relay-pm",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="send new questions to an idle PM window (default: on in --daemon, off otherwise)",
    )

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
        record_answer(root, args.target, " ".join(args.text))
        emit({"sent": True, "pane": pane})
        return 0

    relay = args.relay_pm if args.relay_pm is not None else args.daemon

    if args.daemon:
        try:
            while True:
                resolved = resolve_session(args.session, binary)
                stamp = now_iso()
                windows, pending = scan_session(
                    resolved, lines=args.lines, binary=binary, timestamp=stamp
                )
                if relay:
                    pending = relay_to_pm(pending, windows, root, session=resolved, binary=binary)
                write_state(state_path(root), resolved, windows, stamp)
                record_escalations(root, pending)
                emit({"session": resolved, **write_escalation(path, pending, timestamp=stamp)})
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
            stamp = now_iso()
            windows, pending = scan_session(
                resolved, lines=args.lines, binary=binary, timestamp=stamp
            )
        except RuntimeError as exc:
            print(json.dumps({"error": str(exc)}, ensure_ascii=False))
            return 2
        if relay:
            pending = relay_to_pm(pending, windows, root, session=resolved, binary=binary)
        write_state(state_path(root), resolved, windows, stamp)
        record_escalations(root, pending)
        emit({"session": resolved, **write_escalation(path, pending, timestamp=stamp)})
        return 0

    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
