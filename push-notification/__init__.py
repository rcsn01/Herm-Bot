"""Bark push notifications for Hermes — automatic, hook-driven.

Pushes a native iPhone notification through a self-hosted bark-server relay
whenever a Hermes turn runs long (>= ``min_turn_seconds``), so you get pinged
without any agent action or skill. Cron sessions, gateway turns, and
background-task completion turns all flow through the same conversation loop,
so they are all covered by the same hook.

Tapping a notification deep-links into Hermes Mobile via
``hermes://session/<id>`` (the app registers the scheme in its Info.plist).

Configuration — all optional, in ~/.hermes/config.yaml:

    plugins:
      entries:
        bark-notify:
          settings:
            min_turn_seconds: 30          # only notify for turns that ran at least this long
            debounce_seconds: 5           # quiet period after the last stream event before pushing
            min_push_interval_seconds: 60 # global rate limit between pushes
            level: timeSensitive          # active | timeSensitive | critical | passive
            group: hermes                 # Bark notification group
            title: "Hermes"               # notification title prefix

Secrets — in ~/.hermes/.env (loaded into the process env at startup):
    BARK_URL — bark-server base URL, e.g. http://bark-host:8080
    BARK_KEY — device key from the Bark iOS app

Manual pushes from a terminal: ``hermes bark "message"`` (see --help).
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request

logger = logging.getLogger(__name__)

BARK_URL_ENV = "BARK_URL"
BARK_KEY_ENV = "BARK_KEY"

_DEFAULTS = {
    "min_turn_seconds": 30.0,
    "debounce_seconds": 5.0,
    "min_push_interval_seconds": 60.0,
    "level": "timeSensitive",
    "group": "hermes",
    "title": "Hermes",
}
_BODY_LIMIT = 240
_HTTP_TIMEOUT = 5.0

_lock = threading.Lock()
_turns: dict = {}  # activity key -> {"start", "last", "session_id", "final_text"}
_timers: dict = {}  # activity key -> threading.Timer
_last_push_at = 0.0
_settings: dict | None = None


def _setting(ctx, key: str, default):
    try:
        value = ctx.get_config(key, default)
    except Exception:  # config unavailable — fall back to default
        return default
    return default if value is None else value


def _activity_key(turn_id: str, session_id: str) -> str:
    return turn_id or session_id or "default"


def _on_stream_start(**payload) -> None:
    """First stream of an iteration: extend the turn, cancel a queued push."""
    key = _activity_key(payload.get("turn_id", ""), payload.get("session_id", ""))
    now = time.monotonic()
    with _lock:
        turn = _turns.get(key)
        if turn is None:
            _turns[key] = {
                "start": now,
                "last": now,
                "session_id": payload.get("session_id", ""),
                "final_text": "",
            }
        else:
            turn["last"] = now
        timer = _timers.pop(key, None)
    if timer is not None:
        timer.cancel()


def _on_stream_end(**payload) -> None:
    """Schedule (or reschedule) the debounced push for this turn.

    ``on_stream_end`` fires once per LLM call, so a tool-loop turn emits many
    of them; the quiet period distinguishes a finished turn from an iteration.
    """
    if not payload.get("finished", True):
        return  # failed stream attempt; a retry/next iteration will follow
    key = _activity_key(payload.get("turn_id", ""), payload.get("session_id", ""))
    now = time.monotonic()
    settings = _settings
    if settings is None:
        return
    with _lock:
        turn = _turns.get(key)
        if turn is None:
            turn = _turns[key] = {
                "start": now,
                "last": now,
                "session_id": payload.get("session_id", ""),
                "final_text": "",
            }
        else:
            turn["last"] = now
        turn["final_text"] = str(payload.get("final_text") or "")
        previous = _timers.pop(key, None)
        timer = threading.Timer(
            settings["debounce_seconds"], _push_when_quiet, args=(key,)
        )
        timer.daemon = True
        _timers[key] = timer
    timer.start()
    if previous is not None:
        previous.cancel()


def _push_when_quiet(key: str) -> None:
    with _lock:
        _timers.pop(key, None)
        turn = _turns.pop(key, None)
        settings = _settings
        if turn is None or settings is None:
            return
        global _last_push_at
        duration = turn["last"] - turn["start"]
        if duration < settings["min_turn_seconds"]:
            return
        if time.monotonic() - _last_push_at < settings["min_push_interval_seconds"]:
            return
        _last_push_at = time.monotonic()

    body = (turn.get("final_text") or "").strip().replace("\n", " ")
    if len(body) > _BODY_LIMIT:
        body = body[: _BODY_LIMIT - 1].rstrip() + "…"
    if not body:
        body = f"Turn finished in {duration:.0f}s."
    sent = _send(
        title=f"{settings['title']} — task finished ({duration:.0f}s)",
        body=body,
        session_id=turn.get("session_id", ""),
        settings=settings,
    )
    if sent:
        logger.debug("bark-notify: pushed turn notification (session=%s)", turn.get("session_id", ""))


def _send(title: str, body: str, session_id: str, settings: dict, url_override: str | None = None) -> bool:
    base = (os.environ.get(BARK_URL_ENV) or "").strip().rstrip("/")
    key = (os.environ.get(BARK_KEY_ENV) or "").strip()
    if not base or not key:
        logger.debug("bark-notify: %s/%s not set — push skipped", BARK_URL_ENV, BARK_KEY_ENV)
        return False
    payload: dict = {
        "title": title,
        "body": body,
        "group": settings.get("group") or "hermes",
        "level": settings.get("level") or "timeSensitive",
    }
    deep_link = url_override or (
        f"hermes://session/{session_id}" if session_id else None
    )
    if deep_link:
        payload["url"] = deep_link
    request = urllib.request.Request(
        f"{base}/{key}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=_HTTP_TIMEOUT) as response:
            return 200 <= response.status < 300
    except (urllib.error.URLError, OSError) as exc:
        logger.warning("bark-notify: push failed: %s", exc)
        return False


def _cli_setup(subparser) -> None:
    subparser.add_argument("message", nargs="+", help="notification body text")
    subparser.add_argument("--title", default=None, help="notification title (default: Hermes)")
    subparser.add_argument(
        "--url", default=None, help="tap-through link, e.g. hermes://session/<id>"
    )
    subparser.add_argument(
        "--level",
        default=None,
        choices=["active", "timeSensitive", "critical", "passive"],
        help="Bark delivery level (default: configured level)",
    )
    subparser.add_argument("--group", default=None, help="Bark notification group")


def _cli_run(args) -> int:
    settings = dict(_settings or _DEFAULTS)
    if args.title is not None:
        settings["title"] = args.title
    if args.level is not None:
        settings["level"] = args.level
    if args.group is not None:
        settings["group"] = args.group
    ok = _send(settings["title"], " ".join(args.message), "", settings, url_override=args.url)
    print("Pushed." if ok else "Push failed — check BARK_URL/BARK_KEY and the bark server.")
    return 0 if ok else 1


def register(ctx) -> None:
    global _settings
    _settings = {key: _setting(ctx, key, default) for key, default in _DEFAULTS.items()}
    try:
        float(_settings["min_turn_seconds"])
        float(_settings["debounce_seconds"])
        float(_settings["min_push_interval_seconds"])
    except (TypeError, ValueError):
        logger.warning("bark-notify: invalid numeric settings — falling back to defaults")
        _settings = dict(_DEFAULTS)

    if not os.environ.get(BARK_URL_ENV) or not os.environ.get(BARK_KEY_ENV):
        logger.info(
            "bark-notify: %s/%s not set in the environment — plugin registered but idle",
            BARK_URL_ENV,
            BARK_KEY_ENV,
        )

    ctx.register_hook("on_stream_start", _on_stream_start)
    ctx.register_hook("on_stream_end", _on_stream_end)
    ctx.register_cli_command(
        "bark",
        help="Send a push notification to your phone via Bark",
        description="Push a custom notification through the bark-server relay.",
        setup_fn=_cli_setup,
        handler_fn=_cli_run,
    )
    logger.debug("bark-notify: registered stream hooks and CLI command")