"""Outbound-only Hermes platform for the Mobile Web Push relay."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Optional

from agent.secret_scope import UnscopedSecretError as _UnscopedSecretError
from agent.secret_scope import get_secret as _scoped_get_secret
from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import BasePlatformAdapter, SendResult

logger = logging.getLogger(__name__)

PLATFORM_NAME = "webpush"
TOKEN_ENV = "HERMES_WEB_PUSH_TOKEN"
HOME_CHANNEL_ENV = "WEBPUSH_HOME_CHANNEL"
DEFAULT_TARGET = "all"
MAX_MESSAGE_LENGTH = 500
_HTTP_TIMEOUT = 10


def _get_scoped_secret(name: str, default: str = "") -> str:
    """Read a profile-scoped secret without borrowing another profile's value."""
    try:
        value = _scoped_get_secret(name, default)
    except _UnscopedSecretError:
        value = os.getenv(name, default)
    return str(value if value is not None else default).strip()


def _valid_relay_url(value: str) -> bool:
    try:
        parsed = urllib.parse.urlsplit(str(value or "").strip())
    except ValueError:
        return False
    return (
        parsed.scheme == "https"
        and bool(parsed.netloc)
        and not parsed.username
        and not parsed.password
        and parsed.path.endswith("/v1/notify")
        and not parsed.query
        and not parsed.fragment
    )


def _relay_url(config: PlatformConfig) -> str:
    return str((config.extra or {}).get("relay_url") or "").strip()


def _parse_target_ref(value: str) -> Optional[tuple[str, None]]:
    normalized = str(value or "").strip().lower()
    if normalized in {DEFAULT_TARGET, "broadcast"}:
        return DEFAULT_TARGET, None
    return None


def _validate_target_ref(value: str) -> bool | str:
    if str(value or "").strip().lower() == DEFAULT_TARGET:
        return True
    return "Web Push currently supports only the 'all' subscribed-devices target"


def check_requirements() -> bool:
    return len(_get_scoped_secret(TOKEN_ENV)) >= 32


def validate_config(config: PlatformConfig) -> bool:
    return check_requirements() and _valid_relay_url(_relay_url(config))


def is_connected(config: PlatformConfig) -> bool:
    return validate_config(config)


def _post_notification(
    relay_url: str,
    token: str,
    message: str,
) -> dict[str, Any]:
    payload = {
        "title": "Hermes",
        "body": message[:MAX_MESSAGE_LENGTH],
        "url": "/",
        "tag": "hermes-delivery",
    }
    request = urllib.request.Request(
        relay_url,
        data=json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8"
        ),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "Hermes-Mobile-WebPush",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=_HTTP_TIMEOUT) as response:
            raw = response.read()
            result = json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        return {"error": f"Web Push relay returned HTTP {exc.code}"}
    except (urllib.error.URLError, OSError, TimeoutError):
        return {"error": "Web Push relay is unavailable"}
    except (json.JSONDecodeError, TypeError, ValueError):
        return {"error": "Web Push relay returned an invalid response"}

    if not isinstance(result, dict):
        return {"error": "Web Push relay returned an invalid response"}
    try:
        sent = int(result.get("sent") or 0)
        failed = int(result.get("failed") or 0)
        removed = int(result.get("removed") or 0)
    except (TypeError, ValueError):
        return {"error": "Web Push relay returned an invalid response"}
    if sent == 0 and failed:
        return {"error": "Web Push delivery failed for every subscribed device"}
    if sent == 0:
        return {"error": "No active Web Push subscription accepted the message"}
    return {
        "success": True,
        "platform": PLATFORM_NAME,
        "chat_id": DEFAULT_TARGET,
        "message_id": uuid.uuid4().hex[:12],
        "sent": sent,
        "failed": failed,
        "removed": removed,
    }


async def _deliver(config: PlatformConfig, target: str, message: str) -> dict[str, Any]:
    validation = _validate_target_ref(target)
    if validation is not True:
        return {"error": str(validation)}
    relay_url = _relay_url(config)
    token = _get_scoped_secret(TOKEN_ENV)
    if not _valid_relay_url(relay_url) or len(token) < 32:
        return {"error": "Web Push relay URL or token is not configured"}
    return await asyncio.to_thread(_post_notification, relay_url, token, message)


class WebPushAdapter(BasePlatformAdapter):
    """Delivery-only adapter that broadcasts through the Mobile relay."""

    MAX_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH
    supports_async_delivery = False
    interactive_resume = False

    def __init__(self, config: PlatformConfig):
        super().__init__(config=config, platform=Platform(PLATFORM_NAME))

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        if not validate_config(self.config):
            return False
        self._running = True
        self._mark_connected()
        return True

    async def disconnect(self) -> None:
        self._running = False
        self._mark_disconnected()

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> SendResult:
        result = await _deliver(self.config, chat_id, content)
        if result.get("success"):
            return SendResult(success=True, message_id=result["message_id"])
        return SendResult(
            success=False,
            error=str(result.get("error") or "Delivery failed"),
        )

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        return None

    async def get_chat_info(self, chat_id: str) -> dict[str, Any]:
        return {"name": "All subscribed devices", "type": "broadcast"}


async def _standalone_send(
    config: PlatformConfig,
    chat_id: str,
    message: str,
    *,
    thread_id: Optional[str] = None,
    media_files=None,
    force_document: bool = False,
) -> dict[str, Any]:
    return await _deliver(config, chat_id, message)


def register(ctx) -> None:
    ctx.register_platform(
        name=PLATFORM_NAME,
        label="Hermes Mobile Web Push",
        adapter_factory=lambda config: WebPushAdapter(config),
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        required_env=[TOKEN_ENV],
        cron_deliver_env_var=HOME_CHANNEL_ENV,
        standalone_sender_fn=_standalone_send,
        parse_target_ref_fn=_parse_target_ref,
        validate_target_ref_fn=_validate_target_ref,
        max_message_length=MAX_MESSAGE_LENGTH,
        emoji="🔔",
        pii_safe=True,
        allow_update_command=False,
        platform_hint="Web Push is an outbound-only notification channel.",
    )
