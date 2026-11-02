#!/usr/bin/env python3
"""Plane dogwatch: delegates Plane tickets to the agents of the project's tmux session.

Each cycle reads the project's issues on Plane and acts on the ones that
changed since the last cycle:

  Re-open  first: back to the dev who had it (or the first free dev), moved to
           "In Progress" with the QA rejection in the prompt;
  Todo     to the first free dev, moved to "In Progress";
  Test     to the QA agent, asked to move it to "Done" or "Re-open";
  Done     recorded, and the PM is notified on Telegram when it is configured.

A prompt is typed into an agent window only while that window is idle and not
already holding a delegated ticket. .claude/plane_dogwatch_state.json keeps,
for every issue, the last state seen and the fingerprint of the last version
acted upon, so an unchanged ticket is never delegated twice.

Usage:
  python3 scripts/plane-dogwatch.py --once [--session work_x]
  python3 scripts/plane-dogwatch.py --daemon --interval 5

The API key comes from PLANE_API_KEY or from the global plane_cli.py; it is
never printed.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import importlib.util
import json
import os
import re
import signal
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATE_FILE = Path(".claude") / "plane_dogwatch_state.json"
DEFAULT_PLANE_CLI = Path.home() / ".claude" / "scripts" / "plane_cli.py"
DEFAULT_BASE_URL = "https://plane.overzoom.it"
DEFAULT_WORKSPACE = "overzoom"
HTTP_TIMEOUT = 20
MAX_TEXT = 3000

# Working state of a delegation: while the ticket stays there, its agent is busy.
WORKING = {"dev": "in progress", "qa": "test"}

# Agent TUIs show these while they run; a shell or agent waiting for input
# shows an input marker on one of its last lines.
BUSY_MARKER = re.compile(r"esc to (?:interrupt|cancel)|\bctrl\+c to (?:interrupt|stop)\b", re.IGNORECASE)
INPUT_LINE = re.compile(r"^\s*(?:[│|]\s*)?[>❯›]\s?.*$|[$#%❯>]\s*$")


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


tmux = load_module("tmux_dogwatch", HERE / "tmux-dogwatch.py")


# ── Configuration ────────────────────────────────────────────


class ConfigError(Exception):
    pass


def plane_cli_defaults() -> dict[str, str]:
    path = Path(os.environ.get("PLANE_CLI") or DEFAULT_PLANE_CLI).expanduser()
    if not path.is_file():
        return {}
    try:
        cli = load_module("plane_cli", path)
    except Exception:  # a broken global CLI only means no defaults
        return {}
    return {
        "api_key": getattr(cli, "API_KEY", "") or "",
        "base_url": getattr(cli, "PLANE_BASE_URL", "") or "",
        "workspace": getattr(cli, "WORKSPACE_SLUG", "") or "",
    }


def load_config(root: Path) -> dict[str, str]:
    path = root / ".plane.json"
    if not path.is_file():
        raise ConfigError(f"{path} not found")
    local = json.loads(path.read_text(encoding="utf-8"))
    if not local.get("project_id"):
        raise ConfigError(f"{path} has no project_id")
    cli = plane_cli_defaults()
    api_key = os.environ.get("PLANE_API_KEY") or cli.get("api_key")
    if not api_key:
        raise ConfigError("no Plane API key: set PLANE_API_KEY")
    return {
        "project_id": local["project_id"],
        "workspace": local.get("workspace_slug") or os.environ.get("PLANE_WORKSPACE_SLUG") or cli.get("workspace") or DEFAULT_WORKSPACE,
        "base_url": (os.environ.get("PLANE_BASE_URL") or local.get("base_url") or cli.get("base_url") or DEFAULT_BASE_URL).rstrip("/"),
        "api_key": api_key,
    }


# ── Plane REST API ───────────────────────────────────────────


class Plane:
    def __init__(self, config: dict[str, str]):
        self.root = f"{config['base_url']}/api/v1/workspaces/{config['workspace']}/projects/{config['project_id']}"
        self.headers = {
            "X-API-Key": config["api_key"],
            "Content-Type": "application/json",
            "User-Agent": "work-plane-dogwatch/1.0",
        }
        self._states: dict[str, str] | None = None

    def request(self, method: str, endpoint: str, payload: dict | None = None):
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(f"{self.root}/{endpoint}", data=data, headers=self.headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                body = resp.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f"Plane {method} {endpoint}: HTTP {exc.code}") from None
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Plane {method} {endpoint}: {exc.reason}") from None
        return json.loads(body) if body else {}

    def results(self, endpoint: str) -> list[dict]:
        data = self.request("GET", endpoint)
        return data.get("results", []) if isinstance(data, dict) else data

    def state_names(self) -> dict[str, str]:
        if self._states is None:
            self._states = {s["id"]: s["name"] for s in self.results("states/")}
        return self._states

    def issues(self) -> list[dict]:
        return sorted(self.results("issues/"), key=lambda i: i.get("sequence_id") or 0)

    def comments(self, issue_id: str) -> list[dict]:
        return sorted(self.results(f"issues/{issue_id}/comments/"), key=lambda c: c.get("created_at") or "")

    def move(self, issue_id: str, state: str, comment: str) -> None:
        ids = {name.lower(): sid for sid, name in self.state_names().items()}
        if state.lower() not in ids:
            raise RuntimeError(f"Plane state {state!r} not found")
        self.request("PATCH", f"issues/{issue_id}/", {"state": ids[state.lower()]})
        self.request("POST", f"issues/{issue_id}/comments/", {"comment_html": f"<p>{html.escape(comment)}</p>"})


# ── Text helpers ─────────────────────────────────────────────


def plain(fragment: str | None, limit: int = MAX_TEXT) -> str:
    """HTML from Plane to one line of text: a prompt is typed as a single line."""
    text = re.sub(r"<li[^>]*>", " - ", fragment or "")
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", html.unescape(text)).strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"


def fingerprint(issue: dict, state: str) -> str:
    raw = "\x1f".join([state, issue.get("updated_at") or "", issue.get("name") or "", issue.get("description_html") or ""])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def ticket(issue: dict) -> str:
    return f"Ticket [{issue.get('sequence_id')}] (UUID: {issue['id']})"


def dev_prompt(issue: dict) -> str:
    return (
        f"[plane-dogwatch] Prendi in carico il {ticket(issue)}: {plain(issue.get('name'), 200)}. "
        f"Descrizione e criteri: {plain(issue.get('description_html'))} "
        "Il ticket è già In Progress su Plane. Sviluppa con i test, verifica npm test e cargo clippy, "
        "committa secondo le convenzioni del progetto e sposta il ticket in 'Test' con commento tecnico in italiano."
    )


def reopen_prompt(issue: dict, reason: str) -> str:
    return (
        f"[plane-dogwatch] Re-open del {ticket(issue)}: {plain(issue.get('name'), 200)}. "
        f"Motivo del QA: {reason or 'nessun commento'} "
        f"Descrizione: {plain(issue.get('description_html'))} "
        "Il ticket è già In Progress su Plane. Correggi con test di regressione, verifica npm test e cargo clippy, "
        "committa e sposta il ticket in 'Test' con commento tecnico in italiano."
    )


def qa_prompt(issue: dict, notes: str) -> str:
    return (
        f"[plane-dogwatch] Valida il {ticket(issue)} in Test: {plain(issue.get('name'), 200)}. "
        f"Criteri: {plain(issue.get('description_html'))} "
        f"Note del dev (file modificati e test): {notes or 'nessun commento'} "
        "Esegui le verifiche end-to-end. Se tutti i criteri passano sposta il ticket in 'Done' con report QA in italiano; "
        "altrimenti in 'Re-open' con la descrizione dettagliata del problema."
    )


# ── tmux ─────────────────────────────────────────────────────


def is_idle(capture: str) -> bool:
    """Idle: no confirmation pending, no running agent, an input line at the bottom."""
    if tmux.detect_prompt(capture):
        return False
    lines = [line for line in capture.splitlines() if line.strip()]
    if not lines or any(BUSY_MARKER.search(line) for line in lines[-6:]):
        return False
    # shortcut: the input marker is guessed from the last lines; a command that
    # prints a prompt-looking line while it runs looks idle. A per-agent
    # status (pane_current_command) would be more precise.
    return any(INPUT_LINE.search(line) for line in lines[-6:])


class Session:
    def __init__(self, name: str, binary: str | None):
        self.name = name
        self.binary = binary
        out = tmux.run_tmux(["list-windows", "-t", name, "-F", "#{window_id}\t#{window_name}"], binary)
        if out.returncode != 0:
            raise RuntimeError(out.stderr.strip() or f"cannot list windows of {name}")
        self.windows = {str(w["name"]) for w in tmux.parse_windows(out.stdout)}

    def idle(self, window: str) -> bool:
        return window in self.windows and is_idle(tmux.capture_pane(self.name, window, 40, self.binary))

    def send(self, window: str, text: str) -> None:
        tmux.send_answer(window, text, session=self.name, binary=self.binary)


# ── State file ───────────────────────────────────────────────


def load_state(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"issues": {}}
    return data if isinstance(data, dict) and isinstance(data.get("issues"), dict) else {"issues": {}}


def save_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


# ── Cycle ────────────────────────────────────────────────────


def notify_telegram(script: Path, text: str) -> str:
    if not script.is_file():
        return "not configured"
    try:
        out = subprocess.run(
            [sys.executable, str(script), "send", text],
            capture_output=True, text=True, check=False, stdin=subprocess.DEVNULL, timeout=60,
        )
    except subprocess.TimeoutExpired:
        return "not sent: timeout"
    if out.returncode == 0:
        return "sent"
    try:
        return f"not sent: {json.loads(out.stdout)['error']}"
    except (ValueError, KeyError, TypeError):
        return "not sent"


def busy_roles(records: dict, current: dict[str, str]) -> set[str]:
    """Windows still holding a delegated ticket in its working state."""
    return {
        r["target"]
        for issue_id, r in records.items()
        if r.get("target") and current.get(issue_id) == WORKING.get(r.get("role"))
    }


def last_comment(plane: Plane, issue_id: str) -> str:
    comments = plane.comments(issue_id)
    return plain(comments[-1].get("comment_html"), 1500) if comments else ""


def run_cycle(plane: Plane, session: Session, state_path: Path, devs: list[str], qa: list[str], telegram: Path) -> dict:
    names = plane.state_names()
    issues = plane.issues()
    state = load_state(state_path)
    records = state["issues"]
    current = {i["id"]: names.get(i.get("state"), "").lower() for i in issues}
    busy = busy_roles(records, current)
    actions: list[dict] = []
    waiting: list[dict] = []

    def free(candidates: list[str]) -> str | None:
        return next((w for w in candidates if w not in busy and session.idle(w)), None)

    # The prompt goes first and is recorded at once: a failure further on
    # (Plane down, tmux gone) must not type the same prompt again next cycle.
    def delegate(issue: dict, kind: str, role: str, target: str, prompt: str, move: str | None) -> None:
        session.send(target, prompt)
        busy.add(target)
        records[issue["id"]] = {
            **records.get(issue["id"], {}),
            "role": role,
            "target": target,
            "hash": fingerprint(issue, kind),
            "handled": kind,
            "timestamp": tmux.now_iso(),
        }
        save_state(state_path, state)
        action = {"issue": issue.get("sequence_id"), "id": issue["id"], "from": kind, "to": move or kind, "target": target}
        actions.append(action)
        if not move:
            return
        try:
            plane.move(issue["id"], move, f"Presa in carico automatica da plane-dogwatch: delegato a {target}.")
            current[issue["id"]] = move.lower()
        except RuntimeError as exc:
            action["error"] = str(exc)

    def pending(kind: str) -> list[dict]:
        return [i for i in issues if current[i["id"]] == kind and records.get(i["id"], {}).get("hash") != fingerprint(i, kind)]

    for issue in pending("re-open"):
        previous = records.get(issue["id"], {}).get("target")
        target = free([previous] if previous in devs else []) or free(devs)
        if not target:
            waiting.append({"issue": issue.get("sequence_id"), "state": "Re-open", "reason": "no free dev"})
            continue
        delegate(issue, "re-open", "dev", target, reopen_prompt(issue, last_comment(plane, issue["id"])), "In Progress")

    for issue in pending("todo"):
        target = free(devs)
        if not target:
            waiting.append({"issue": issue.get("sequence_id"), "state": "Todo", "reason": "no free dev"})
            continue
        delegate(issue, "todo", "dev", target, dev_prompt(issue), "In Progress")

    for issue in pending("test"):
        target = free(qa)
        if not target:
            waiting.append({"issue": issue.get("sequence_id"), "state": "Test", "reason": "QA busy"})
            continue
        delegate(issue, "test", "qa", target, qa_prompt(issue, last_comment(plane, issue["id"])), None)

    for issue in issues:
        record = records.setdefault(issue["id"], {})
        seen = record.get("state")
        now = current[issue["id"]]
        # A ticket already Done at the first look is history, not news.
        if now == "done" and seen and seen != "done":
            sent = notify_telegram(telegram, f"✅ {ticket(issue)} completato: {plain(issue.get('name'), 200)}")
            actions.append({"issue": issue.get("sequence_id"), "id": issue["id"], "from": seen, "to": "done", "telegram": sent})
        if seen != now:
            record["state"] = now
            record["timestamp"] = tmux.now_iso()

    save_state(state_path, state)
    return {
        "session": session.name,
        "timestamp": tmux.now_iso(),
        "issues": [
            {"issue": i.get("sequence_id"), "id": i["id"], "state": names.get(i.get("state"), ""), "name": i.get("name")}
            for i in issues
            if current[i["id"]] not in ("done", "cancelled")
        ],
        "actions": actions,
        "waiting": waiting,
    }


# ── CLI ──────────────────────────────────────────────────────


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2), flush=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Delegate Plane tickets to the agents of the project's tmux session.")
    parser.add_argument("--session", help="tmux session name (default: current or project session)")
    parser.add_argument("--root", type=Path, default=Path.cwd(), help="project root with .plane.json (default: cwd)")
    parser.add_argument("--devs", default="dev1,dev2", help="dev windows, in order of preference")
    parser.add_argument("--qa", default="dev2", help="QA windows, in order of preference (default: dev2)")
    parser.add_argument("--tmux-bin", help="tmux executable (tests can point at a stub)")
    parser.add_argument("--telegram", type=Path, help="telegram-pm.py to notify the PM (default: scripts/telegram-pm.py)")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--once", action="store_true", help="run one cycle, print JSON and stop")
    mode.add_argument("--check", action="store_true", help="alias of --once")
    mode.add_argument("--daemon", action="store_true", help="poll continuously")
    parser.add_argument("--interval", type=float, default=5.0, help="daemon poll interval in seconds")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    root = args.root.resolve()
    os.chdir(root)  # the session fallback derives its name from the cwd
    try:
        plane = Plane(load_config(root))
    except (ConfigError, ValueError) as exc:
        emit({"error": str(exc)})
        return 2
    split = lambda s: [w.strip() for w in s.split(",") if w.strip()]  # noqa: E731
    devs, qa = split(args.devs), split(args.qa)
    telegram = args.telegram or HERE / "telegram-pm.py"
    state_path = root / STATE_FILE

    def cycle() -> dict:
        session = Session(tmux.resolve_session(args.session, args.tmux_bin), args.tmux_bin)
        return run_cycle(plane, session, state_path, devs, qa, telegram)

    if not args.daemon:
        try:
            emit(cycle())
        except RuntimeError as exc:
            emit({"error": str(exc)})
            return 2
        return 0

    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    while not stop.is_set():
        try:
            emit(cycle())
        except RuntimeError as exc:
            emit({"error": str(exc)})  # a network or tmux hiccup: try again next round
        stop.wait(max(0.5, args.interval))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
