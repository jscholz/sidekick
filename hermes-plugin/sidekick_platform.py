"""Sidekick platform adapter for hermes-agent.

Runs an aiohttp WebSocket server bound to localhost. The sidekick proxy
(Node.js, port 3001) connects as a single persistent client and multiplexes
per-conversation traffic over the WS using ``chat_id``-tagged JSON envelopes.

Why this exists
---------------
Sidekick previously used hermes' OpenAI-compatible ``/v1/responses`` HTTP
endpoint for chat. That path has session-bloat / cold-start / compression
duplication issues because it is fundamentally a **completion** API being
used as a **chat** UI. Switching to a real platform adapter (peer of
telegram/slack/signal) lets the gateway own chat_id → session_id mapping
natively, which is what telegram/slack/etc. do — the bugs disappear.

Wire protocol
-------------
Single persistent WS connection at ``ws://127.0.0.1:<port>/ws``.
Auth: shared secret bearer token in the ``Authorization`` header on the
WS upgrade request, value ``Bearer <token>`` where ``<token>`` is read
from env var ``SIDEKICK_PLATFORM_TOKEN`` at adapter startup.

Inbound (proxy → adapter), all JSON text frames::

    {"type": "message",  "chat_id": "<opaque>", "text": "hello", "attachments": []}
    {"type": "command",  "chat_id": "<opaque>", "command": "new", "args": ""}
    {"type": "voice_dispatch", "chat_id": "<opaque>", "text": "..."}  # from audio bridge

The adapter calls ``self.handle_message(MessageEvent(...))`` which the
gateway resolves to a session via the standard
``build_session_key(SessionSource(platform=Platform.SIDEKICK, chat_id=...))``
DM path — i.e. ``agent:main:sidekick:dm:<chat_id>``.

Outbound (adapter → proxy)::

    # Streaming token deltas during a single agent turn (from edit_message):
    {"type": "reply_delta",     "chat_id": "...", "text": "<full content so far>",
     "message_id": "<adapter-message-id>"}
    # Marks turn end (emitted on the finalize=True edit, or on plain send):
    {"type": "reply_final",     "chat_id": "...", "message_id": "..."}
    # Image emit:
    {"type": "image",           "chat_id": "...", "url": "...", "caption": "..."}
    # Typing indicator (best-effort cosmetic):
    {"type": "typing",          "chat_id": "..."}
    # Push notification (cron output, /background result, scheduled reminder):
    {"type": "notification",    "chat_id": "...", "kind": "cron", "content": "..."}
    # Future Phase-2 envelope: emitted when the gateway compresses a session
    # (proxy uses this to update the sidebar title / new session_id):
    {"type": "session_changed", "chat_id": "...", "session_id": "...", "title": "..."}

The proxy fans these out to the right PWA WebSocket(s) by chat_id.

Limitations / Phase 1 scope
---------------------------
* Single connected proxy client. Second connection replaces the first
  (same-host single-user assumption).
* No reply_to threading, no media beyond URL-encoded images.
* ``session_changed`` envelope is NOT yet emitted — Phase 2 wires this
  via the gateway's compression hook (out of scope for the plugin file
  alone; needs a gateway-side hook). Documented here for Phase 2.

Install
-------
This file targets a hermes patch that adds ``Platform.SIDEKICK`` and the
adapter-factory branch. See ``0001-add-sidekick-platform.patch`` next to
this file. Without that patch the adapter will fail to import.

Once the patch is applied:

  cp sidekick_platform.py ~/.hermes/plugins/sidekick/__init__.py
  cp plugin.yaml          ~/.hermes/plugins/sidekick/plugin.yaml
  echo "plugins:\n  enabled:\n    - sidekick" >> ~/.hermes/config.yaml
  systemctl --user restart hermes-gateway

Or run ``hermes plugins enable sidekick``.

Plugin shape note
-----------------
This file is *also* importable as a hermes plugin module via a tiny
``register(ctx)`` function. The hermes plugin system does NOT have a
``register_platform_adapter`` extension point (yet), so the plugin
``register()`` here is a no-op — the adapter is wired in via the
``_create_adapter()`` factory branch added by the patch. The plugin
manifest exists so ``hermes plugins list`` shows it.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import socket as _socket
import time
import uuid
from typing import Any, Dict, Optional, Set

try:
    from aiohttp import web, WSMsgType
    AIOHTTP_AVAILABLE = True
except ImportError:
    AIOHTTP_AVAILABLE = False
    web = None  # type: ignore[assignment]
    WSMsgType = None  # type: ignore[assignment]

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
)

logger = logging.getLogger(__name__)

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8645
PROTOCOL_VERSION = 1


def check_sidekick_requirements() -> bool:
    """Return True when adapter dependencies are available.

    Required: aiohttp (already a hermes core dep — webhook adapter uses it).
    Required: ``Platform.SIDEKICK`` enum value (added by the hermes patch).
    Required: ``SIDEKICK_PLATFORM_TOKEN`` env var (otherwise we refuse all
    connections — see auth).
    """
    if not AIOHTTP_AVAILABLE:
        logger.warning("[sidekick] aiohttp not installed")
        return False
    if not hasattr(Platform, "SIDEKICK"):
        logger.warning(
            "[sidekick] Platform.SIDEKICK enum missing — apply "
            "0001-add-sidekick-platform.patch in hermes-agent first."
        )
        return False
    return True


class SidekickAdapter(BasePlatformAdapter):
    """Hermes platform adapter speaking JSON-over-WebSocket to the sidekick proxy.

    A single proxy client connects on startup and stays connected; per-
    conversation traffic is multiplexed by ``chat_id`` on every envelope.
    """

    # WS frames are not size-limited the way Telegram messages are, but we
    # still cap individual chunks to keep the JS side responsive.
    MAX_MESSAGE_LENGTH: int = 64 * 1024

    def __init__(self, config: PlatformConfig):
        # Tolerate patch-not-yet-applied so the import doesn't crash gateway
        # startup when the plugin is half-installed; check_sidekick_requirements
        # gates the actual instantiation in _create_adapter().
        platform_value = getattr(Platform, "SIDEKICK", None)
        if platform_value is None:
            raise RuntimeError(
                "Platform.SIDEKICK is not registered. "
                "Apply hermes-plugin/0001-add-sidekick-platform.patch."
            )
        super().__init__(config, platform_value)

        extra = config.extra or {}
        self._host: str = extra.get(
            "host", os.getenv("SIDEKICK_PLATFORM_HOST", DEFAULT_HOST)
        )
        self._port: int = int(
            extra.get("port", os.getenv("SIDEKICK_PLATFORM_PORT", str(DEFAULT_PORT)))
        )
        self._token: str = extra.get(
            "token", os.getenv("SIDEKICK_PLATFORM_TOKEN", "")
        ).strip()

        # aiohttp server primitives
        self._app: Optional[web.Application] = None
        self._runner: Optional[web.AppRunner] = None
        self._site: Optional[web.TCPSite] = None

        # Single connected proxy client. We hold a reference so send() /
        # edit_message() can push outbound envelopes. Replacement-on-reconnect
        # semantics: a new connection closes the old one (same-host, same-user
        # deployment assumption — no multi-tenant sidekicks today).
        self._client_ws: Optional[web.WebSocketResponse] = None
        self._client_lock = asyncio.Lock()

        # chat_ids we've seen at least one inbound message for in this process
        # lifetime. Used by send() to emit a synthetic ``session_changed`` on
        # the *first* outbound for a fresh chat_id. Phase 2 hook will replace
        # this with a real on-compression event.
        self._known_chat_ids: Set[str] = set()

        # Adapter-assigned message ids (returned via SendResult.message_id) so
        # subsequent edit_message calls reference the right outbound bubble on
        # the proxy/PWA side.
        self._message_seq = 0

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def connect(self) -> bool:
        """Bind the WS server, listen for the proxy."""
        if not self._token:
            logger.error(
                "[sidekick] SIDEKICK_PLATFORM_TOKEN unset — refusing to start. "
                "All inbound connections will be rejected without it."
            )
            self._set_fatal_error(
                "missing_token",
                "SIDEKICK_PLATFORM_TOKEN env var is required",
                retryable=False,
            )
            return False

        # Port-conflict pre-check (same pattern as webhook adapter).
        try:
            with _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM) as s:
                s.settimeout(1)
                s.connect(("127.0.0.1", self._port))
            logger.error(
                "[sidekick] Port %d already in use. "
                "Set SIDEKICK_PLATFORM_PORT or platforms.sidekick.port.",
                self._port,
            )
            return False
        except (ConnectionRefusedError, OSError):
            pass  # port is free

        self._app = web.Application()
        self._app.router.add_get("/health", self._handle_health)
        self._app.router.add_get("/ws", self._handle_ws)

        self._runner = web.AppRunner(self._app)
        await self._runner.setup()
        self._site = web.TCPSite(self._runner, self._host, self._port)
        await self._site.start()
        self._mark_connected()

        logger.info(
            "[sidekick] WS server listening on %s:%d (token=%s***)",
            self._host,
            self._port,
            self._token[:4],
        )
        return True

    async def disconnect(self) -> None:
        """Stop accepting new connections, close the active proxy client."""
        async with self._client_lock:
            if self._client_ws is not None and not self._client_ws.closed:
                with contextlib.suppress(Exception):
                    await self._client_ws.close(code=1001, message=b"shutdown")
            self._client_ws = None

        if self._site is not None:
            with contextlib.suppress(Exception):
                await self._site.stop()
            self._site = None
        if self._runner is not None:
            with contextlib.suppress(Exception):
                await self._runner.cleanup()
            self._runner = None
        self._app = None
        self._mark_disconnected()
        logger.info("[sidekick] disconnected")

    # ------------------------------------------------------------------
    # HTTP / WS handlers
    # ------------------------------------------------------------------

    async def _handle_health(self, request: "web.Request") -> "web.Response":
        return web.json_response(
            {
                "status": "ok",
                "platform": "sidekick",
                "protocol_version": PROTOCOL_VERSION,
                "client_connected": self._client_ws is not None
                and not self._client_ws.closed,
            }
        )

    def _check_ws_auth(self, request: "web.Request") -> bool:
        """Validate ``Authorization: Bearer <token>`` on the WS upgrade.

        Returns True iff the request carries the configured shared secret.
        Constant-time comparison.
        """
        import hmac

        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return False
        provided = header[len("Bearer ") :].strip()
        return hmac.compare_digest(provided, self._token)

    async def _handle_ws(self, request: "web.Request") -> "web.WebSocketResponse":
        """Accept the proxy WS connection and pump frames until close."""
        if not self._check_ws_auth(request):
            logger.warning(
                "[sidekick] WS upgrade rejected (bad/missing token) from %s",
                request.remote,
            )
            return web.Response(status=401, text="invalid token")

        ws = web.WebSocketResponse(heartbeat=30.0)
        await ws.prepare(request)

        # Replace any previous client. The sidekick proxy is single-process,
        # single-instance — a re-connect means the old socket is dead.
        async with self._client_lock:
            previous = self._client_ws
            self._client_ws = ws

        if previous is not None and not previous.closed:
            with contextlib.suppress(Exception):
                await previous.close(
                    code=1000, message=b"replaced by new connection"
                )

        # Greet the proxy with the protocol version so it can reject mismatches.
        with contextlib.suppress(Exception):
            await ws.send_json(
                {"type": "hello", "protocol_version": PROTOCOL_VERSION}
            )

        logger.info("[sidekick] proxy connected from %s", request.remote)

        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    await self._handle_inbound_frame(msg.data)
                elif msg.type == WSMsgType.ERROR:
                    logger.warning(
                        "[sidekick] WS error: %s", ws.exception()
                    )
                    break
                # binary / ping / pong / close — ignore (heartbeat handles ping)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("[sidekick] WS handler crashed")
        finally:
            async with self._client_lock:
                if self._client_ws is ws:
                    self._client_ws = None
            logger.info("[sidekick] proxy disconnected")

        return ws

    async def _handle_inbound_frame(self, raw: str) -> None:
        """Parse one JSON frame from the proxy and dispatch."""
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning("[sidekick] non-JSON frame ignored")
            return
        if not isinstance(data, dict):
            logger.warning("[sidekick] non-object frame ignored")
            return

        env_type = data.get("type")
        chat_id = data.get("chat_id")
        if not chat_id or not isinstance(chat_id, str):
            logger.warning("[sidekick] frame missing chat_id; type=%s", env_type)
            return

        if env_type == "message":
            text = data.get("text") or ""
            await self._dispatch_message(
                chat_id=chat_id,
                text=text,
                attachments=data.get("attachments") or [],
            )
        elif env_type == "command":
            command = (data.get("command") or "").lstrip("/")
            args = data.get("args") or ""
            text = f"/{command}" + (f" {args}" if args else "")
            await self._dispatch_message(chat_id=chat_id, text=text)
        elif env_type == "voice_dispatch":
            # Audio bridge transcript — same as a regular text message but the
            # frame type is preserved for future telemetry / TTS auto-toggle.
            text = data.get("text") or ""
            await self._dispatch_message(chat_id=chat_id, text=text)
        elif env_type == "ping":
            # Cosmetic application-level keepalive; ack so the proxy can
            # measure RTT independently of WS-level heartbeats.
            await self._safe_send_envelope({"type": "pong", "chat_id": chat_id})
        else:
            logger.warning(
                "[sidekick] unknown envelope type=%r chat_id=%s",
                env_type,
                chat_id,
            )

    async def _dispatch_message(
        self,
        *,
        chat_id: str,
        text: str,
        attachments: Optional[list] = None,
    ) -> None:
        """Build a MessageEvent and hand it to the gateway core."""
        self._known_chat_ids.add(chat_id)
        source = self.build_source(
            chat_id=chat_id,
            chat_name=f"sidekick:{chat_id[:8]}",
            chat_type="dm",
            user_id=chat_id,        # one user-per-chat in single-tenant model
            user_name="sidekick-user",
        )
        event = MessageEvent(
            text=text or "",
            message_type=MessageType.TEXT,
            source=source,
            message_id=str(uuid.uuid4()),
        )
        await self.handle_message(event)

    # ------------------------------------------------------------------
    # Outbound
    # ------------------------------------------------------------------

    def _next_message_id(self) -> str:
        self._message_seq += 1
        return f"sk-{int(time.time())}-{self._message_seq}"

    async def _safe_send_envelope(self, env: Dict[str, Any]) -> bool:
        """Send a JSON envelope to the proxy if connected. Returns success."""
        ws = self._client_ws
        if ws is None or ws.closed:
            logger.debug("[sidekick] dropping envelope (no client): %s", env.get("type"))
            return False
        try:
            await ws.send_json(env)
            return True
        except Exception as exc:
            logger.warning("[sidekick] send failed (%s): %s", env.get("type"), exc)
            return False

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        """Emit a complete agent turn output as ``reply_delta`` + ``reply_final``.

        The gateway stream consumer calls ``send()`` for the first chunk of a
        response and then ``edit_message(message_id, ...)`` for subsequent
        streaming updates of the same logical bubble. We mirror that on the
        wire: the message_id we return here is what the proxy keys the
        UI bubble on.
        """
        message_id = self._next_message_id()
        # Surface a session_changed envelope the first time we ever see this
        # chat_id outbound. Today the gateway resolves session_id internally
        # so we don't have a stable session_id to surface; emit the chat_id
        # itself (the proxy already knows that) as a no-op stub. Phase 2 will
        # replace this with a real session_id from the gateway hook.
        if chat_id not in self._known_chat_ids:
            self._known_chat_ids.add(chat_id)

        ok = await self._safe_send_envelope(
            {
                "type": "reply_delta",
                "chat_id": chat_id,
                "text": content,
                "message_id": message_id,
            }
        )
        await self._safe_send_envelope(
            {"type": "reply_final", "chat_id": chat_id, "message_id": message_id}
        )
        return SendResult(success=ok, message_id=message_id)

    # The base class default for edit_message returns success=False with
    # "Not supported". Override so the streaming consumer can keep editing the
    # same bubble across token deltas.
    async def edit_message(
        self,
        chat_id: str,
        message_id: str,
        content: str,
        *,
        finalize: bool = False,
    ) -> SendResult:
        await self._safe_send_envelope(
            {
                "type": "reply_delta",
                "chat_id": chat_id,
                "text": content,
                "message_id": message_id,
                "edit": True,
            }
        )
        if finalize:
            await self._safe_send_envelope(
                {
                    "type": "reply_final",
                    "chat_id": chat_id,
                    "message_id": message_id,
                }
            )
        return SendResult(success=True, message_id=message_id)

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        """Best-effort typing indicator. Cosmetic; PWA may ignore."""
        await self._safe_send_envelope({"type": "typing", "chat_id": chat_id})

    async def send_image(
        self,
        chat_id: str,
        image_url: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        """Send an image envelope; PWA renders inline."""
        ok = await self._safe_send_envelope(
            {
                "type": "image",
                "chat_id": chat_id,
                "url": image_url,
                "caption": caption or "",
            }
        )
        return SendResult(success=ok)

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": chat_id, "type": "sidekick", "chat_id": chat_id}


# ---------------------------------------------------------------------------
# Hermes plugin entry point
#
# The plugin manifest (plugin.yaml) ships next to this file; hermes' plugin
# loader will import this module and call ``register(ctx)``. We don't have
# anything to register at the PluginContext level — the platform adapter is
# wired in via the ``_create_adapter`` factory branch added by the patch.
# This stub exists so the plugin shows up in ``hermes plugins list``.
# ---------------------------------------------------------------------------


def register(ctx) -> None:  # noqa: ANN001 — PluginContext type is internal
    """Hermes plugin entry point. No-op today (see module docstring)."""
    logger.debug(
        "[sidekick] plugin register() called — adapter wiring is handled by "
        "the gateway patch. Nothing to register at the PluginContext level."
    )
