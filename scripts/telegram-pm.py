#!/usr/bin/env python3
"""telegram-pm: send a PM notification to the authorized Telegram chat.

Only the PM (the `0:pm` window) uses this channel. The recipient is never an
argument: the script reads the bot token and the numeric chat id from the
configuration written by Work when the bot is connected, or from
WORK_TELEGRAM_TOKEN / WORK_TELEGRAM_CHAT_ID. Every message goes to that one
chat, so dev and QA cannot reach another user through the bot.

Usage:
    telegram-pm.py send <text>
    echo "<text>" | telegram-pm.py send
    telegram-pm.py send <text> --config /path/to/telegram.json

Configuration file (created by Work, mode 0600):
    { "token": "123456:ABC…", "chat_id": "123456789", "bot": "work_pm_bot" }

Tests point WORK_TELEGRAM_API at a local fake server; it defaults to the real
Telegram API.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

APP_ID = "it.overzoom.work"
CONFIG_FILE = "telegram.json"
DEFAULT_API = "https://api.telegram.org"
MAX_TEXT = 4000
HTTP_TIMEOUT = 40

TOKEN_RE = re.compile(r"^\d+:[A-Za-z0-9_-]{20,}$")
CHAT_ID_RE = re.compile(r"^-?\d+$")


class ConfigError(Exception):
    """Missing or unsafe configuration."""


class TelegramError(Exception):
    """Telegram rejected the request or could not be reached."""


def app_config_dir() -> Path:
    """The same per-app directory Tauri uses for WORK's configuration."""
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_ID
    if os.name == "nt":
        base = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
        return base / APP_ID
    base = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    return base / APP_ID


def config_path(explicit: str | None = None) -> Path:
    if explicit:
        return Path(explicit).expanduser()
    if os.environ.get("WORK_TELEGRAM_CONFIG"):
        return Path(os.environ["WORK_TELEGRAM_CONFIG"]).expanduser()
    return app_config_dir() / CONFIG_FILE


def read_config(path: Path) -> dict[str, str]:
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    except OSError as exc:
        raise ConfigError(f"cannot read {path}: {exc}") from exc
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ConfigError(f"{path} is not valid JSON: {exc.msg}") from exc
    if not isinstance(data, dict):
        raise ConfigError(f"{path} must contain a JSON object")
    return {
        key: value
        for key, value in data.items()
        if isinstance(value, str)
    }


def load_credentials(path: Path) -> tuple[str, str]:
    """Resolve token and chat id; environment variables win over the file."""
    file_cfg = read_config(path)
    token = (os.environ.get("WORK_TELEGRAM_TOKEN") or file_cfg.get("token") or "").strip()
    chat_id = (
        os.environ.get("WORK_TELEGRAM_CHAT_ID")
        or file_cfg.get("chat_id")
        or file_cfg.get("chatId")
        or ""
    ).strip()

    if not token or not chat_id:
        raise ConfigError(
            f"Telegram is not configured: connect the bot in Work or set "
            f"WORK_TELEGRAM_TOKEN and WORK_TELEGRAM_CHAT_ID ({path})."
        )
    if not TOKEN_RE.match(token):
        raise ConfigError("The bot token is invalid: expected <bot id>:<secret>.")
    if not CHAT_ID_RE.match(chat_id):
        raise ConfigError("The chat id must be a numeric Telegram chat id.")
    return token, chat_id


def truncate(text: str, limit: int = MAX_TEXT) -> str:
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "…"


def scrub(text: str, token: str) -> str:
    """Never echo the bot token in an error or a log line."""
    return text.replace(token, "<token>") if token else text


def api_root(explicit: str | None = None) -> str:
    base = explicit or os.environ.get("WORK_TELEGRAM_API") or DEFAULT_API
    return base.rstrip("/")


def send_message(api: str, token: str, chat_id: str, text: str, timeout: int = HTTP_TIMEOUT) -> int:
    payload = json.dumps({"chat_id": chat_id, "text": truncate(text)}).encode("utf-8")
    request = urllib.request.Request(
        f"{api}/bot{token}/sendMessage",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode("utf-8"))
            reason = detail.get("description") or f"HTTP {exc.code}"
        except (ValueError, OSError):
            reason = f"HTTP {exc.code}"
        raise TelegramError(scrub(f"Telegram rejected the message: {reason}", token)) from exc
    except urllib.error.URLError as exc:
        raise TelegramError(scrub(f"Telegram is unreachable: {exc.reason}", token)) from exc
    except (OSError, ValueError) as exc:
        raise TelegramError(scrub(f"Invalid response from Telegram: {exc}", token)) from exc

    if not body.get("ok"):
        reason = body.get("description") or "request refused"
        raise TelegramError(scrub(f"Telegram rejected the message: {reason}", token))
    return int(body.get("result", {}).get("message_id") or 0)


def emit(payload: dict[str, object]) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Send a PM notification to the configured Telegram chat."
    )
    parser.add_argument("--config", help="bot configuration file (default: WORK config dir)")
    parser.add_argument(
        "--api",
        default=argparse.SUPPRESS,
        help=argparse.SUPPRESS,
    )
    sub = parser.add_subparsers(dest="command")
    send = sub.add_parser("send", help="send text to the authorized chat")
    send.add_argument("text", nargs="*", help="message text (default: read stdin)")
    send.add_argument("--config", default=argparse.SUPPRESS)
    send.add_argument("--api", default=argparse.SUPPRESS)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command != "send":
        parser.print_help()
        return 1

    text = " ".join(args.text).strip()
    if not text and not sys.stdin.isatty():
        text = sys.stdin.read().strip()
    if not text:
        print(json.dumps({"error": "The message is empty."}))
        return 2

    try:
        token, chat_id = load_credentials(config_path(args.config))
        message_id = send_message(api_root(getattr(args, "api", None)), token, chat_id, text)
    except (ConfigError, TelegramError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        return 2

    emit({"sent": True, "chat_id": chat_id, "message_id": message_id})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
