"""Sidekick platform adapter for hermes-agent.

Runs an aiohttp HTTP server bound to localhost that speaks the abstract
agent contract (OpenAI-Responses-shaped). The sidekick proxy (Node.js)
talks to it via /v1/* endpoints; the agent contract is documented at
``docs/ABSTRACT_AGENT_PROTOCOL.md`` in the sidekick repo.

Sidekick is a peer of telegram / slack / signal — the hermes gateway
owns the chat_id → session_id mapping natively.

HTTP surface
------------
All routes auth-gate on ``Authorization: Bearer <token>`` where
``<token>`` is read from env var ``SIDEKICK_PLATFORM_TOKEN`` at adapter
startup.

Channel contract (the OAI-compat surface)::

    GET    /health
    GET    /v1/conversations              # drawer list (sidekick rows)
    GET    /v1/conversations/{id}/items   # transcript replay
    DELETE /v1/conversations/{id}         # cascade delete
    POST   /v1/responses                  # turn dispatch (SSE on stream:true)
    GET    /v1/events                     # out-of-turn SSE

Gateway extension (sidekick-defined, optional)::

    GET    /v1/gateway/conversations      # cross-platform drawer list

The proxy probes ``/v1/gateway/conversations`` first; on 404 it falls
back to the channel surface and stamps source='sidekick'. Hermes
implements the gateway endpoint because hermes IS a gateway —
telegram, slack, whatsapp etc. live behind the same state.db.

Inbound dispatch goes through ``/v1/responses`` which calls
``self.handle_message(MessageEvent(...))``. The gateway resolves the
session via the standard
``build_session_key(SessionSource(platform=Platform.SIDEKICK, chat_id=...))``
DM path — ``agent:main:sidekick:dm:<chat_id>``.

Outbound envelope shapes (see SidekickEnvelope in
``server-lib/backends/hermes-gateway/upstream.ts``)::

    {"type": "reply_delta",     "chat_id": "...", "text": "<accumulated>",
     "message_id": "..."}
    {"type": "reply_final",     "chat_id": "...", "message_id": "..."}
    {"type": "image",           "chat_id": "...", "url": "...", "caption": "..."}
    {"type": "typing",          "chat_id": "..."}
    {"type": "notification",    "chat_id": "...", "kind": "cron", "content": "..."}
    {"type": "session_changed", "chat_id": "...", "session_id": "...",
     "title": "..."}
    {"type": "tool_call" / "tool_result" / "error", ...}

In-turn envelopes ride the ``/v1/responses`` SSE stream as OAI events
(translated by the proxy back to the sidekick envelope shape). All
others ride ``/v1/events`` with a Last-Event-ID replay ring.

``session_changed`` is detected via state.db polling
(``_session_poll_loop``) — no hermes core patches required for it.
Trade-off: ~1.5s lag between compression and the PWA seeing the new
title.

PDF rasterization
-----------------
Sidekick PWA uploads of ``application/pdf`` are rasterized to per-page
PNGs in ``_materialize_attachments`` via ``_rasterize_pdf`` (which
shells out to ``pdftoppm`` from poppler-utils). The PDF tempfile is
unlinked after rasterization; the agent only sees images via the
existing ``media_urls`` → vision-tool pipeline. This is sidekick-only
scope — telegram / slack / whatsapp / signal each have separate
attachment flows in ``gateway/platforms/*.py`` and don't share this
materializer (yet).

System dep: ``apt install poppler-utils`` on Debian/Ubuntu, or
``brew install poppler`` on macOS. Without it PDFs are dropped and a
clear error is logged at the first PDF upload attempt.

Knobs (env, with defaults sized for a Pi 5 host):
``SIDEKICK_PDF_DPI`` (150), ``SIDEKICK_PDF_MAX_PAGES`` (50),
``SIDEKICK_PDF_RASTERIZE_TIMEOUT_S`` (30),
``SIDEKICK_PDF_MAX_BYTES`` (20 MiB).

See ``docs/PDF_RASTERIZATION_PROPOSAL.md`` in the sidekick repo for
design notes.

Install
-------
This adapter requires a hermes patch that registers
``Platform.SIDEKICK`` and the adapter-factory branch. See
``0001-add-sidekick-platform.patch`` and ``README.md`` next to this file.

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
import secrets
import socket as _socket
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

try:
    from aiohttp import web
    AIOHTTP_AVAILABLE = True
except ImportError:
    AIOHTTP_AVAILABLE = False
    web = None  # type: ignore[assignment]

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

# ── PDF rasterization knobs ───────────────────────────────────────────
# When the PWA uploads a PDF via /api/sidekick/messages, we shell out to
# `pdftoppm` (poppler-utils) and replace the PDF tempfile with one PNG
# per page so vision-capable models (gemma-3, claude, gpt-4o, gemini)
# see it as N images via the existing media_urls path. The PDF tempfile
# itself is never handed to the agent — vision tools don't consume PDFs.
#
# Tunable via env at adapter startup. Defaults chosen for a Pi 5 host:
#  * 150 DPI keeps PNGs readable for body text without ballooning bytes.
#  * 50-page cap avoids 100-page-deck wedge times (50 pages ≈ 10s).
#  * 30s timeout is the hard ceiling per upload.
#  * 20 MB file-size cap rejects abusive uploads before we shell out.
SIDEKICK_PDF_DPI = int(os.environ.get("SIDEKICK_PDF_DPI", "150"))
SIDEKICK_PDF_MAX_PAGES = int(os.environ.get("SIDEKICK_PDF_MAX_PAGES", "50"))
SIDEKICK_PDF_RASTERIZE_TIMEOUT_S = int(
    os.environ.get("SIDEKICK_PDF_RASTERIZE_TIMEOUT_S", "30")
)
SIDEKICK_PDF_MAX_BYTES = int(
    os.environ.get("SIDEKICK_PDF_MAX_BYTES", str(20 * 1024 * 1024))
)

# ── tool-event hook plumbing ──────────────────────────────────────────
# pre_tool_call / post_tool_call hooks fire from worker threads (the
# agent dispatches tools via run_in_executor — see model_tools.py).
# We need a module-level reference to the live adapter so the sync
# hook callbacks can schedule envelope sends onto the adapter's
# event loop via asyncio.run_coroutine_threadsafe. The adapter sets
# this in connect() (after capturing its loop) and clears it in
# disconnect(). When None, hook handlers drop silently — non-sidekick
# deployments still load the plugin but never fire envelopes.
_active_adapter: Optional["SidekickAdapter"] = None

# Cap on the result string we put into a tool_result envelope. Tools
# can return arbitrarily large blobs (web_extract / browse). The PWA
# does its own per-tool truncation for display, but we cap here too
# so a runaway result can't blow up the WS frame budget.
TOOL_RESULT_MAX_BYTES = 50 * 1024

# /v1/responses streaming + /v1/events out-of-turn channel sizing.
# These bound worst-case memory if a consumer hangs.
TURN_QUEUE_MAX = 1000          # per-chat envelope queue depth
TURN_TIMEOUT_S = 120           # hold a /v1/responses turn open this long
EVENT_REPLAY_CAP = 256         # bounded ring for /v1/events replay


def _iso_from_epoch(t: float) -> str:
    """Render an epoch-seconds timestamp as ISO-8601 UTC."""
    import datetime as _dt
    return _dt.datetime.fromtimestamp(t, tz=_dt.timezone.utc).isoformat()

# ── session_changed polling ───────────────────────────────────────────
# We watch state.db for compression-induced session_id rotations on the
# chat_ids we know about, and emit a `session_changed` envelope to the
# proxy when (session_id, title) changes for a known chat_id. This is
# strictly less invasive than (a) patching hermes to add a callback hook
# or (c) polling from the PWA on tab-focus — the adapter already runs
# in-process with the gateway, so it has direct read access to state.db
# and zero additional moving parts.
#
# Trade-off accepted: ~1s lag between compression and the PWA seeing a
# title refresh. Polling cost is one indexed SELECT per cadence tick;
# negligible at sidekick's single-user scale.
#
# Cadence: every 1.5s while a proxy client is connected. Skipped when
# disconnected (no listener — would be wasted I/O). The first time we
# see a chat_id we record its initial state without emitting; the emit
# only fires on subsequent (session_id, title) changes.
SESSION_POLL_INTERVAL_S = 1.5

# state.db lookup pattern. Matches the session_key shape that
# build_session_key generates for SessionSource(platform=SIDEKICK,
# chat_id=X, chat_type='dm') — `agent:main:sidekick:dm:<chat_id>`.
SESSION_KEY_PREFIX = "agent:main:sidekick:dm:"

# Source allow-list for the cross-platform gateway drawer. Any
# `sessions.source` value not in this set is dropped at query time.
# This is the canonical hermes-agent platform set as of the platform-
# adapter migration; if hermes adds a new platform, drop it in here.
GATEWAY_DRAWER_SOURCES: Tuple[str, ...] = (
    "sidekick",
    "telegram",
    "whatsapp",
    "slack",
    "signal",
    "discord",
    "webhook",
    "openclaw",
)

# Sidekick's own source — used by the channel-only `/v1/conversations`
# endpoint and by tool-event hook resolution (which only cares about
# sidekick sessions; non-sidekick tool calls never make it past the
# adapter's filter).
SIDEKICK_SOURCE: str = "sidekick"


class _SettingsValidationError(ValueError):
    """Raised by _apply_setting when the value is invalid for the
    declared type. Maps to HTTP 400 in _handle_settings_update."""


class _SettingsNotFoundError(KeyError):
    """Raised by _apply_setting when the setting id isn't declared.
    Maps to HTTP 404 in _handle_settings_update."""


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
                "Apply backends/hermes/plugin/0001-add-sidekick-platform.patch."
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

        # chat_ids we've seen at least one inbound message for in this process
        # lifetime. Used by send() to emit a synthetic ``session_changed`` on
        # the *first* outbound for a fresh chat_id; a future on-compression
        # callback would replace this synthetic emission.
        self._known_chat_ids: Set[str] = set()

        # Adapter-assigned message ids (returned via SendResult.message_id) so
        # subsequent edit_message calls reference the right outbound bubble on
        # the proxy/PWA side.
        self._message_seq = 0

        # session_changed polling state. Map of chat_id → (session_id, title)
        # last seen in state.db. We only emit envelopes for transitions —
        # the first observation seeds the cache silently. The poller task is
        # spawned in connect() and cancelled in disconnect().
        self._session_state_cache: Dict[str, Tuple[str, str]] = {}
        self._session_poll_task: Optional[asyncio.Task] = None
        # state.db path resolution. Hermes' own config picks this up from
        # HERMES_STATE_DB or the default ~/.hermes/state.db; we mirror that
        # so the adapter doesn't need a separate env var.
        self._state_db_path: Optional[Path] = self._resolve_state_db_path()

        # Tool-event support (Phase 3). Hooks fire sync from worker threads;
        # we need the adapter's event loop to schedule envelope sends.
        # Captured in connect() once the loop is actually running.
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        # Cache of session_id → chat_id resolved from state.db. Hot-
        # path lookup: we miss + reseed once per session_id so a
        # freshly-rotated session is picked up the moment its first
        # tool fires (after which it lives in cache permanently for
        # this process).
        self._sid_to_chat_id_cache: Dict[str, str] = {}
        # Per-tool_call_id: start time + chat_id, populated in
        # pre_tool_call and consumed in post_tool_call. Bounded by the
        # number of in-flight tools (typically 1, occasionally a few for
        # parallel tool calls). Stale entries (no matching post hook)
        # are unlikely but harmless — capped via the housekeeping check
        # below if it ever grows unreasonably.
        self._inflight_tool_calls: Dict[str, Tuple[float, str]] = {}

        # ── /v1/responses + /v1/events plumbing (refactor step 2) ─────
        # Per-chat-id queue: a /v1/responses request registers its queue
        # here on entry, drains it as the agent emits replies, and
        # removes it on exit. Outbound `_safe_send_envelope` routes
        # in-turn envelopes (reply_delta, reply_final, tool_call,
        # tool_result, typing) to the matching queue if registered.
        self._turn_queues: Dict[str, "asyncio.Queue[Dict[str, Any]]"] = {}
        # /v1/events subscribers: each connected proxy SSE stream owns a
        # queue here; out-of-turn envelopes (notification,
        # session_changed, image, error, plus any in-turn envelope with
        # no active turn queue) get fanned out to all subscribers.
        self._event_subscribers: Set["asyncio.Queue[Tuple[int, Dict[str, Any]]]"] = set()
        # Monotonic id for /v1/events SSE Last-Event-ID replay.
        self._event_id_counter: int = 0
        # Bounded replay ring so a transient /v1/events disconnect can
        # resume without losing recent envelopes.
        self._event_replay_ring: List[Tuple[int, Dict[str, Any]]] = []
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
        # ── Agent contract HTTP routes ────────────────────────────────
        # OAI-Responses-shape surface the proxy talks to. See
        # docs/ABSTRACT_AGENT_PROTOCOL.md for the canonical reference.
        self._app.router.add_get(
            "/v1/conversations", self._handle_list_conversations
        )
        self._app.router.add_get(
            "/v1/conversations/{id}/items", self._handle_get_conversation_items
        )
        self._app.router.add_delete(
            "/v1/conversations/{id}", self._handle_delete_conversation
        )
        # Gateway extension: cross-platform enumeration. Optional second
        # contract (`/v1/gateway/*`) the proxy probes-and-falls-back on.
        # Implemented here because hermes IS a gateway — telegram, slack,
        # whatsapp etc. live behind the same state.db. Stub agents and
        # single-channel agents simply don't expose this prefix; the
        # proxy 404s gracefully back to `/v1/conversations`.
        self._app.router.add_get(
            "/v1/gateway/conversations", self._handle_list_gateway_conversations
        )
        # Turn dispatch + out-of-turn event channel.
        self._app.router.add_post(
            "/v1/responses", self._handle_responses
        )
        self._app.router.add_get(
            "/v1/events", self._handle_events
        )
        # Optional settings extension. Today: a single "model" enum
        # entry that wraps hermes config + the openrouter catalog,
        # filtered by SIDEKICK_PREFERRED_MODELS. Adding more
        # (persona, temperature, ...) is purely additive: extend
        # _build_settings_schema + _apply_setting.
        self._app.router.add_get(
            "/v1/settings/schema", self._handle_settings_schema
        )
        self._app.router.add_post(
            "/v1/settings/{id}", self._handle_settings_update
        )

        self._runner = web.AppRunner(self._app)
        await self._runner.setup()
        self._site = web.TCPSite(self._runner, self._host, self._port)
        await self._site.start()
        self._mark_connected()

        # Capture the running event loop + register as the live adapter so
        # synchronous tool-event hooks (which fire from worker threads via
        # asyncio.run_in_executor in run_agent.py) can schedule envelope
        # sends back onto our loop via run_coroutine_threadsafe.
        self._loop = asyncio.get_running_loop()
        global _active_adapter
        _active_adapter = self

        logger.info(
            "[sidekick] WS server listening on %s:%d (token=%s***)",
            self._host,
            self._port,
            self._token[:4],
        )

        # Ensure the read-side composite index for (user_id, source) is
        # present. The plugin's drawer aggregation + per-chat history
        # query both filter on this pair, and the upstream hermes-agent
        # schema only ships a single-column source index. Idempotent
        # (CREATE INDEX IF NOT EXISTS), best-effort.
        await asyncio.to_thread(self._ensure_state_db_indexes)

        # Spawn the state.db poller for session_changed emission. Logs
        # once at startup so an operator can confirm it's wired.
        if self._state_db_path is not None:
            self._session_poll_task = asyncio.create_task(
                self._session_poll_loop(),
                name="sidekick-session-poll",
            )
            logger.info(
                "[sidekick] session_changed poller armed against %s "
                "(interval=%.1fs)",
                self._state_db_path,
                SESSION_POLL_INTERVAL_S,
            )
        else:
            logger.warning(
                "[sidekick] state.db path not resolved — "
                "session_changed envelopes will not be emitted"
            )
        return True

    async def disconnect(self) -> None:
        """Stop accepting new connections, close the active proxy client."""
        # Drop the module-level live-adapter pointer FIRST so any in-flight
        # hook callback that fires during shutdown becomes a silent no-op
        # rather than racing against a half-closed loop / socket.
        global _active_adapter
        if _active_adapter is self:
            _active_adapter = None
        self._loop = None

        # Cancel the session poller before tearing down the WS so it can't
        # fire envelopes into a half-closed socket.
        if self._session_poll_task is not None:
            self._session_poll_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._session_poll_task
            self._session_poll_task = None

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
            }
        )

    async def _dispatch_message(
        self,
        *,
        chat_id: str,
        text: str,
        attachments: Optional[list] = None,
    ) -> None:
        """Build a MessageEvent and hand it to the gateway core.

        ``attachments`` is the array the PWA collects from the camera /
        image picker — each entry ``{type, mimeType, fileName,
        content}`` where ``content`` is a ``data:`` URL. We write each
        payload to a tempfile and pass the paths via ``media_urls``,
        matching how the telegram adapter populates downloaded photos
        (``gateway/platforms/telegram.py``). Hermes' vision tools read
        ``media_urls`` directly off the MessageEvent.
        """
        self._known_chat_ids.add(chat_id)
        source = self.build_source(
            chat_id=chat_id,
            chat_name=f"sidekick:{chat_id[:8]}",
            chat_type="dm",
            user_id=chat_id,        # one user-per-chat in single-tenant model
            user_name="sidekick-user",
        )

        media_urls: List[str] = []
        media_types: List[str] = []
        message_type = MessageType.TEXT
        if attachments:
            paths, mimes, dominant = self._materialize_attachments(attachments)
            if paths:
                media_urls = paths
                media_types = mimes
                message_type = dominant
                # Tempfiles outlive the turn intentionally. The agent
                # may follow up with `vision_analyze` after `reply_final`
                # (e.g. user asks "look closer at page 2"), and an
                # eager end-of-turn unlink races with that — observed
                # via vision_analyze raising "Invalid image source"
                # because the PNG was already gone. /tmp is swept by
                # systemd-tmpfiles on its own schedule (10d default on
                # Pi OS); single-user/single-host means stray PNGs are
                # harmless until then.

        event = MessageEvent(
            text=text or "",
            message_type=message_type,
            source=source,
            message_id=str(uuid.uuid4()),
            media_urls=media_urls,
            media_types=media_types,
        )
        await self.handle_message(event)

    @staticmethod
    def _rasterize_pdf(path: Path) -> List[Path]:
        """Rasterize a PDF to per-page PNG files alongside the source.

        Shells out to ``pdftoppm`` (poppler-utils). Output PNGs land in
        the same directory as ``path`` with the input stem as their
        prefix; pdftoppm names them ``<prefix>-<N>.png`` (zero-padded
        when there are 10+ pages, plain otherwise).

        Limits — all overridable via env (see module-level constants):

        * ``SIDEKICK_PDF_MAX_BYTES`` (default 20 MB): if the PDF on disk
          exceeds this, we log a warning and return ``[]`` — caller
          drops the attachment, agent sees no images for it.
        * ``SIDEKICK_PDF_MAX_PAGES`` (default 50): passed to pdftoppm
          via ``-l N`` so it stops after N pages.
        * ``SIDEKICK_PDF_DPI`` (default 150): ``-r N``.
        * ``SIDEKICK_PDF_RASTERIZE_TIMEOUT_S`` (default 30): subprocess
          timeout. On expiry we log + return ``[]``; the request
          continues without crashing.

        On any failure (encrypted/corrupt PDF → non-zero exit, missing
        ``pdftoppm`` binary, timeout) returns ``[]``. Never raises.
        """
        import subprocess

        try:
            file_size = path.stat().st_size
        except OSError as exc:
            logger.warning("[hermes-plugin] PDF stat failed (%s): %s", path, exc)
            return []

        if file_size > SIDEKICK_PDF_MAX_BYTES:
            logger.warning(
                "[hermes-plugin] PDF %s rejected: %dB > %dB cap",
                path, file_size, SIDEKICK_PDF_MAX_BYTES,
            )
            return []

        # pdftoppm writes <prefix>-1.png, <prefix>-2.png ... in the
        # parent dir. Use the input's stem as the prefix so cleanup
        # (which already walks the per-turn paths list) is uniform.
        prefix = str(path.with_suffix(""))
        cmd = [
            "pdftoppm",
            "-png",
            "-r", str(SIDEKICK_PDF_DPI),
            "-l", str(SIDEKICK_PDF_MAX_PAGES),
            str(path),
            prefix,
        ]
        try:
            subprocess.run(
                cmd,
                capture_output=True,
                timeout=SIDEKICK_PDF_RASTERIZE_TIMEOUT_S,
                check=True,
            )
        except FileNotFoundError:
            logger.error(
                "[hermes-plugin] pdftoppm not installed — PDF rasterization "
                "disabled. Install via `apt install poppler-utils` "
                "(Debian/Ubuntu) or `brew install poppler` (macOS)."
            )
            return []
        except subprocess.TimeoutExpired:
            logger.warning(
                "[hermes-plugin] pdftoppm timeout (>%ds) on %s — dropping",
                SIDEKICK_PDF_RASTERIZE_TIMEOUT_S, path,
            )
            return []
        except subprocess.CalledProcessError as exc:
            stderr = (exc.stderr or b"").decode(errors="ignore")[:200]
            logger.warning(
                "[hermes-plugin] pdftoppm failed on %s (rc=%d): %s",
                path, exc.returncode, stderr,
            )
            return []

        # Collect outputs. pdftoppm uses 1-based numbering; for ≤9
        # pages it writes "<prefix>-1.png" .. "<prefix>-9.png", for 10+
        # it zero-pads to the width of the page count
        # ("<prefix>-01.png" etc). Glob covers both shapes.
        parent = path.parent
        stem = path.stem
        pages = sorted(parent.glob(f"{stem}-*.png"))
        if not pages:
            logger.warning(
                "[hermes-plugin] pdftoppm produced no output for %s", path,
            )
            return []

        logger.info(
            "[hermes-plugin] rasterized %d pages from %s (%dp, %dB)",
            len(pages), path, len(pages), file_size,
        )
        return pages

    def _materialize_attachments(
        self, attachments: list,
    ) -> Tuple[List[str], List[str], "MessageType"]:
        """Decode base64 ``data:`` URL payloads to tempfiles. Returns
        ``(paths, mime_types, dominant_message_type)``.

        The PWA sends each attachment as
        ``{type, mimeType, fileName, content}`` where ``content`` is a
        full ``data:<mime>;base64,<payload>`` string. Hermes wants
        on-disk paths in ``MessageEvent.media_urls`` (telegram adapter
        models this — it downloads photos to a cache dir, then sets
        media_urls to those paths). We mirror that contract for the
        sidekick path: write to ``/tmp/sidekick-attach-<uuid>.<ext>``
        and let the OS clean tmpdirs on its own schedule (sidekick is
        single-user, single-host; a stray /tmp file is harmless).

        PDF attachments are rasterized server-side before they reach
        the agent: ``application/pdf`` payloads get written to a temp
        ``.pdf``, then ``_rasterize_pdf`` shells out to ``pdftoppm`` and
        replaces the PDF entry with one ``image/png`` entry per page.
        Vision-capable models (gemma-3, claude, gpt-4o, gemini) consume
        images natively, not PDFs — this keeps the existing media_urls
        → vision-tool pipeline doing all the work without each model
        backend needing to know about PDFs. The PDF tempfile itself is
        deleted as soon as rasterization completes; only the PNG pages
        are returned (and tracked for end-of-turn cleanup).

        Sidekick-only scope: telegram/whatsapp/slack/signal each have
        their own platform adapters with separate attachment flows
        (``gateway/platforms/*.py``). Cross-channel PDF support is a
        follow-up.
        """
        import base64
        import tempfile

        paths: List[str] = []
        mimes: List[str] = []
        kinds: List[str] = []
        for a in attachments:
            if not isinstance(a, dict):
                continue
            content = a.get("content")
            if not isinstance(content, str) or not content.startswith("data:"):
                continue
            try:
                header, b64 = content.split(",", 1)
            except ValueError:
                continue
            # header looks like 'data:image/png;base64' — pull mime.
            mime = a.get("mimeType") or ""
            if not mime and ";" in header:
                mime = header.split(":", 1)[1].split(";", 1)[0]
            try:
                payload = base64.b64decode(b64, validate=False)
            except Exception:
                logger.warning("[sidekick] base64 decode failed for attachment")
                continue
            ext = self._ext_for_mime(mime, a.get("fileName"))
            fd, path = tempfile.mkstemp(
                prefix="sidekick-attach-", suffix=ext, dir="/tmp",
            )
            try:
                with os.fdopen(fd, "wb") as f:
                    f.write(payload)
            except Exception:
                logger.exception("[sidekick] failed writing attachment to %s", path)
                continue
            # PDFs: rasterize to N PNGs, drop the original PDF tempfile,
            # and append the pages to the output instead. On any
            # rasterization failure (oversize, encrypted, missing
            # binary, timeout) _rasterize_pdf returns [] — we still
            # drop the PDF; the agent gets no images for it but the
            # turn proceeds normally.
            if mime.lower() == "application/pdf":
                pdf_path = Path(path)
                pages = self._rasterize_pdf(pdf_path)
                try:
                    pdf_path.unlink()
                except OSError:
                    pass
                for page in pages:
                    paths.append(str(page))
                    mimes.append("image/png")
                    kinds.append("image")
                continue
            paths.append(path)
            mimes.append(mime)
            kinds.append(self._kind_for_mime(mime))
        if not paths:
            return [], [], MessageType.TEXT
        # Pick a dominant message_type. Sidekick almost always sends a
        # single image; fall back to the first kind otherwise. Note:
        # rasterized PDFs leave behind only "image" kinds, so they
        # correctly resolve to PHOTO here.
        dominant = MessageType.PHOTO
        first = kinds[0] if kinds else "image"
        if first == "video":
            dominant = MessageType.VIDEO
        elif first == "audio":
            dominant = MessageType.AUDIO
        elif first == "document":
            dominant = MessageType.DOCUMENT
        return paths, mimes, dominant

    @staticmethod
    def _ext_for_mime(mime: str, file_name: Optional[str]) -> str:
        # Prefer the original filename's extension if present (preserves
        # JPEG vs PNG vs HEIC etc. for downstream tools that care).
        if file_name and "." in file_name:
            return "." + file_name.rsplit(".", 1)[-1].lower()
        if not mime:
            return ""
        # Lightweight mime → ext map. Don't pull mimetypes module just
        # for half a dozen entries.
        m = mime.lower()
        if m == "image/png": return ".png"
        if m == "image/jpeg" or m == "image/jpg": return ".jpg"
        if m == "image/webp": return ".webp"
        if m == "image/gif": return ".gif"
        if m == "image/heic": return ".heic"
        if m == "video/mp4": return ".mp4"
        if m == "video/quicktime": return ".mov"
        if m == "audio/mpeg" or m == "audio/mp3": return ".mp3"
        if m == "audio/wav": return ".wav"
        if m == "application/pdf": return ".pdf"
        return ""

    @staticmethod
    def _kind_for_mime(mime: str) -> str:
        m = (mime or "").lower()
        if m.startswith("image/"): return "image"
        if m.startswith("video/"): return "video"
        if m.startswith("audio/"): return "audio"
        return "document"

    # ------------------------------------------------------------------
    # HTTP read endpoints (agent contract Phase 1)
    # ------------------------------------------------------------------
    #
    # These mirror the abstract agent protocol's
    # /v1/conversations* endpoints (see docs/ABSTRACT_AGENT_PROTOCOL.md).
    # The same in-process state.db reads the session poller does back
    # them; no separate direct-state access path needed.

    def _check_http_auth(self, request: "web.Request") -> bool:
        """Validate ``Authorization: Bearer <token>``. Constant-time."""
        import hmac

        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return False
        provided = header[len("Bearer ") :].strip()
        return hmac.compare_digest(provided, self._token)

    async def _handle_list_conversations(self, request: "web.Request") -> "web.Response":
        """GET /v1/conversations — return the sidekick-only drawer list.

        Channel-only counterpart to the cross-platform
        ``/v1/gateway/conversations``. Single-channel agents (stub,
        third-party OAI-compat agents that aren't gateways) implement
        only this. The proxy probes the gateway endpoint first and
        falls back here on 404, stamping ``source: 'sidekick'``."""
        if not self._check_http_auth(request):
            return web.Response(status=401, text="invalid token")
        try:
            limit = max(1, min(int(request.query.get("limit", "50")), 200))
        except ValueError:
            return web.Response(status=400, text="invalid limit")

        rows = await asyncio.to_thread(
            self._summaries_by_user_id, (SIDEKICK_SOURCE,), limit,
        )
        data = [
            {
                "id": chat_id,
                "object": "conversation",
                "created_at": int(created_at),
                "metadata": {
                    "title": title or "",
                    "message_count": message_count,
                    "last_active_at": int(last_active_at),
                    "first_user_message": first_user_message,
                },
            }
            for (chat_id, _source, _chat_type, title, message_count,
                 last_active_at, created_at, first_user_message) in rows
        ]
        return web.json_response({"object": "list", "data": data})

    async def _handle_get_conversation_items(self, request: "web.Request") -> "web.Response":
        """GET /v1/conversations/{id}/items — transcript replay.

        Aggregates messages across every state.db session whose
        ``(user_id, source)`` matches this chat. user_id IS the
        platform chat_id; rotations under the hood (compression forks
        AND session_reset auto-reset) all roll up into a single flat
        transcript ordered by ``(timestamp ASC, id ASC)``.

        Source is resolved at query time by probing state.db for any
        source associated with this user_id, preferring ``sidekick``
        on a collision (sidekick chat_ids are UUIDs, telegram chat_ids
        are short ints, so collisions are vanishingly unlikely in
        practice but the deterministic preference keeps behavior
        reproducible)."""
        if not self._check_http_auth(request):
            return web.Response(status=401, text="invalid token")
        chat_id = request.match_info["id"]
        try:
            limit = max(1, min(int(request.query.get("limit", "200")), 500))
        except ValueError:
            return web.Response(status=400, text="invalid limit")
        before = request.query.get("before")
        before_id: Optional[int]
        if before is None:
            before_id = None
        else:
            try:
                before_id = int(before)
            except ValueError:
                return web.Response(status=400, text="invalid before cursor")

        source = await asyncio.to_thread(self._resolve_source_for_chat_id, chat_id)
        if source is None:
            return web.Response(status=404, text="conversation not found")

        result = await asyncio.to_thread(
            self._items_by_user_id, chat_id, source, limit, before_id,
        )
        if result is None:
            return web.Response(status=404, text="conversation not found")
        items, first_id, has_more = result
        return web.json_response({
            "object": "list",
            "data": items,
            "first_id": first_id,
            "has_more": has_more,
        })

    async def _handle_list_gateway_conversations(
        self, request: "web.Request"
    ) -> "web.Response":
        """GET /v1/gateway/conversations — cross-platform drawer list.

        Same OAI-compat row shape as `/v1/conversations` (`{id, object,
        created_at, metadata}`), but enumerates every platform in
        state.db (telegram / slack / whatsapp / sidekick / …) and adds
        `source` + `chat_type` to `metadata` so the proxy can render
        per-row badges. Sidekick's drawer relies on this for
        cross-platform visibility; non-sidekick rows are read-only.

        Backed by `_summaries_by_user_id` which groups state.db rows by
        `(user_id, source)` — chat_id IS user_id at the gateway. This
        means rotated session_ids (auto-reset, compression) all roll
        up into a single drawer entry; the previous sessions.json walk
        only saw the currently-active session per chat and lost the
        rest after rotation.

        Implementing this endpoint is what makes a plugin a "gateway" in
        sidekick's eyes. Single-channel agents (stub, openai-compat
        third-parties) leave it unimplemented and the proxy falls back
        to `/v1/conversations`."""
        if not self._check_http_auth(request):
            return web.Response(status=401, text="invalid token")
        try:
            limit = max(1, min(int(request.query.get("limit", "50")), 200))
        except ValueError:
            return web.Response(status=400, text="invalid limit")

        rows = await asyncio.to_thread(
            self._summaries_by_user_id, GATEWAY_DRAWER_SOURCES, limit,
        )
        data = [
            {
                "id": chat_id,
                "object": "conversation",
                "created_at": int(created_at),
                "metadata": {
                    "title": title or "",
                    "message_count": message_count,
                    "last_active_at": int(last_active_at),
                    "first_user_message": first_user_message,
                    "source": source,
                    "chat_type": chat_type,
                },
            }
            for (chat_id, source, chat_type, title, message_count,
                 last_active_at, created_at, first_user_message) in rows
        ]
        return web.json_response({"object": "list", "data": data})

    async def _handle_delete_conversation(self, request: "web.Request") -> "web.Response":
        """DELETE /v1/conversations/{id} — hard delete with full cascade.

        Cascade ordering:
          1. state.db (sessions + messages rows)
          2. ~/.hermes/sessions/sessions.json (key removal)
          3. ~/.hermes/sessions/<sid>.jsonl (transcript file)
          4. Hindsight bank (memory units tagged with this session UUID)

        Best-effort on each step — sql failure aborts (the cascade can't
        proceed without knowing which session_id to scrub), filesystem
        failures log + continue, hindsight failures log + continue
        (privacy bug if hindsight scrub fails, but a stranded memory
        row is less bad than a stranded session row that re-ghosts the
        drawer)."""
        if not self._check_http_auth(request):
            return web.Response(status=401, text="invalid token")
        chat_id = request.match_info["id"]
        result = await asyncio.to_thread(self._delete_conversation_sync, chat_id)
        if result == "not_found":
            return web.Response(status=404, text="conversation not found")
        if result == "error":
            return web.Response(status=500, text="delete failed")
        # Drop from in-process caches so the next list/poll doesn't
        # resurrect the row from stale state.
        self._session_state_cache.pop(chat_id, None)
        for sid in [s for s, c in self._sid_to_chat_id_cache.items() if c == chat_id]:
            self._sid_to_chat_id_cache.pop(sid, None)
        return web.json_response({"ok": True})

    # ── user_id-keyed read path (chat_id is the durable identity) ────
    #
    # Background: an earlier iteration of this plugin walked
    # ``~/.hermes/sessions/sessions.json``, which only points at the
    # *currently active* session for each session_key. When hermes
    # auto-reset rotates a session for a chat_id, the old session
    # loses its sessions.json mapping but state.db keeps the row with
    # ``user_id = <chat_id>``. The drawer then hid the old session
    # entirely and the history fetch only walked the
    # ``parent_session_id`` chain (which compression sets but
    # session_reset doesn't), so messages from rotated-out sessions
    # stopped being visible even though they were still in state.db.
    #
    # Fix: query state.db directly by ``(user_id, source)``, since
    # user_id IS the platform chat_id. The session_id rotation under
    # the hood is invisible to sidekick — every session that ever
    # belonged to this chat aggregates into one drawer row and replays
    # as one transcript. Compression-fork chains are subsumed (their
    # rows share user_id), so the recursive parent_session_id CTE is
    # no longer needed.
    #
    # Cross-platform safety: every query filters on ``user_id +
    # source`` together. Two platforms could in theory mint the same
    # chat_id (telegram numeric id vs sidekick UUID), but the source
    # discriminator keeps them distinct.

    def _summaries_by_user_id(
        self, sources: Tuple[str, ...], limit: int,
    ) -> list:
        """Drawer aggregation grouped by ``(user_id, source)``.

        Returns ``[(chat_id, source, chat_type, title, message_count,
        last_active_at, created_at, first_user_message), …]`` sorted
        most-recently-active first, bounded by ``limit``.

        ``sources`` is the platform allow-list — any non-empty
        ``sessions.source`` is included if its value is in this tuple.
        Pass ``("sidekick",)`` for the channel-only drawer; pass the
        full set (sidekick, telegram, slack, whatsapp, …) for the
        cross-platform gateway drawer.

        chat_type is fixed to "dm" because state.db doesn't carry it
        explicitly. The plugin's existing surface only exposed DM
        chats; group/channel inference would need an out-of-band
        signal (room id parsing) which lives in the platform adapters,
        not here.

        ``parent_session_id`` chains (compression forks) are not
        deduplicated — they inherit the same ``user_id`` from the
        root, so SUM(message_count) and the title/first_user_message
        subqueries already dispatch by ``user_id`` correctly. Where it
        DOES matter: ``ORDER BY started_at DESC LIMIT 1`` for the
        title pulls the *latest* session for the chat (whatever
        compression and session_reset did), which is what the drawer
        wants.
        """
        if self._state_db_path is None or not self._state_db_path.exists():
            return []
        if not sources:
            return []
        src_csv = ",".join(["?"] * len(sources))
        # One pass per user_id+source pair:
        #   * MIN(started_at) — oldest session = drawer "created_at"
        #   * MAX over message timestamps — drawer "last_active_at"
        #   * SUM(COUNT(messages)) — total message_count across rotations
        #   * latest session's title (ORDER BY started_at DESC LIMIT 1)
        #   * very first user message ever (ORDER BY timestamp ASC LIMIT 1
        #     across all sessions for this user_id+source)
        sql = f"""
            SELECT
                s.user_id,
                s.source,
                MIN(COALESCE(s.started_at, 0)) AS created_at,
                COALESCE(MAX(
                    (SELECT COALESCE(MAX(m.timestamp), s.started_at)
                       FROM messages m WHERE m.session_id = s.id)
                ), 0) AS last_active_at,
                SUM(
                    (SELECT COUNT(*) FROM messages m
                       WHERE m.session_id = s.id)
                ) AS message_count,
                (SELECT COALESCE(s2.title, '')
                   FROM sessions s2
                   WHERE s2.user_id = s.user_id AND s2.source = s.source
                   ORDER BY s2.started_at DESC LIMIT 1) AS title,
                (SELECT m.content FROM messages m
                   JOIN sessions s3 ON m.session_id = s3.id
                   WHERE s3.user_id = s.user_id AND s3.source = s.source
                     AND m.role = 'user'
                   ORDER BY m.timestamp ASC, m.id ASC LIMIT 1
                ) AS first_user_message
            FROM sessions s
            WHERE s.user_id IS NOT NULL
              AND s.source IN ({src_csv})
            GROUP BY s.user_id, s.source
            ORDER BY last_active_at DESC
            LIMIT ?
        """
        params = list(sources) + [limit]
        uri = f"file:{self._state_db_path}?mode=ro"
        with contextlib.closing(
            sqlite3.connect(uri, uri=True, timeout=2.0)
        ) as conn:
            rows = conn.execute(sql, params).fetchall()
        out = []
        for user_id, source, created_at, last_active_at, mcount, title, first_user in rows:
            if not user_id:
                continue
            first_user_truncated = (first_user or "")[:80] or None
            out.append((
                user_id, source, "dm", title or "", int(mcount or 0),
                float(last_active_at or 0), float(created_at or 0),
                first_user_truncated,
            ))
        return out

    def _resolve_source_for_chat_id(self, chat_id: str) -> Optional[str]:
        """Pick a `sessions.source` for this chat_id.

        Used by the per-chat history handler, which doesn't carry a
        source on the URL. Prefers ``sidekick`` on a collision so the
        composer-editable behavior in the PWA stays consistent for
        sidekick-native chats; falls back to whatever source state.db
        has for the user_id otherwise (telegram, slack, etc.).

        Returns None when no session exists for the chat_id (treated
        as 404 by the caller).
        """
        if self._state_db_path is None or not self._state_db_path.exists():
            return None
        uri = f"file:{self._state_db_path}?mode=ro"
        with contextlib.closing(
            sqlite3.connect(uri, uri=True, timeout=2.0)
        ) as conn:
            rows = conn.execute(
                "SELECT DISTINCT source FROM sessions WHERE user_id = ?",
                (chat_id,),
            ).fetchall()
        sources = [r[0] for r in rows if r and r[0]]
        if not sources:
            return None
        if SIDEKICK_SOURCE in sources:
            return SIDEKICK_SOURCE
        return sources[0]

    def _items_by_user_id(
        self,
        chat_id: str,
        source: str,
        limit: int,
        before_id: Optional[int],
    ) -> Optional[Tuple[list, Optional[int], bool]]:
        """Transcript replay across every session that ever belonged
        to ``(user_id=chat_id, source)``.

        Returns ``(items, first_id, has_more)`` or ``None`` when no
        sessions exist for the pair (treated as 404 by the route
        handler).

        Replaces the old ``_read_conversation_items`` recursive CTE
        over ``parent_session_id``. Rotations done by session_reset
        (which doesn't set parent_session_id) used to drop messages
        from history; this query picks them up because they share
        user_id.

        Honors ``before_id`` for lazy paging: when set, only messages
        with ``id < before_id`` are returned.
        """
        if self._state_db_path is None or not self._state_db_path.exists():
            return None
        sql = """
            SELECT m.id, m.role, m.content, m.tool_name, m.timestamp
            FROM messages m
            JOIN sessions s ON m.session_id = s.id
            WHERE s.user_id = ? AND s.source = ?
        """
        params: list = [chat_id, source]
        if before_id is not None:
            sql += " AND m.id < ?"
            params.append(before_id)
        sql += " ORDER BY m.timestamp ASC, m.id ASC"
        uri = f"file:{self._state_db_path}?mode=ro"
        with contextlib.closing(
            sqlite3.connect(uri, uri=True, timeout=2.0)
        ) as conn:
            # Existence check first so we can return 404 vs. an empty
            # but valid transcript. A user_id with no messages yet
            # (e.g. just-created chat that hasn't sent its first turn)
            # still exists; the items list will be empty.
            exists_row = conn.execute(
                "SELECT 1 FROM sessions WHERE user_id = ? AND source = ? LIMIT 1",
                (chat_id, source),
            ).fetchone()
            if exists_row is None:
                return None
            rows = list(conn.execute(sql, params).fetchall())
        items = []
        for row_id, role, content, tool_name, ts in rows:
            text = (content or "")
            if text.startswith("[CONTEXT COMPACTION"):
                continue
            item: Dict[str, Any] = {
                "id": int(row_id),
                "object": "message",
                "role": role,
                "content": text,
                "created_at": int(ts) if ts else 0,
            }
            if tool_name:
                item["tool_name"] = tool_name
            items.append(item)
        # Same pagination semantics as the legacy path:
        #  * before_id=None → most-recent `limit` items, has_more=True
        #    when we truncated.
        #  * before_id set → user is paging backward; return up to
        #    `limit` items older than the cursor, has_more=True if a
        #    full page came back.
        first_id = items[0]["id"] if items else None
        if before_id is None and len(items) > limit:
            items = items[-limit:]
            first_id = items[0]["id"] if items else None
            has_more = True
        elif before_id is not None and len(items) >= limit:
            items = items[:limit]
            has_more = True
        else:
            has_more = False
        return (items, first_id, has_more)

    def _delete_conversation_sync(self, chat_id: str) -> str:
        """Synchronous cascade delete. Returns 'ok', 'not_found', or
        'error'. Worker-thread safe.

        Resolves the set of session_ids to scrub via
        ``WHERE user_id = chat_id AND source = 'sidekick'`` — picks up
        every session that ever belonged to this chat (compression
        forks AND auto-reset rotations), no recursive parent-chain
        walk needed."""
        if self._state_db_path is None or not self._state_db_path.exists():
            return "error"
        try:
            with contextlib.closing(sqlite3.connect(self._state_db_path, timeout=5.0)) as conn:
                conn.execute("PRAGMA foreign_keys = ON")
                with conn:
                    rows = conn.execute(
                        "SELECT id FROM sessions "
                        "WHERE user_id = ? AND source = ?",
                        (chat_id, SIDEKICK_SOURCE),
                    ).fetchall()
                    fork_sids = [r[0] for r in rows]
                    if not fork_sids:
                        return "not_found"
                    placeholders = ",".join(["?"] * len(fork_sids))
                    conn.execute(
                        f"DELETE FROM messages WHERE session_id IN ({placeholders})",
                        fork_sids,
                    )
                    conn.execute(
                        f"DELETE FROM sessions WHERE id IN ({placeholders})",
                        fork_sids,
                    )
        except Exception as exc:
            logger.warning("[sidekick] state.db delete failed for chat_id=%s: %s", chat_id, exc)
            return "error"
        # sessions.json: scrub the sidekick key. This is the only
        # remaining sessions.json read site in the plugin — the read
        # side (drawer + history + chat_id resolution + poller) all
        # query state.db now. The cascade still touches sessions.json
        # because hermes-agent's session machinery owns that file and
        # would resurrect the key if we left a stale entry.
        sessions_index = self._state_db_path.parent / "sessions" / "sessions.json"
        try:
            if sessions_index.exists():
                with open(sessions_index, encoding="utf-8") as f:
                    idx = json.load(f)
                key = f"{SESSION_KEY_PREFIX}{chat_id}"
                if isinstance(idx, dict) and key in idx:
                    del idx[key]
                    tmp = sessions_index.with_suffix(f".tmp.{os.getpid()}")
                    with open(tmp, "w", encoding="utf-8") as f:
                        json.dump(idx, f, indent=2)
                    os.replace(tmp, sessions_index)
        except Exception as exc:
            logger.warning("[sidekick] sessions.json scrub failed: %s", exc)
        # jsonl transcripts.
        for sid in fork_sids:
            jsonl = self._state_db_path.parent / "sessions" / f"{sid}.jsonl"
            try:
                if jsonl.exists():
                    jsonl.unlink()
            except Exception as exc:
                logger.warning("[sidekick] jsonl unlink failed for sid=%s: %s", sid, exc)
        # Hindsight cascade (privacy-critical — closes the regression
        # introduced in the platform-adapter migration where the new
        # delete path skipped the hindsight scrub the legacy path had).
        try:
            self._purge_hindsight_for_session_uuids(fork_sids)
        except Exception as exc:
            logger.warning("[sidekick] hindsight purge failed: %s", exc)
        return "ok"

    def _purge_hindsight_for_session_uuids(self, session_uuids: list) -> None:
        """Delete hindsight memories tagged with any of these session
        UUIDs. Reads hindsight URL + bank from env; no-op if hindsight
        isn't configured (local-only deployments without a memory store).

        Two storage shapes (both handled by the proxy's existing
        purgeHindsightSession in TS — we mirror the logic here):
          1. Live retains (document.id == session UUID): direct DELETE.
          2. Backfilled docs (random doc.id, session UUID in metadata):
             paginated metadata sweep.

        Best-effort: hindsight unreachable is logged but not fatal."""
        url = os.getenv("HINDSIGHT_URL", "").strip() or os.getenv("SIDEKICK_HINDSIGHT_URL", "").strip()
        if not url:
            return
        bank = os.getenv("HINDSIGHT_BANK", "").strip() or os.getenv("SIDEKICK_HINDSIGHT_BANK", "jonathan").strip()
        api_key = os.getenv("HINDSIGHT_API_KEY", "").strip() or os.getenv("SIDEKICK_HINDSIGHT_API_KEY", "").strip()
        try:
            import urllib.request
            import urllib.parse
            headers = {"content-type": "application/json"}
            if api_key:
                headers["authorization"] = f"Bearer {api_key}"
            for sid in session_uuids:
                target = f"{url}/v1/default/banks/{urllib.parse.quote(bank, safe='')}/documents/{urllib.parse.quote(sid, safe='')}"
                req = urllib.request.Request(target, method="DELETE", headers=headers)
                try:
                    with urllib.request.urlopen(req, timeout=5.0) as resp:
                        if resp.status not in (200, 204, 404):
                            logger.warning("[sidekick] hindsight DELETE returned %s for sid=%s", resp.status, sid)
                except urllib.error.HTTPError as e:
                    if e.code != 404:
                        logger.warning("[sidekick] hindsight DELETE returned %s for sid=%s", e.code, sid)
                except Exception as exc:
                    logger.warning("[sidekick] hindsight DELETE failed for sid=%s: %s", sid, exc)
        except Exception as exc:
            logger.warning("[sidekick] hindsight purge setup failed: %s", exc)

    # ------------------------------------------------------------------
    # /v1/responses — turn dispatch with streaming SSE reply
    # ------------------------------------------------------------------
    #
    # OpenAI Responses API compatible. Body: {conversation, input,
    # stream}. Stream defaults to True. The handler registers a per-
    # chat-id queue, dispatches the message via handle_message (which
    # eventually causes the agent to call back into self.send /
    # self.edit_message — the modified _safe_send_envelope routes
    # those replies into our queue), and writes them out as SSE
    # frames per ABSTRACT_AGENT_PROTOCOL.md until reply_final or
    # TURN_TIMEOUT_S.

    @staticmethod
    def _coerce_input(field: Any) -> Optional[str]:
        """Accept a plain string or the array-of-{role, content} form.
        Returns None for unrecognized shapes."""
        if isinstance(field, str):
            return field
        if isinstance(field, list):
            parts: List[str] = []
            for m in field:
                if not isinstance(m, dict):
                    continue
                role = m.get("role")
                if role not in ("user", "system"):
                    continue
                content = m.get("content")
                if isinstance(content, str):
                    parts.append(content)
                elif isinstance(content, list):
                    for c in content:
                        if isinstance(c, dict) and isinstance(c.get("text"), str):
                            parts.append(c["text"])
            if parts:
                return "\n".join(parts)
        return None

    # ── Optional settings extension (/v1/settings/*) ──────────────────
    # Lets the PWA render an agent-owned controls panel without
    # frontend-side knowledge of what the agent supports. Today: one
    # "model" enum. Adding more knobs (persona, temperature, default
    # provider) is additive: append to _build_settings_schema() and
    # branch _apply_setting() on id.

    def _read_hermes_config(self) -> Dict[str, Any]:
        """Snapshot of ~/.hermes/config.yaml as a dict (or {} on failure).
        Used by every settings read so we work from one consistent
        view per request. Raw read — no normalization."""
        try:
            import yaml
            from hermes_cli.config import get_config_path
            cfg_path = get_config_path()
            if not cfg_path.exists():
                return {}
            with open(cfg_path, encoding="utf-8") as f:
                return yaml.safe_load(f) or {}
        except Exception as e:
            logger.warning("[sidekick] settings: read hermes config failed: %s", e)
            return {}

    def _read_preferred_models(self, cfg: Dict[str, Any]) -> List[str]:
        """Resolve the preferred-models glob list. Source of truth:
        `sidekick.preferred_models:` in ~/.hermes/config.yaml (a yaml
        list of glob strings). Falls back to SIDEKICK_PREFERRED_MODELS
        env (comma-separated) for env-only deployments. Empty result
        = no filter (full catalog)."""
        sk = cfg.get("sidekick") if isinstance(cfg.get("sidekick"), dict) else {}
        raw = sk.get("preferred_models")
        if isinstance(raw, list):
            out = [str(g).strip() for g in raw if isinstance(g, str) and str(g).strip()]
            if out:
                return out
        env_raw = (os.environ.get("SIDEKICK_PREFERRED_MODELS") or "").strip()
        if env_raw:
            return [g.strip() for g in env_raw.split(",") if g.strip()]
        return []

    def _build_settings_schema(self) -> List[Dict[str, Any]]:
        """Build the SettingDef[] list. Reads hermes config.yaml for
        the current model + the preferred-models glob filter (under
        `sidekick.preferred_models:`), and openrouter for the catalog."""
        import fnmatch
        cfg = self._read_hermes_config()

        # Current model — hermes stores it as scalar
        # (`model: google/gemma-4-26b-a4b-it`) or dict
        # (`model: {default: ..., provider: ...}`); handle both.
        current_model = ""
        model_cfg = cfg.get("model")
        if isinstance(model_cfg, dict):
            current_model = (model_cfg.get("default") or "").strip()
        elif isinstance(model_cfg, str):
            current_model = model_cfg.strip()

        # Preferred-models filter (string-list — also exposed as its
        # own SettingDef below so the chip UI can edit it).
        preferred = self._read_preferred_models(cfg)

        # Openrouter catalog. fetch_openrouter_models returns a list of
        # `(model_id, source_label)` tuples (curated by hermes — only
        # tool-supporting models, ranked by the preferred_ids list).
        # The label is "recommended" / "free" / "" — useful as a hint
        # in the dropdown but we just use the id for now to keep the
        # contract simple. Be defensive about shape: any future return
        # type change should degrade to "no options" instead of 500ing
        # the whole settings panel.
        catalog: List[Dict[str, Any]] = []
        try:
            from hermes_cli.models import fetch_openrouter_models
            raw = fetch_openrouter_models() or []
            for entry in raw:
                if isinstance(entry, tuple) and len(entry) >= 1:
                    mid = str(entry[0] or "").strip()
                    tag = str(entry[1] or "").strip() if len(entry) >= 2 else ""
                elif isinstance(entry, dict):
                    mid = str(entry.get("id") or "").strip()
                    tag = ""
                elif isinstance(entry, str):
                    mid = entry.strip()
                    tag = ""
                else:
                    continue
                if not mid:
                    continue
                label = f"{mid} ({tag})" if tag else mid
                catalog.append({"value": mid, "label": label})
        except Exception as e:
            logger.warning("[sidekick] settings: openrouter catalog fetch failed: %s", e)

        # Apply preferred-models filter to the catalog. Empty list =
        # no filter (full catalog).
        if preferred and catalog:
            catalog = [
                e for e in catalog
                if any(fnmatch.fnmatch(e["value"], g) for g in preferred)
            ]

        # Supplement with the LIVE openrouter catalog for any preferred
        # glob whose pattern matched nothing in hermes' curated list.
        # The curated list (hermes_cli/models.py:OPENROUTER_MODELS) is
        # a hand-maintained "tool-supporting" subset and lags reality —
        # e.g. google/gemma-4* never made it in. The user's explicit
        # preferred glob is the authoritative signal: if they asked for
        # gemma-4, give them what openrouter actually has matching that.
        if preferred:
            try:
                import urllib.request
                req = urllib.request.Request(
                    "https://openrouter.ai/api/v1/models",
                    headers={"Accept": "application/json"},
                )
                with urllib.request.urlopen(req, timeout=5.0) as resp:
                    payload = json.loads(resp.read().decode())
                live_ids = [
                    str(item.get("id") or "").strip()
                    for item in (payload.get("data") or [])
                    if isinstance(item, dict)
                ]
                seen = {e["value"] for e in catalog}
                for mid in live_ids:
                    if not mid or mid in seen:
                        continue
                    if any(fnmatch.fnmatch(mid, g) for g in preferred):
                        catalog.append({"value": mid, "label": mid})
                        seen.add(mid)
            except Exception as e:
                logger.warning(
                    "[sidekick] settings: live openrouter supplement failed: %s", e,
                )

        # Always include the current model in the options[] list so the
        # picker can show "what's set now" even if the catalog filter
        # excluded it.
        if current_model and not any(e["value"] == current_model for e in catalog):
            catalog.insert(0, {"value": current_model, "label": current_model})

        # Stable sort by label for the dropdown.
        catalog.sort(key=lambda e: (e["label"] or "").lower())

        return [
            {
                "id": "model",
                "label": "Model",
                "description": "LLM used for replies",
                "category": "Agent",
                "type": "enum",
                "value": current_model,
                "options": catalog,
            },
            {
                "id": "preferred_models",
                "label": "Preferred models",
                "description": (
                    "Glob patterns that filter the model dropdown above "
                    "(e.g. anthropic/*, google/gemini-*). Empty = full "
                    "openrouter catalog. Stored in ~/.hermes/config.yaml "
                    "under sidekick.preferred_models."
                ),
                "category": "Agent",
                "type": "string-list",
                "value": preferred,
                "placeholder": "e.g. anthropic/* + Enter",
            },
        ]

    async def _handle_settings_schema(self, request: "web.Request") -> "web.Response":
        """GET /v1/settings/schema — list the agent's user-facing knobs."""
        if not self._check_http_auth(request):
            return web.Response(status=401, text="invalid token")
        try:
            schema = await asyncio.get_running_loop().run_in_executor(
                None, self._build_settings_schema,
            )
        except Exception as e:
            logger.exception("[sidekick] settings schema build failed")
            return web.json_response(
                {"error": {"type": "server_error", "message": str(e)}},
                status=500,
            )
        return web.json_response({"object": "list", "data": schema})

    async def _handle_settings_update(self, request: "web.Request") -> "web.Response":
        """POST /v1/settings/{id} — apply one setting."""
        if not self._check_http_auth(request):
            return web.Response(status=401, text="invalid token")
        sid = request.match_info.get("id", "")
        try:
            body = await request.json()
        except (ValueError, json.JSONDecodeError):
            return web.json_response(
                {"error": {"type": "invalid_request_error",
                           "message": "body is not valid JSON"}},
                status=400,
            )
        value = body.get("value")
        try:
            updated = await asyncio.get_running_loop().run_in_executor(
                None, self._apply_setting, sid, value,
            )
        except _SettingsValidationError as e:
            return web.json_response(
                {"error": {"type": "invalid_request_error", "message": str(e)}},
                status=400,
            )
        except _SettingsNotFoundError as e:
            return web.json_response(
                {"error": {"type": "invalid_request_error", "message": str(e)}},
                status=404,
            )
        except Exception as e:
            logger.exception("[sidekick] settings apply failed: %s", sid)
            return web.json_response(
                {"error": {"type": "server_error", "message": str(e)}},
                status=500,
            )
        return web.json_response(updated)

    def _apply_setting(self, sid: str, value: Any) -> Dict[str, Any]:
        """Apply one setting and return the updated def. Synchronous —
        called from a thread executor since switch_model + config
        write are blocking. Raises _SettingsValidationError /
        _SettingsNotFoundError to map to 400 / 404 respectively."""
        if sid == "model":
            return self._apply_model_setting(value)
        if sid == "preferred_models":
            return self._apply_preferred_models_setting(value)
        raise _SettingsNotFoundError(f"unknown setting: {sid}")

    def _apply_preferred_models_setting(self, value: Any) -> Dict[str, Any]:
        """Persist the preferred-models glob list to
        ~/.hermes/config.yaml under `sidekick.preferred_models:`. The
        next /v1/settings/schema response uses the new list to filter
        the catalog. Already-cached agents are unaffected — this knob
        is purely a UI filter, not an agent-runtime setting."""
        if not isinstance(value, list):
            raise _SettingsValidationError("preferred_models value must be a list of strings")
        cleaned: List[str] = []
        seen: Set[str] = set()
        for entry in value:
            if not isinstance(entry, str):
                raise _SettingsValidationError(
                    f"preferred_models entries must be strings; got {type(entry).__name__}"
                )
            t = entry.strip()
            if not t or t in seen:
                continue
            # Conservative charset — globs are ASCII printables minus
            # whitespace + a few risky ones. Lets a forks-edit survive
            # round-trip through yaml without surprises.
            if any(ch in t for ch in (" ", "\t", "\n", "\r")):
                raise _SettingsValidationError(
                    f"preferred_models entry has whitespace: {t!r}"
                )
            seen.add(t)
            cleaned.append(t)
        try:
            import yaml
            from hermes_cli.config import get_config_path
            cfg_path = get_config_path()
            cfg: Dict[str, Any] = {}
            if cfg_path.exists():
                with open(cfg_path, encoding="utf-8") as f:
                    cfg = yaml.safe_load(f) or {}
            sk = cfg.get("sidekick")
            if not isinstance(sk, dict):
                sk = {}
                cfg["sidekick"] = sk
            sk["preferred_models"] = cleaned
            from hermes_cli.config import save_config
            save_config(cfg)
        except Exception as e:
            logger.exception("[sidekick] preferred_models persist failed")
            raise _SettingsValidationError(f"failed to write hermes config: {e}")
        # Return the freshly-rebuilt def (in case the schema build
        # normalized the list further — currently a no-op but keeps
        # the response shape consistent with model setting).
        new_schema = self._build_settings_schema()
        for s in new_schema:
            if s["id"] == "preferred_models":
                return s
        # Shouldn't reach here; fall through to a synthesized response.
        return {
            "id": "preferred_models",
            "label": "Preferred models",
            "category": "Agent",
            "type": "string-list",
            "value": cleaned,
        }

    def _apply_model_setting(self, value: Any) -> Dict[str, Any]:
        """Persist a new default model to hermes config.yaml, mirroring
        what `/model <name> --global` does in chat. Cached agents on
        existing sessions keep their model until evicted (typical
        case: next conversation start). New conversations pick up
        the new default immediately on next /v1/responses dispatch."""
        if not isinstance(value, str) or not value.strip():
            raise _SettingsValidationError("model value must be a non-empty string")
        new_model = value.strip()

        # Validate against the declared options[] (sidekick filter +
        # current). Same logic as _build_settings_schema; we re-derive
        # to avoid round-tripping through the schema endpoint.
        schema = self._build_settings_schema()
        model_def = next((s for s in schema if s["id"] == "model"), None)
        if model_def is None:
            raise _SettingsNotFoundError("model setting not declared")
        valid_values = {o["value"] for o in (model_def.get("options") or [])}
        if new_model not in valid_values:
            raise _SettingsValidationError(
                f"value not in options[]: {new_model!r}"
            )

        # Read current state to feed switch_model.
        try:
            import yaml
            from hermes_cli.config import get_config_path
            cfg_path = get_config_path()
            cfg: Dict[str, Any] = {}
            if cfg_path.exists():
                with open(cfg_path, encoding="utf-8") as f:
                    cfg = yaml.safe_load(f) or {}
            raw_model = cfg.get("model")
            if isinstance(raw_model, dict):
                model_cfg = raw_model
            elif isinstance(raw_model, str):
                model_cfg = {"default": raw_model}
            else:
                model_cfg = {}
            current_model = (model_cfg.get("default") or "").strip()
            current_provider = (model_cfg.get("provider") or "openrouter").strip()
            current_base_url = (model_cfg.get("base_url") or "").strip()
            user_provs = cfg.get("providers")
            try:
                from hermes_cli.config import get_compatible_custom_providers
                custom_provs = get_compatible_custom_providers(cfg)
            except Exception:
                custom_provs = cfg.get("custom_providers")
        except Exception as e:
            raise _SettingsValidationError(
                f"failed to read hermes config: {e}"
            )

        # Delegate provider resolution via switch_model. Despite the
        # is_global flag's name, the function does NOT write config
        # itself — that's the caller's job (mirroring how cli.py and
        # gateway/run.py handle their own /model commands). We do it
        # below.
        try:
            from hermes_cli.model_switch import switch_model
            result = switch_model(
                raw_input=new_model,
                current_provider=current_provider,
                current_model=current_model,
                current_base_url=current_base_url,
                current_api_key="",
                is_global=True,
                explicit_provider="",
                user_providers=user_provs,
                custom_providers=custom_provs,
            )
        except Exception as e:
            logger.exception("[sidekick] switch_model raised")
            raise _SettingsValidationError(f"switch_model failed: {e}")
        if not result.success:
            raise _SettingsValidationError(
                result.error_message or "model switch rejected"
            )

        # Persist resolved model+provider+base_url to config.yaml so
        # the change survives restart (mirrors the persist block in
        # gateway/run.py:_handle_model_switch). switch_model itself
        # does NOT write — despite the is_global flag — so we have
        # to do it here, otherwise the setting reverts on the next
        # _build_settings_schema call (it reads config.yaml).
        try:
            from hermes_cli.config import save_config
            cfg.setdefault("model", {})
            if not isinstance(cfg["model"], dict):
                cfg["model"] = {"default": cfg["model"]}
            cfg["model"]["default"] = result.new_model
            if result.target_provider:
                cfg["model"]["provider"] = result.target_provider
            if result.base_url:
                cfg["model"]["base_url"] = result.base_url
            save_config(cfg)
        except Exception as e:
            logger.warning("[sidekick] failed to persist model to config.yaml: %s", e)

        # Re-derive the schema so the response reflects the actual
        # post-write state (catches cases where switch_model
        # normalized the model id to a canonical form).
        new_schema = self._build_settings_schema()
        return next((s for s in new_schema if s["id"] == "model"), schema[0])

    async def _handle_responses(self, request: "web.Request") -> "web.StreamResponse":
        """POST /v1/responses — turn dispatch with optional streaming."""
        if not self._check_http_auth(request):
            return web.Response(status=401, text="invalid token")
        try:
            body = await request.json()
        except (ValueError, json.JSONDecodeError):
            return web.json_response(
                {"error": {"type": "invalid_request_error",
                           "message": "body is not valid JSON"}},
                status=400,
            )

        conversation = body.get("conversation")
        input_field = body.get("input")
        stream = bool(body.get("stream", True))
        # Sidekick extension: optional `attachments` array — each entry
        # is `{type, mimeType, fileName, content}` where `content` is a
        # `data:<mime>;base64,<payload>` URL. NOT part of the OpenAI
        # Responses API today; tolerated as an additive field so a
        # raw OAI third-party speaking only the standard surface still
        # interoperates.
        raw_attachments = body.get("attachments")
        attachments = raw_attachments if isinstance(raw_attachments, list) else None

        if not isinstance(conversation, str) or not conversation:
            return web.json_response(
                {"error": {"type": "invalid_request_error",
                           "message": "missing or invalid `conversation`"}},
                status=400,
            )
        if input_field is None:
            return web.json_response(
                {"error": {"type": "invalid_request_error",
                           "message": "missing `input`"}},
                status=400,
            )
        text = self._coerce_input(input_field)
        if text is None:
            return web.json_response(
                {"error": {"type": "invalid_request_error",
                           "message": "`input` must be a string or array of {role, content}"}},
                status=400,
            )

        chat_id = conversation
        response_id = f"resp_{secrets.token_hex(12)}"
        message_id = f"msg_{secrets.token_hex(10)}"
        created_at = int(time.time())

        # Register the turn queue. If a queue already exists for this
        # chat_id, replace it — the proxy is expected to serialize per-
        # chat (multiplexed via /api/sidekick/messages on the proxy
        # side), so this branch is purely defensive.
        queue: "asyncio.Queue[Dict[str, Any]]" = asyncio.Queue(maxsize=TURN_QUEUE_MAX)
        self._turn_queues[chat_id] = queue

        if not stream:
            return await self._handle_responses_blocking(
                chat_id, text, queue, response_id, message_id, created_at,
                attachments=attachments,
            )
        return await self._handle_responses_streaming(
            request, chat_id, text, queue, response_id, message_id, created_at,
            attachments=attachments,
        )

    async def _handle_responses_blocking(
        self, chat_id: str, text: str,
        queue: "asyncio.Queue[Dict[str, Any]]",
        response_id: str, message_id: str, created_at: int,
        attachments: Optional[list] = None,
    ) -> "web.Response":
        """Non-streaming /v1/responses path. Dispatch, drain the queue
        until reply_final, return single JSON envelope."""
        try:
            # _dispatch_message kicks off agent processing; replies
            # arrive on `queue` via _safe_send_envelope's fan-out.
            asyncio.create_task(self._dispatch_message(
                chat_id=chat_id, text=text, attachments=attachments,
            ))
            assembled = ""
            while True:
                env = await asyncio.wait_for(queue.get(), timeout=TURN_TIMEOUT_S)
                t = env.get("type")
                if t == "reply_delta":
                    # Hermes emits the accumulated text on each chunk.
                    # Track the latest; OAI-shape compaction below.
                    assembled = env.get("text", assembled) or assembled
                elif t == "reply_final":
                    break
            return web.json_response(self._build_response_envelope(
                response_id, message_id, created_at, assembled,
            ))
        except asyncio.TimeoutError:
            return web.json_response(
                {"error": {"type": "server_error", "message": "turn timed out"}},
                status=500,
            )
        finally:
            self._turn_queues.pop(chat_id, None)

    async def _handle_responses_streaming(
        self, request: "web.Request",
        chat_id: str, text: str,
        queue: "asyncio.Queue[Dict[str, Any]]",
        response_id: str, message_id: str, created_at: int,
        attachments: Optional[list] = None,
    ) -> "web.StreamResponse":
        """Streaming /v1/responses. Emits OpenAI Responses-API SSE
        events as the agent produces output."""
        resp = web.StreamResponse(
            status=200,
            headers={
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                "x-accel-buffering": "no",
            },
        )
        await resp.prepare(request)

        async def write_sse(event: str, data: Dict[str, Any]) -> None:
            await resp.write(
                f"event: {event}\ndata: {json.dumps(data)}\n\n".encode("utf-8")
            )

        output_index = 0
        content_index = 0
        assembled = ""
        completed_emitted = False

        # Dispatch the message; replies flow back through `queue` via
        # _safe_send_envelope.
        asyncio.create_task(self._dispatch_message(
            chat_id=chat_id, text=text, attachments=attachments,
        ))

        try:
            while True:
                env = await asyncio.wait_for(queue.get(), timeout=TURN_TIMEOUT_S)
                t = env.get("type")
                if t == "reply_delta":
                    # Hermes streams accumulated text. First chunk
                    # (no edit flag) might be empty or full; subsequent
                    # chunks (edit=True) carry the running total.
                    full = env.get("text", "") or ""
                    if env.get("edit") and full.startswith(assembled):
                        delta_text = full[len(assembled):]
                    elif env.get("edit"):
                        # Non-additive edit (rare). Bump content_index
                        # so the client knows to start fresh.
                        delta_text = full
                        content_index += 1
                        assembled = ""
                    else:
                        # First (non-edit) delta — full content is the delta.
                        delta_text = full
                    if delta_text:
                        await write_sse("response.output_text.delta", {
                            "type": "response.output_text.delta",
                            "item_id": message_id,
                            "output_index": output_index,
                            "content_index": content_index,
                            "delta": delta_text,
                        })
                        assembled += delta_text
                elif t == "reply_final":
                    await write_sse("response.completed", {
                        "type": "response.completed",
                        "response": self._build_response_envelope(
                            response_id, message_id, created_at, assembled,
                        ),
                    })
                    completed_emitted = True
                    break
                elif t == "tool_call":
                    output_index += 1
                    args = env.get("args", {})
                    args_str = (
                        json.dumps(args) if isinstance(args, dict)
                        else str(env.get("_args_repr") or args)
                    )
                    await write_sse("response.output_item.added", {
                        "type": "response.output_item.added",
                        "output_index": output_index,
                        "item": {
                            "type": "function_call",
                            "id": env.get("call_id", ""),
                            "name": env.get("tool_name", ""),
                            "arguments": args_str,
                        },
                    })
                elif t == "tool_result":
                    result = env.get("result", "")
                    if isinstance(result, str):
                        result_out = result[:TOOL_RESULT_MAX_BYTES]
                    else:
                        try:
                            result_out = json.dumps(result)[:TOOL_RESULT_MAX_BYTES]
                        except Exception:
                            result_out = str(result)[:TOOL_RESULT_MAX_BYTES]
                    await write_sse("response.output_item.done", {
                        "type": "response.output_item.done",
                        "output_index": output_index,
                        "item": {
                            "type": "function_call_output",
                            "call_id": env.get("call_id", ""),
                            "output": result_out,
                        },
                    })
                    # Bump for any subsequent output. Reset assembled
                    # so a follow-up text item starts fresh.
                    output_index += 1
                    content_index = 0
                    assembled = ""
                elif t == "typing":
                    await write_sse("response.in_progress", {
                        "type": "response.in_progress",
                    })
                # Other envelope types are out-of-turn and shouldn't
                # arrive here. If they do (defensive), skip silently
                # rather than corrupt the response stream.
        except asyncio.TimeoutError:
            if not completed_emitted:
                with contextlib.suppress(Exception):
                    await write_sse("response.error", {
                        "type": "response.error",
                        "error": {"type": "server_error", "message": "turn timed out"},
                    })
        except (ConnectionResetError, asyncio.CancelledError):
            # Client disconnected mid-stream. Cleanup in finally.
            pass
        except Exception as exc:
            logger.warning("[sidekick] /v1/responses error for %s: %s", chat_id, exc)
            with contextlib.suppress(Exception):
                await write_sse("response.error", {
                    "type": "response.error",
                    "error": {"type": "server_error", "message": str(exc)},
                })
        finally:
            self._turn_queues.pop(chat_id, None)
            with contextlib.suppress(Exception):
                await resp.write_eof()
        return resp

    @staticmethod
    def _build_response_envelope(
        response_id: str, message_id: str,
        created_at: int, assembled: str,
    ) -> Dict[str, Any]:
        """Build the OpenAI Responses-API completed envelope."""
        return {
            "id": response_id,
            "object": "response",
            "status": "completed",
            "created_at": created_at,
            "model": "hermes",
            "output": [{
                "type": "message",
                "id": message_id,
                "role": "assistant",
                "content": [{"type": "output_text", "text": assembled}],
            }],
            "usage": {
                "input_tokens": 0,
                "output_tokens": 0,
                "total_tokens": 0,
            },
        }

    # ------------------------------------------------------------------
    # /v1/events — out-of-turn SSE channel
    # ------------------------------------------------------------------
    #
    # Persistent SSE for envelopes not tied to an active /v1/responses
    # turn: notifications (cron-driven), session_changed (compression-
    # rotation that didn't happen during a request), late tool events,
    # etc. The proxy keeps one of these open at all times and fans the
    # envelopes onto its persistent /api/sidekick/stream channel.

    async def _handle_events(self, request: "web.Request") -> "web.StreamResponse":
        """GET /v1/events — persistent SSE for out-of-turn envelopes."""
        if not self._check_http_auth(request):
            return web.Response(status=401, text="invalid token")

        last_event_id = request.headers.get("Last-Event-ID", "")
        cursor: Optional[int] = None
        if last_event_id:
            try:
                cursor = int(last_event_id)
            except ValueError:
                cursor = None

        queue: "asyncio.Queue[Tuple[int, Dict[str, Any]]]" = (
            asyncio.Queue(maxsize=TURN_QUEUE_MAX)
        )
        self._event_subscribers.add(queue)

        resp = web.StreamResponse(
            status=200,
            headers={
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                "x-accel-buffering": "no",
            },
        )
        await resp.prepare(request)

        async def write_evt(eid: int, event_name: str, data: Dict[str, Any]) -> None:
            await resp.write(
                f"id: {eid}\nevent: {event_name}\ndata: {json.dumps(data)}\n\n".encode("utf-8")
            )

        try:
            # Tight reconnect hint so a transient drop resumes sub-second.
            await resp.write(b"retry: 1000\n\n")
            # Replay anything from the ring strictly newer than cursor.
            for eid, env in list(self._event_replay_ring):
                if cursor is None or eid > cursor:
                    await write_evt(eid, env.get("type", "event"), env)
            # Live envelopes.
            while True:
                eid, env = await queue.get()
                await write_evt(eid, env.get("type", "event"), env)
        except (asyncio.CancelledError, ConnectionResetError):
            pass
        except Exception as exc:
            logger.warning("[sidekick] /v1/events error: %s", exc)
        finally:
            self._event_subscribers.discard(queue)
            with contextlib.suppress(Exception):
                await resp.write_eof()
        return resp

    # ------------------------------------------------------------------
    # Outbound
    # ------------------------------------------------------------------

    def _next_message_id(self) -> str:
        self._message_seq += 1
        return f"sk-{int(time.time())}-{self._message_seq}"

    async def _safe_send_envelope(self, env: Dict[str, Any]) -> bool:
        """Fan an outbound envelope to consumers.

        Routing:
          1. In-turn envelopes (reply_delta, reply_final, tool_call,
             tool_result, typing) for a chat with an active /v1/responses
             turn go to that turn's queue. Otherwise they fall through
             to the out-of-turn channel.
          2. All other envelope types (notification, session_changed,
             image, error) and orphaned in-turn envelopes go to the
             /v1/events out-of-turn channel + replay ring.

        Returns True if at least one consumer accepted the envelope.
        """
        env_type = env.get("type", "")
        chat_id = env.get("chat_id", "")
        in_turn_types = {"reply_delta", "reply_final", "tool_call",
                          "tool_result", "typing"}

        if env_type in in_turn_types and chat_id:
            queue = self._turn_queues.get(chat_id)
            if queue is not None:
                try:
                    queue.put_nowait(env)
                    return True
                except asyncio.QueueFull:
                    logger.warning(
                        "[sidekick] turn queue full for %s, dropping %s",
                        chat_id, env_type,
                    )

        return self._publish_out_of_turn(env)

    def _publish_out_of_turn(self, env: Dict[str, Any]) -> bool:
        """Push an envelope to /v1/events subscribers + the replay ring.

        Synchronous (asyncio.Queue.put_nowait is non-blocking). Drops
        envelopes for subscribers whose queue is full — protects the
        plugin from a hung consumer; the affected client gets gaps,
        which it can detect via Last-Event-ID skips on reconnect.
        """
        self._event_id_counter += 1
        eid = self._event_id_counter
        self._event_replay_ring.append((eid, env))
        if len(self._event_replay_ring) > EVENT_REPLAY_CAP:
            self._event_replay_ring.pop(0)

        delivered = False
        dead: List["asyncio.Queue"] = []
        for q in list(self._event_subscribers):
            try:
                q.put_nowait((eid, env))
                delivered = True
            except asyncio.QueueFull:
                logger.warning(
                    "[sidekick] /v1/events subscriber queue full, dropping %s",
                    env.get("type"),
                )
            except Exception:
                dead.append(q)
        for q in dead:
            self._event_subscribers.discard(q)
        return delivered

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
        # itself (the proxy already knows that) as a no-op stub. A future
        # on-compression callback would replace this with a real session_id.
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

    # ------------------------------------------------------------------
    # Tool-event emission (Phase 3)
    #
    # pre_tool_call / post_tool_call hooks fire from worker threads —
    # the agent dispatches every non-async tool via run_in_executor in
    # run_agent.py. We can't `await` from there, so we schedule envelope
    # sends onto the adapter's event loop with run_coroutine_threadsafe.
    # If the loop's gone (mid-shutdown) the schedule no-ops and the
    # event is dropped — non-critical observational data.
    #
    # The PWA gates rendering off the agentActivity setting, so the
    # adapter is intentionally promiscuous: it relays every sidekick
    # tool call/result faithfully and lets the client decide visibility.
    # ------------------------------------------------------------------

    @staticmethod
    def _serialize_args_for_envelope(
        args: Any,
    ) -> Tuple[Dict[str, Any], Optional[str]]:
        """Coerce a tool-call args dict into a JSON-serializable shape
        for the envelope. Returns (args_dict, args_repr_fallback).

        Order:
          1. If already a dict and round-trips through json: pass through.
          2. Else stringify with default=str and reparse.
          3. Else give up — return ({}, "<string repr>") so the PWA can
             show *something* instead of an empty args block.
        """
        if not isinstance(args, dict):
            try:
                return {}, json.dumps(args, default=str, ensure_ascii=False)
            except Exception:
                return {}, repr(args)
        try:
            json.dumps(args, ensure_ascii=False)
            return args, None
        except (TypeError, ValueError):
            pass
        try:
            stringified = json.dumps(args, default=str, ensure_ascii=False)
            reparsed = json.loads(stringified)
            if isinstance(reparsed, dict):
                return reparsed, None
            return {}, stringified
        except Exception:
            try:
                return {}, repr(args)
            except Exception:
                return {}, "<unrepresentable>"

    def _schedule_envelope(self, env: Dict[str, Any]) -> None:
        """Thread-safe envelope dispatch. Called from sync hook
        callbacks running on worker threads."""
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        coro = self._safe_send_envelope(env)
        try:
            asyncio.run_coroutine_threadsafe(coro, loop)
        except RuntimeError:
            # Loop in a non-running state mid-shutdown; drop silently.
            with contextlib.suppress(Exception):
                coro.close()

    def on_pre_tool_call(
        self,
        *,
        tool_name: str,
        args: Any,
        task_id: str = "",
        session_id: str = "",
        tool_call_id: str = "",
        **_kwargs: Any,
    ) -> None:
        """Hook callback. Sync, fires from worker thread. No-op for
        non-sidekick sessions."""
        if not session_id or not tool_call_id:
            return
        chat_id = self._resolve_chat_id_from_session_id(session_id)
        if not chat_id:
            return
        # Stamp the start time + chat_id so the post hook can compute
        # duration_ms without re-resolving anything.
        started = time.time()
        # Bound the in-flight map so a long-running session with weirdly
        # mismatched pre/post pairs can't grow it without limit. 256 is
        # well above any realistic concurrent-tool count.
        if len(self._inflight_tool_calls) > 256:
            self._inflight_tool_calls.clear()
        self._inflight_tool_calls[tool_call_id] = (started, chat_id)

        args_dict, args_repr = self._serialize_args_for_envelope(args)
        envelope: Dict[str, Any] = {
            "type": "tool_call",
            "chat_id": chat_id,
            "call_id": tool_call_id,
            "tool_name": tool_name,
            "args": args_dict,
            "started_at": _iso_from_epoch(started),
        }
        if args_repr is not None:
            envelope["_args_repr"] = args_repr
        self._schedule_envelope(envelope)

    def on_post_tool_call(
        self,
        *,
        tool_name: str,
        args: Any,
        result: Any,
        task_id: str = "",
        session_id: str = "",
        tool_call_id: str = "",
        **_kwargs: Any,
    ) -> None:
        """Hook callback. Sync, fires from worker thread. No-op when
        there's no matching pre_tool_call entry (filters non-sidekick)."""
        if not tool_call_id:
            return
        entry = self._inflight_tool_calls.pop(tool_call_id, None)
        if entry is None:
            # Either pre fired in a non-sidekick session (and we filtered
            # out), or the agent path skipped the pre hook (edge case).
            # Re-resolve to be safe; fall through silently if still not
            # ours.
            chat_id = self._resolve_chat_id_from_session_id(session_id)
            if not chat_id:
                return
            duration_ms = 0
        else:
            started, chat_id = entry
            duration_ms = max(0, int((time.time() - started) * 1000))

        # Cap result string size — see TOOL_RESULT_MAX_BYTES rationale.
        result_str: Optional[str]
        truncated = False
        if result is None:
            result_str = None
        elif isinstance(result, str):
            result_str = result
        else:
            try:
                result_str = json.dumps(result, default=str, ensure_ascii=False)
            except Exception:
                result_str = repr(result)
        if isinstance(result_str, str):
            encoded = result_str.encode("utf-8", errors="replace")
            if len(encoded) > TOOL_RESULT_MAX_BYTES:
                # Decode a clean prefix; ignore errors so we don't split
                # a UTF-8 sequence mid-byte.
                result_str = encoded[:TOOL_RESULT_MAX_BYTES].decode(
                    "utf-8", errors="ignore"
                )
                truncated = True

        envelope: Dict[str, Any] = {
            "type": "tool_result",
            "chat_id": chat_id,
            "call_id": tool_call_id,
            "result": result_str,
            "error": None,
            "duration_ms": duration_ms,
        }
        if truncated:
            envelope["_truncated"] = True
        self._schedule_envelope(envelope)

    # ------------------------------------------------------------------
    # session_changed polling
    #
    # Watch state.db for (session_id, title) transitions on the chat_ids
    # we know about and emit a `session_changed` envelope when either
    # changes. Picked over
    # (a) hermes-side hooks (would require a hermes patch — explicit
    # opt-in only) and (c) PWA polling (more client-side complexity,
    # doesn't free push notifications). Trade-off: ~1s lag between a
    # compression-driven session swap and the PWA seeing the new title.
    # ------------------------------------------------------------------

    @staticmethod
    def _resolve_state_db_path() -> Optional[Path]:
        """Find the gateway's state.db. Mirrors hermes' own resolution
        order so the adapter doesn't introduce a new env var.

        Resolution: HERMES_STATE_DB env → HERMES_HOME/state.db →
        ~/.hermes/state.db. Returns None if nothing exists; caller logs.
        """
        env_path = os.getenv("HERMES_STATE_DB", "").strip()
        if env_path:
            p = Path(env_path).expanduser()
            return p if p.exists() else None
        home_path = os.getenv("HERMES_HOME", "").strip()
        if home_path:
            p = Path(home_path).expanduser() / "state.db"
            if p.exists():
                return p
        default = Path("~/.hermes/state.db").expanduser()
        return default if default.exists() else None

    def _ensure_state_db_indexes(self) -> None:
        """Create read-side indexes the plugin's queries depend on.

        State.db is owned by hermes-agent core (sessions table schema is
        defined upstream). The plugin's drawer + history queries group
        and filter on ``(user_id, source)``; the upstream schema only
        has ``idx_sessions_source``, so the user_id grouping currently
        falls back to a full scan. ``CREATE INDEX IF NOT EXISTS`` is
        idempotent and safe to run on every adapter startup; if the
        upstream schema later adds the same composite index, this is a
        no-op.

        Best-effort: a failure here doesn't block adapter startup. The
        queries still produce correct results without the index, just
        slower.
        """
        if self._state_db_path is None or not self._state_db_path.exists():
            return
        try:
            with contextlib.closing(
                sqlite3.connect(self._state_db_path, timeout=5.0)
            ) as conn:
                with conn:
                    conn.execute(
                        "CREATE INDEX IF NOT EXISTS "
                        "idx_sessions_user_id_source "
                        "ON sessions(user_id, source)"
                    )
        except Exception as exc:
            logger.warning(
                "[sidekick] index ensure failed (non-fatal): %s", exc
            )

    async def _session_poll_loop(self) -> None:
        """Background task: poll state.db every ~1.5s and emit
        ``session_changed`` envelopes for any chat_id whose
        (session_id, title) tuple changes.

        Skips polling while no proxy client is connected — there's no
        listener to push to, and a queued event would race against the
        proxy's reconnect handshake.
        """
        # Small initial delay so the gateway has a chance to write the
        # first sessions row before our first SELECT (avoids one
        # spurious "no rows yet" log).
        await asyncio.sleep(SESSION_POLL_INTERVAL_S)
        while True:
            try:
                # Skip when nobody's listening — the moment a proxy
                # subscribes to /v1/events we resume from the cached
                # state, so a transition that happened during the
                # disconnect still fires once on reconnect.
                if not self._event_subscribers:
                    await asyncio.sleep(SESSION_POLL_INTERVAL_S)
                    continue
                await self._poll_sessions_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                # Never let a transient sqlite error kill the poller —
                # we want it to recover the next tick.
                logger.exception("[sidekick] session poll iteration failed")
            await asyncio.sleep(SESSION_POLL_INTERVAL_S)

    async def _poll_sessions_once(self) -> None:
        """One pass over the gateway's sessions table. Pushed off the
        event loop via a thread executor so the (tiny) sqlite read
        doesn't stall the WS pump."""
        rows = await asyncio.to_thread(self._read_session_rows)
        for chat_id, session_id, title in rows:
            prev = self._session_state_cache.get(chat_id)
            current = (session_id or "", title or "")
            if prev is None:
                # First sighting of this chat_id since adapter startup.
                # Seed the cache; we'd rather miss the very first
                # session_id on this run than emit on a hot reload.
                self._session_state_cache[chat_id] = current
                continue
            if prev == current:
                continue
            self._session_state_cache[chat_id] = current
            logger.info(
                "[sidekick] session_changed chat_id=%s session_id=%s title=%r",
                chat_id,
                current[0],
                current[1],
            )
            await self._safe_send_envelope({
                "type": "session_changed",
                "chat_id": chat_id,
                "session_id": current[0],
                "title": current[1],
            })

    def _resolve_chat_id_from_session_id(self, session_id: str) -> Optional[str]:
        """Map a hermes session_id back to its sidekick chat_id, if any.

        chat_id IS ``sessions.user_id`` for sidekick sessions, so we
        look it up directly in state.db (one row, primary-key seek).
        Non-sidekick sessions naturally fail to resolve (source filter)
        and the caller treats that as "not for us" — that's the filter
        for tool calls coming from telegram / whatsapp / etc. running
        on the same gateway. Safe to call from worker threads.

        Cached because tool-event hooks fire on a hot path; the cache
        is keyed by session_id so a rotated chat picks up the new sid
        on its first tool fire post-rotation.
        """
        if not session_id:
            return None
        cached = self._sid_to_chat_id_cache.get(session_id)
        if cached is not None:
            return cached
        if self._state_db_path is None or not self._state_db_path.exists():
            return None
        try:
            uri = f"file:{self._state_db_path}?mode=ro"
            with contextlib.closing(
                sqlite3.connect(uri, uri=True, timeout=2.0)
            ) as conn:
                row = conn.execute(
                    "SELECT user_id FROM sessions WHERE id = ? AND source = ?",
                    (session_id, SIDEKICK_SOURCE),
                ).fetchone()
        except Exception:
            return None
        if row is None or not row[0]:
            return None
        chat_id = row[0]
        self._sid_to_chat_id_cache[session_id] = chat_id
        return chat_id

    def _read_session_rows(self) -> list:
        """Synchronous sqlite read — runs in a worker thread. Returns
        ``[(chat_id, session_id, title), …]`` for every sidekick
        chat's currently-latest session. Callers swallow exceptions.

        Powers the session_changed poller: a transition in either
        ``session_id`` or ``title`` for a known chat_id triggers a
        ``session_changed`` envelope to the proxy.

        Picks the LATEST session per ``user_id`` (chat_id) where
        ``source = 'sidekick'`` — i.e., whatever rotation
        compression/auto-reset has done, the row reflects what hermes
        is actively writing into right now. Also opportunistically
        refreshes the session_id → chat_id cache so the tool-event
        hook resolver gets warm data without an extra read.
        """
        if self._state_db_path is None or not self._state_db_path.exists():
            return []
        # For each sidekick user_id, pick the row with the largest
        # started_at. The window-function approach keeps this to a
        # single round-trip; the index on (user_id, source) added at
        # startup speeds the partition scan.
        sql = """
            SELECT user_id, id, COALESCE(title, '') FROM (
                SELECT
                    s.user_id,
                    s.id,
                    s.title,
                    ROW_NUMBER() OVER (
                        PARTITION BY s.user_id
                        ORDER BY s.started_at DESC
                    ) AS rn
                FROM sessions s
                WHERE s.source = ? AND s.user_id IS NOT NULL
            )
            WHERE rn = 1
        """
        uri = f"file:{self._state_db_path}?mode=ro"
        try:
            with contextlib.closing(
                sqlite3.connect(uri, uri=True, timeout=2.0)
            ) as conn:
                rows = conn.execute(sql, (SIDEKICK_SOURCE,)).fetchall()
        except sqlite3.OperationalError:
            # Older SQLite without window functions — fall back to a
            # correlated subquery. Pi 5 ships SQLite 3.40+ so this is
            # belt-and-braces only.
            sql_fallback = """
                SELECT s.user_id, s.id, COALESCE(s.title, '')
                FROM sessions s
                WHERE s.source = ?
                  AND s.user_id IS NOT NULL
                  AND s.started_at = (
                      SELECT MAX(s2.started_at) FROM sessions s2
                      WHERE s2.user_id = s.user_id AND s2.source = ?
                  )
            """
            with contextlib.closing(
                sqlite3.connect(uri, uri=True, timeout=2.0)
            ) as conn:
                rows = conn.execute(
                    sql_fallback, (SIDEKICK_SOURCE, SIDEKICK_SOURCE),
                ).fetchall()
        out = [(chat_id, sid, title) for chat_id, sid, title in rows]
        # Refresh the sid → chat_id cache opportunistically.
        self._sid_to_chat_id_cache = {sid: cid for cid, sid, _t in out}
        return out


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
    """Hermes plugin entry point.

    Adapter wiring itself is handled by the gateway patch (the plugin
    system has no register_platform_adapter API yet). What we DO use
    PluginContext for: pre_tool_call / post_tool_call hooks (Phase 3
    tool-event surfacing). Hooks dispatch to the live SidekickAdapter
    via a module-level reference set in connect(); when no adapter is
    live (or the session isn't a sidekick DM) the callbacks are silent
    no-ops.
    """

    def _pre(**kwargs: Any) -> None:
        adapter = _active_adapter
        if adapter is None:
            return
        try:
            adapter.on_pre_tool_call(**kwargs)
        except Exception:
            logger.exception("[sidekick] pre_tool_call hook crashed")

    def _post(**kwargs: Any) -> None:
        adapter = _active_adapter
        if adapter is None:
            return
        try:
            adapter.on_post_tool_call(**kwargs)
        except Exception:
            logger.exception("[sidekick] post_tool_call hook crashed")

    try:
        ctx.register_hook("pre_tool_call", _pre)
        ctx.register_hook("post_tool_call", _post)
    except Exception:
        logger.exception(
            "[sidekick] failed to register pre/post_tool_call hooks; "
            "tool-event envelopes will not be emitted"
        )
        return
    logger.debug("[sidekick] registered pre_tool_call / post_tool_call hooks")
