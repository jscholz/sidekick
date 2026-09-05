"""Parley platform adapter for hermes-agent.

Runs an aiohttp HTTP server bound to localhost that speaks the abstract
agent contract (OpenAI-Responses-shaped). The parley proxy (Node.js)
talks to it via /v1/* endpoints; the agent contract is documented at
``docs/ABSTRACT_AGENT_PROTOCOL.md`` in the parley repo.

Parley is a peer of telegram / slack / signal — the hermes gateway
owns the chat_id → session_id mapping natively.

HTTP surface
------------
All routes auth-gate on ``Authorization: Bearer <token>`` where
``<token>`` is read from env var ``PARLEY_PLATFORM_TOKEN`` at adapter
startup.

Channel contract (the OAI-compat surface)::

    GET    /health
    GET    /v1/conversations              # drawer list (parley rows)
    GET    /v1/conversations/{id}/items   # transcript replay
    DELETE /v1/conversations/{id}         # cascade delete
    PATCH  /v1/conversations/{id}         # rename (sets sessions.title)
    POST   /v1/responses                  # turn dispatch (SSE on stream:true)
    GET    /v1/events                     # out-of-turn SSE

Gateway extension (parley-defined, optional)::

    GET    /v1/gateway/conversations      # cross-platform drawer list

The proxy probes ``/v1/gateway/conversations`` first; on 404 it falls
back to the channel surface and stamps source='parley'. Hermes
implements the gateway endpoint because hermes IS a gateway —
telegram, slack, whatsapp etc. live behind the same state.db.

Inbound dispatch goes through ``/v1/responses`` which calls
``self.handle_message(MessageEvent(...))``. The gateway resolves the
session via the standard
``build_session_key(SessionSource(platform=Platform.PARLEY, chat_id=...))``
DM path — ``agent:main:parley:dm:<chat_id>``.

Outbound envelope shapes (see ParleyEnvelope in
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
(translated by the proxy back to the parley envelope shape). All
others ride ``/v1/events`` with a Last-Event-ID replay ring.

``session_changed`` is detected via state.db polling
(``_session_poll_loop``) — no hermes core patches required for it.
Trade-off: ~1.5s lag between compression and the PWA seeing the new
title.

PDF rasterization
-----------------
Parley PWA uploads of ``application/pdf`` are rasterized to per-page
PNGs in ``_materialize_attachments`` via ``_rasterize_pdf`` (which
shells out to ``pdftoppm`` from poppler-utils). The PDF tempfile is
unlinked after rasterization; the agent only sees images via the
existing ``media_urls`` → vision-tool pipeline. This is parley-only
scope — telegram / slack / whatsapp / signal each have separate
attachment flows in ``gateway/platforms/*.py`` and don't share this
materializer (yet).

System dep: ``apt install poppler-utils`` on Debian/Ubuntu, or
``brew install poppler`` on macOS. Without it PDFs are dropped and a
clear error is logged at the first PDF upload attempt.

Knobs (env, with defaults sized for a Pi 5 host):
``PARLEY_PDF_DPI`` (150), ``PARLEY_PDF_MAX_PAGES`` (50),
``PARLEY_PDF_RASTERIZE_TIMEOUT_S`` (30),
``PARLEY_PDF_MAX_BYTES`` (20 MiB).

See ``docs/archive/PDF_RASTERIZATION_PROPOSAL.md`` in the parley
repo for design notes.

Install
-------
This adapter requires a hermes patch that registers
the Platform entry and the adapter-factory branch. See
``0001-add-parley-platform.patch`` and ``README.md`` next to this file.

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
from .parley_env import env_get
import re
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

_CRON_RESPONSE_RE = re.compile(
    r"^Cronjob Response:\s*.+?\s*\n"
    r"\(job_id:\s*[^)]+\)\s*\n"
    r"-+\s*\n+",
    re.DOTALL,
)

# ── PDF rasterization knobs ───────────────────────────────────────────
# When the PWA uploads a PDF via /api/parley/messages, we shell out to
# `pdftoppm` (poppler-utils) and replace the PDF tempfile with one PNG
# per page so vision-capable models (gemma-3, claude, gpt-4o, gemini)
# see it as N images via the existing media_urls path. The PDF tempfile
# itself is never handed to the agent — vision tools don't consume PDFs.
#
# Tunable via env at adapter startup. Defaults chosen for a Pi 5 host:
#  * 150 DPI keeps PNGs readable for body text without ballooning bytes.
#  * 100-page cap. Was 50, chosen for a Pi 5 — but a real slide deck
#    runs past it, and hitting the cap silently truncates the document
#    the agent reasons about (field 2026-09-04: a deck was cut at
#    exactly 50 and nothing said so). Raising it is NOT free: each page
#    becomes an inlined base64 image part in the user message, so 71
#    pages already produced a 12.8 MB message row. Treat this as a
#    ceiling on how much deck a single turn can carry, not a target —
#    the durable fix is to stop inlining page images per turn.
#  * 30s timeout is the hard ceiling per upload.
#  * 100 MB file-size cap (task #158) rejects abusive uploads before we
#    shell out; matches the client cap + the upload route ceiling.
PARLEY_PDF_DPI = int(env_get("PARLEY_PDF_DPI", "150"))
PARLEY_PDF_MAX_PAGES = int(env_get("PARLEY_PDF_MAX_PAGES", "100"))
PARLEY_PDF_RASTERIZE_TIMEOUT_S = int(
    env_get("PARLEY_PDF_RASTERIZE_TIMEOUT_S", "30")
)
PARLEY_PDF_MAX_BYTES = int(
    env_get("PARLEY_PDF_MAX_BYTES", str(100 * 1024 * 1024))
)

# ── tool-event hook plumbing ──────────────────────────────────────────
# pre_tool_call / post_tool_call hooks fire from worker threads (the
# agent dispatches tools via run_in_executor — see model_tools.py).
# We need a module-level reference to the live adapter so the sync
# hook callbacks can schedule envelope sends onto the adapter's
# event loop via asyncio.run_coroutine_threadsafe. The adapter sets
# this in connect() (after capturing its loop) and clears it in
# disconnect(). When None, hook handlers drop silently — non-parley
# deployments still load the plugin but never fire envelopes.
_active_adapter: Optional["ParleyAdapter"] = None

# Cap on the result string we put into a tool_result envelope. Tools
# can return arbitrarily large blobs (web_extract / browse). The PWA
# does its own per-tool truncation for display, but we cap here too
# so a runaway result can't blow up the WS frame budget.
TOOL_RESULT_MAX_BYTES = 50 * 1024

# /v1/responses streaming + /v1/events out-of-turn channel sizing.
# These bound worst-case memory if a consumer hangs.
TURN_QUEUE_MAX = 1000          # per-chat envelope queue depth
TURN_TIMEOUT_S = 120           # hold a /v1/responses turn open this long
# EVENT_REPLAY_CAP moved with the publisher into parley_route_events.py

# Session title cap (SESSION_TITLE_MAX_LEN) + sessions.json key prefix
# (SESSION_KEY_PREFIX) live in parley_route_conversations.py — they're
# only consumed by the rename / delete cascade.


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
# negligible at parley's single-user scale.
#
# Cadence: every 1.5s while a proxy client is connected. Skipped when
# disconnected (no listener — would be wasted I/O). The first time we
# see a chat_id we record its initial state without emitting; the emit
# only fires on subsequent (session_id, title) changes.
SESSION_POLL_INTERVAL_S = 1.5

# TTL for the _read_session_rows result cache. The poller ticks every
# SESSION_POLL_INTERVAL_S, but the underlying recursive-CTE query only
# needs to re-run when state.db sessions/titles may have changed —
# turn-end (reply_final/notification) and rename/delete paths flush the
# cache explicitly, so within-TTL polls between events serve from
# memory. Backstop for changes the plugin can't observe (e.g. hermes
# core writing a generated title after the turn): worst-case staleness
# is this TTL. Added with the 2026-08-26 200%-CPU diagnosis — the
# uncached query ran back-to-back at every 1.5s tick and was one of
# the two continuously-busy executor threads.
SESSION_ROWS_CACHE_TTL_S = float(
    env_get("PARLEY_SESSION_ROWS_CACHE_TTL_MS", "5000") or 5000
) / 1000.0

# Source allow-list for the cross-platform gateway drawer. Any
# `sessions.source` value not in this set is dropped at query time.
# This is the canonical hermes-agent platform set as of the platform-
# adapter migration; if hermes adds a new platform, drop it in here.
# ID-encoding helpers + source constants moved to parley_ids.py
# so route-handler submodules can import them without a circular dep
# on this package's __init__. Re-exported here for backward compat
# with any caller that still references them from the package root.
from .parley_ids import (  # noqa: F401
    GATEWAY_DRAWER_SOURCES,
    PARLEY_SOURCE,
    _GATEWAY_ID_SEP,
    _format_gateway_id,
    _parse_gateway_id,
)



_PARLEY_HIDDEN_COMMANDS = frozenset({
    # Genuinely terminal-coupled commands — parley has its own
    # surfaces for these, OR they're nonsense outside a TUI.
    "clear",      # terminal screen wipe; parley scrollback differs
    "redraw",     # TUI repaint
    "skin",       # display theme; TUI-specific
    "indicator",  # TUI busy-indicator style (kaomoji/emoji/...)
    "statusbar",  # TUI status bar toggle
    "copy",       # terminal clipboard via OSC52
    "paste",      # terminal paste of system clipboard
    "image",      # terminal image attach; parley has its own attach UI
    "quit",       # close TUI; parley tabs close differently
    # /new is dispatchable but triggers the destructive-slash confirm
    # flow (gateway/run.py:_maybe_confirm_destructive_slash). The
    # parley "New chat" button skips that — it's the canonical UX for
    # this action. Hide here so the slash popover doesn't surface it.
    "new",
})


def _serialize_command_registry() -> List[Dict[str, Any]]:
    """Build the JSON payload served by ``GET /v1/commands``.

    Pulls from the central ``hermes_cli.commands.COMMAND_REGISTRY`` and
    any plugin-registered commands (via the existing
    ``_iter_plugin_command_entries`` helper).

    Two filters apply:

      1. ``_PARLEY_HIDDEN_COMMANDS`` — manually-curated drop list for
         entries that are nonsense in a chat UI even if dispatchable
         (terminal-only utilities + redundant chat-flow commands).

      2. ``GATEWAY_KNOWN_COMMANDS`` membership — the gateway only
         dispatches commands without ``cli_only=True`` (or with a
         ``gateway_config_gate``). Exposing a ``cli_only`` command in
         the slash popover gives the user a discoverable trap: pick
         it, send it, and Clawdian replies "Unknown command" because
         gateway/run.py rejects the dispatch. Align the catalog with what
         the gateway will actually run, so the popover only lists
         things that work end-to-end.

    Aliases stay on the canonical row (the PWA matches both names
    against the same entry — no separate row per alias). Returns an
    empty list if ``hermes_cli`` is unavailable, so non-hermes test
    contexts don't blow up.
    """
    try:
        from hermes_cli.commands import (
            COMMAND_REGISTRY,
            GATEWAY_KNOWN_COMMANDS,
            _iter_plugin_command_entries,
        )
    except Exception:
        return []
    out: List[Dict[str, Any]] = []
    for cmd in COMMAND_REGISTRY:
        if cmd.name in _PARLEY_HIDDEN_COMMANDS:
            continue
        # Gateway-dispatchable only. Without this, /tools, /skills, /cron,
        # /history, /save etc surface in the popover but fail at dispatch
        # with "Unknown command".
        if cmd.name not in GATEWAY_KNOWN_COMMANDS:
            continue
        out.append({
            "name": cmd.name,
            "description": cmd.description,
            "category": cmd.category,
            "aliases": list(cmd.aliases),
            "args_hint": cmd.args_hint,
            "subcommands": list(cmd.subcommands),
        })
    try:
        plugin_entries = _iter_plugin_command_entries()
    except Exception:
        plugin_entries = []
    for name, description, args_hint in plugin_entries:
        out.append({
            "name": name,
            "description": description,
            "category": "Plugins",
            "aliases": [],
            "args_hint": args_hint or "",
            "subcommands": [],
        })
    return out


def check_parley_requirements() -> bool:
    """Return True when adapter dependencies are available.

    Required: aiohttp (already a hermes core dep — webhook adapter uses it).

    Note: ``Platform.PARLEY`` is created on demand by ``Platform._missing_``
    once this plugin's ``register(ctx)`` has called ``ctx.register_platform``,
    so we no longer have to verify the enum entry by hand. The
    ``PARLEY_PLATFORM_TOKEN`` gate lives in the auth path on the WS
    server, not here — adapter instantiation is allowed without a token,
    just unauthenticated requests get rejected.
    """
    if not AIOHTTP_AVAILABLE:
        logger.warning("[parley] aiohttp not installed")
        return False
    return True


class ParleyAdapter(BasePlatformAdapter):
    """Hermes platform adapter speaking JSON-over-WebSocket to the parley proxy.

    A single proxy client connects on startup and stays connected; per-
    conversation traffic is multiplexed by ``chat_id`` on every envelope.
    """

    # WS frames are not size-limited the way Telegram messages are, but we
    # still cap individual chunks to keep the JS side responsive.
    MAX_MESSAGE_LENGTH: int = 64 * 1024

    def __init__(self, config: PlatformConfig):
        # Platform.PARLEY is created on demand by Platform._missing_ as
        # soon as our register(ctx) calls ctx.register_platform("parley"),
        # so by the time we land here the enum lookup always succeeds.
        # If a future hermes version drops _missing_ we'd see an
        # AttributeError or ValueError below — surface it loudly rather
        # than papering over.
        # Platform id was "sidekick" until the 2026-08 identity purge:
        # every store (state.db session keys, gateway_routing, parley.db
        # chat-id prefixes, hindsight metadata) was rewritten in the same
        # cutover by scripts/migrate-sidekick-to-parley.sh.
        super().__init__(config, Platform("parley"))

        extra = config.extra or {}
        self._host: str = extra.get(
            "host", env_get("PARLEY_PLATFORM_HOST", DEFAULT_HOST)
        )
        self._port: int = int(
            extra.get("port", env_get("PARLEY_PLATFORM_PORT", str(DEFAULT_PORT)))
        )
        self._token: str = extra.get(
            "token", env_get("PARLEY_PLATFORM_TOKEN", "")
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
        # the proxy/PWA side. When a /v1/responses request is active, the
        # route reserves its OpenAI Responses item id here first; send() must
        # reuse that id so the Parley envelope/write-through path and the
        # Responses SSE path describe the same assistant bubble.
        self._message_seq = 0
        self._response_message_ids: Dict[str, str] = {}

        # session_changed polling state. Map of chat_id → (session_id, title)
        # last seen in state.db. We only emit envelopes for transitions —
        # the first observation seeds the cache silently. The poller task is
        # spawned in connect() and cancelled in disconnect().
        self._session_state_cache: Dict[str, Tuple[str, str]] = {}
        self._session_poll_task: Optional[asyncio.Task] = None
        # TTL cache for _read_session_rows: (cached_at_monotonic, rows).
        # Single-slot — the query is parameterless per process. Written
        # from the poll executor thread, cleared from event handlers;
        # tuple assignment is atomic in CPython so the benign race
        # (one redundant query after a concurrent clear) needs no lock.
        # See SESSION_ROWS_CACHE_TTL_S for the perf rationale.
        self._session_rows_cache: Optional[Tuple[float, list]] = None
        # Perf-investigation tasks. Both gated behind PARLEY_PERF_TRACE
        # at the function level — when the env is off these tasks return
        # immediately, so the cost of always-instantiating them is nil.
        self._perf_loop_lag_task: Optional[asyncio.Task] = None
        self._perf_db_stats_task: Optional[asyncio.Task] = None
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

        # ── Parley supplemental store (per-backend SSOT) ────────────
        # Push subs / mutes / prefs / VAPID / pins / unread_state /
        # msg_links — see backends/hermes/plugin/parley_db.py.
        # Lazy-opened on first use to avoid touching disk during
        # __init__ (keeps test rigs happy).
        self._parley_db = None
        self._push_dispatcher = None
        # In-memory mirror of in-flight turns. Source of truth for
        # `/v1/conversations/{id}/items` mid-turn — bridges the gap
        # between POST receipt and the parley_msg_links write
        # that happens at reply_final. Mirrors openclaw plugin's
        # TurnBuffer (src/turn-buffer.js).
        from .parley_turn_buffer import TurnBuffer  # noqa: WPS433
        self._turn_buffer = TurnBuffer()
    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def connect(self, *, is_reconnect: bool = False, **_kwargs) -> bool:
        """Bind the WS server, listen for the proxy.

        ``is_reconnect`` arrived with hermes 0.18.x
        (gateway/platforms/base.py connect(*, is_reconnect)) — cold boot
        vs reconnect-after-drop. Our WS server binds identically in both
        cases, so it's accepted-and-ignored; ``**_kwargs`` absorbs any
        future upstream lifecycle kwargs so a gateway upgrade degrades
        to default behavior instead of a TypeError at connect time (the
        exact failure the 2026-07-13 0.18.2 swap hit).
        """
        if not self._token:
            logger.error(
                "[parley] PARLEY_PLATFORM_TOKEN unset — refusing to start. "
                "All inbound connections will be rejected without it."
            )
            self._set_fatal_error(
                "missing_token",
                "PARLEY_PLATFORM_TOKEN env var is required",
                retryable=False,
            )
            return False

        # Port-conflict pre-check (same pattern as webhook adapter).
        try:
            with _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM) as s:
                s.settimeout(1)
                s.connect(("127.0.0.1", self._port))
            logger.error(
                "[parley] Port %d already in use. "
                "Set PARLEY_PLATFORM_PORT or platforms.parley.port.",
                self._port,
            )
            return False
        except (ConnectionRefusedError, OSError):
            pass  # port is free

        # client_max_size lifted from aiohttp's 1 MiB default. Small
        # attachments still ride the base64-in-JSON /v1/responses body
        # (phone photos exceed the 1 MiB default once encoded). Large
        # files (task #158) come as raw bytes on /v1/parley/upload,
        # which needs ~100 MB headroom — so the app-wide limit is sized
        # for the upload route (the JSON path stays well under it because
        # the PWA routes anything over ~5 MB through the upload endpoint).
        # Perf-investigation arrival-time middleware. No-op unless
        # PARLEY_PERF_TRACE engages downstream handlers that read the
        # `t_perf_arrived` request attribute. Adding it unconditionally
        # keeps the import + composition path simple; the cost is a
        # single ``request['key'] = monotonic()`` per request.
        from . import parley_perf_trace as _perf  # noqa: WPS433
        self._app = web.Application(
            client_max_size=110 * 1024 * 1024,
            middlewares=[_perf.perf_arrival_middleware],
        )
        # ── Parley supplemental store + plugin-owned push/unread/pins ──
        # See backends/hermes/plugin/parley_db.py + parley_routes.py.
        # When PARLEY_PUSH_OWNED_BY_PLUGIN=true, the proxy forwards
        # /api/parley/notifications/* to /v1/push/* on us. Same flag
        # gates whether _safe_send_envelope fires push directly.
        from . import parley_db as _sdb  # noqa: WPS433 (local import keeps test rigs unaffected)
        from . import parley_routes as _sroutes  # noqa: WPS433
        from .parley_dispatcher import PushDispatcher as _PushDispatcher

        self._parley_db = _sdb.open_parley_db()
        # One-shot migration: copy legacy push subs from the proxy's
        # JSON file into the supplemental DB. Idempotent — subsequent
        # starts see the rows already there and skip silently.
        self._maybe_migrate_legacy_push_subs()
        # Idempotent shape convergence: translate a legacy `kinds`
        # push_prefs row (pre-2026-05-20 delegate shape, dead on read)
        # into the canonical per-key push_kind_* rows and drop it.
        # No-op when no legacy row exists. Never blocks boot.
        try:
            from . import parley_state as _sstate  # noqa: WPS433
            _sstate.migrate_legacy_push_prefs(self._parley_db)
        except Exception as _mig_err:
            logger.warning("[parley] legacy push_prefs migration failed: %s", _mig_err)
        vapid_subject = os.environ.get("VAPID_SUBJECT") or "mailto:jscholz@reimaginerobotics.ai"
        # unread_total_fn: server-truth badge count for push payloads
        # (sw.js → setAppBadge). Deferred closure — _state_db_path is
        # set above; compute_unread is TTL-cached so per-dispatch cost
        # is a cache lookup in the common case. Runs on the dispatch
        # worker thread, never the loop (parley_unread.py warning).
        def _unread_total() -> int:
            from .parley_unread import compute_unread  # noqa: WPS433
            return int(compute_unread(
                db=self._parley_db,
                state_db_path=self._state_db_path,
                source="parley",
            ).get("total", 0))
        self._push_dispatcher = _PushDispatcher(
            self._parley_db, vapid_subject=vapid_subject,
            unread_total_fn=_unread_total,
        )
        # Route ctx — collected fields the route handlers consume.
        # Wraps as a SimpleNamespace so the handlers can `ctx.db`,
        # `ctx.dispatcher`, etc. emit_envelope routes to the
        # plugin's existing out-of-turn fanout (replay ring + SSE
        # subscribers); the events handler picks them up.
        import types
        from . import parley_route_events as _route_events  # noqa: F401
        ctx = types.SimpleNamespace(
            db=self._parley_db,
            dispatcher=self._push_dispatcher,
            state_db_path=self._state_db_path,
            emit_envelope=lambda env: _route_events.publish_out_of_turn(self, env),
            send_envelope=self._safe_send_envelope,
            vapid_subject=vapid_subject,
            # Bearer-token check for routes that mutate agent state (the
            # scheduled-jobs extension); the push/unread siblings stay
            # loopback-only + unauthenticated as before.
            check_http_auth=self._check_http_auth,
        )
        _sroutes.register_routes(self._app, ctx)

        self._app.router.add_get("/health", self._handle_health)
        # Also expose at `/v1/health` so the parley proxy can hit a
        # plugin-served path (rather than the gateway's built-in
        # /health). On openclaw, the bare /health is owned by the
        # gateway itself and plugins can't shadow it — so the proxy's
        # healthcheck has to target a plugin-namespaced path to
        # actually verify "is the parley plugin loaded?" instead of
        # "is the gateway process up?". Same handler on both paths
        # keeps hermes side trivial.
        self._app.router.add_get("/v1/health", self._handle_health)
        # ── Agent contract HTTP routes ────────────────────────────────
        # OAI-Responses-shape surface the proxy talks to. See
        # docs/ABSTRACT_AGENT_PROTOCOL.md for the canonical reference.
        from . import parley_route_conversations as _route_conv
        self._app.router.add_get(
            "/v1/conversations",
            lambda r: _route_conv.handle_list(self, r),
        )
        from . import parley_route_items as _route_items
        self._app.router.add_get(
            "/v1/conversations/{id}/items",
            lambda r: _route_items.handle_get_items(self, r),
        )
        self._app.router.add_delete(
            "/v1/conversations/{id}",
            lambda r: _route_conv.handle_delete(self, r),
        )
        # Cross-device session rename. Local-IDB userTitle stamping
        # remains the source of truth from the originating device, but
        # this PATCH writes through to state.db so other connected
        # clients (Mac + iPhone) see the new title via the existing
        # session_changed envelope on /v1/events.
        self._app.router.add_patch(
            "/v1/conversations/{id}",
            lambda r: _route_conv.handle_rename(self, r),
        )
        # Gateway extension: cross-platform enumeration. Optional second
        # contract (`/v1/gateway/*`) the proxy probes-and-falls-back on.
        # Implemented here because hermes IS a gateway — telegram, slack,
        # whatsapp etc. live behind the same state.db. Stub agents and
        # single-channel agents simply don't expose this prefix; the
        # proxy 404s gracefully back to `/v1/conversations`.
        self._app.router.add_get(
            "/v1/gateway/conversations",
            lambda r: _route_conv.handle_list_gateway(self, r),
        )
        # Turn dispatch + out-of-turn event channel.
        from . import parley_route_responses as _route_resp
        self._app.router.add_post(
            "/v1/responses",
            lambda r: _route_resp.handle_responses(self, r),
        )
        from . import parley_route_events as _route_events
        self._app.router.add_get(
            "/v1/events",
            lambda r: _route_events.handle_events(self, r),
        )
        # Optional settings extension. Today: a single "model" enum
        # entry that wraps hermes config + the openrouter catalog,
        # filtered by PARLEY_PREFERRED_MODELS. Adding more
        # (persona, temperature, ...) is purely additive: extend
        # _build_settings_schema + _apply_setting.
        from . import parley_route_settings as _route_settings
        self._app.router.add_get(
            "/v1/settings/schema",
            lambda r: _route_settings.handle_schema(self, r),
        )
        self._app.router.add_post(
            "/v1/settings/{id}",
            lambda r: _route_settings.handle_update(self, r),
        )
        # Slash-command catalog. Surfaced as JSON so the PWA composer
        # can render an autocomplete popover from the same registry the
        # CLI / Telegram / Slack consume. See proposal in the parley
        # repo's slashCommands.ts module.
        self._app.router.add_get(
            "/v1/commands", self._handle_list_commands
        )
        # Auxiliary-model advertisement. Hermes auto-routes media_urls
        # through `_enrich_message_with_vision` → `vision_analyze_tool`
        # → `auxiliary.vision` (see hermes-agent gateway/run.py:8275),
        # so the primary model never has to support vision directly.
        # Surface the configured auxiliary so the PWA can enable the
        # attachment button when the primary is text-only — without
        # this advertisement the button would stay disabled even though
        # the upload would actually work end-to-end.
        self._app.router.add_get(
            "/v1/parley/auxiliary-models",
            lambda r: _route_settings.handle_auxiliary_models(self, r),
        )
        # Model capability lookup — ground truth from hermes's models.dev
        # registry. Replaces the previous OpenRouter-catalog fetch +
        # regex-fallback in parley. Same data hermes consults at request
        # time for native-vs-text image routing.
        self._app.router.add_get(
            "/v1/parley/model-capabilities",
            lambda r: _route_settings.handle_model_capabilities(self, r),
        )
        # Large-file staging (task #158). Raw-bytes upload → upload_id;
        # the PWA references the id in its next turn's `attachments`
        # entry instead of inlining a base64 `content`. See
        # parley_route_upload + the upload_id branch in
        # _materialize_attachments.
        from . import parley_route_upload as _route_upload
        self._app.router.add_post(
            "/v1/parley/upload",
            lambda r: _route_upload.handle_upload(self, r),
        )
        # Cross-conversation FTS5 search. Reads against the same
        # messages_fts virtual table hermes_state.SessionDB maintains
        # — the index is hermes-owned, we just SELECT against it.
        # Returns the SearchResult shape (sessions+hits) the cmd+K
        # palette already consumes.
        self._app.router.add_get(
            "/v1/conversations/search", self._handle_search_conversations
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
            "[parley] WS server listening on %s:%d (token=%s***)",
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

        # Perf-investigation watchers (no-op unless PARLEY_PERF_TRACE=1).
        # Loop-lag samples event-loop responsiveness; db-stats logs
        # parley.db size + key row counts at start + hourly.
        from . import parley_perf_trace as _perf
        _perf.log_db_stats(self._parley_db, label="startup")
        self._perf_loop_lag_task = asyncio.create_task(
            _perf.loop_lag_watcher(),
            name="parley-perf-loop-lag",
        )
        self._perf_db_stats_task = asyncio.create_task(
            _perf.db_stats_periodic_loop(self._parley_db),
            name="parley-perf-db-stats",
        )

        # Spawn the state.db poller for session_changed emission. Logs
        # once at startup so an operator can confirm it's wired.
        if self._state_db_path is not None:
            self._session_poll_task = asyncio.create_task(
                self._session_poll_loop(),
                name="parley-session-poll",
            )
            logger.info(
                "[parley] session_changed poller armed against %s "
                "(interval=%.1fs)",
                self._state_db_path,
                SESSION_POLL_INTERVAL_S,
            )
        else:
            logger.warning(
                "[parley] state.db path not resolved — "
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

        # Tear down perf watchers symmetrically — they're regular asyncio
        # tasks that need explicit cancellation on a clean shutdown.
        for attr in ("_perf_loop_lag_task", "_perf_db_stats_task"):
            t = getattr(self, attr, None)
            if t is not None:
                t.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await t
                setattr(self, attr, None)

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
        logger.info("[parley] disconnected")

    # ------------------------------------------------------------------
    # HTTP / WS handlers
    # ------------------------------------------------------------------

    async def _handle_health(self, request: "web.Request") -> "web.Response":
        return web.json_response(
            {
                "status": "ok",
                "platform": "parley",
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
            chat_name=f"parley:{chat_id[:8]}",
            chat_type="dm",
            user_id=chat_id,        # one user-per-chat in single-tenant model
            user_name="parley-user",
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

        # Pre-enrich images in parallel so a multi-page PDF (= N image
        # paths after rasterization) doesn't pay N×serial-vision-call
        # latency in the gateway's `_enrich_message_with_vision` loop.
        # See _parallel_image_enrich docstring for the trade-off.
        if media_urls:
            text, media_urls, media_types, message_type = await self._parallel_image_enrich(
                text, media_urls, media_types, message_type,
            )

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
    def _image_input_mode_is_native() -> bool:
        """True when the active model takes images natively this turn.

        Mirrors the gateway's ``_decide_image_input_mode`` (gateway/run.py):
        reads the active provider/model + config.yaml and asks
        ``agent.image_routing.decide_image_input_mode``. Falls back to
        False (text-mode pre-analysis) on any error, so a missing/renamed
        hermes module degrades to the prior behavior rather than dropping
        the image enrichment entirely.
        """
        try:
            from agent.image_routing import decide_image_input_mode
            from agent.auxiliary_client import _read_main_model, _read_main_provider
            from hermes_cli.config import load_config

            cfg = load_config()
            provider = _read_main_provider()
            model = _read_main_model()
            return decide_image_input_mode(provider, model, cfg) == "native"
        except Exception as exc:
            logger.debug(
                "[parley] image_input_mode decision failed, enriching as text — %s",
                exc,
            )
            return False

    async def _parallel_image_enrich(
        self,
        text: str,
        media_urls: List[str],
        media_types: List[str],
        message_type: "MessageType",
    ) -> Tuple[str, List[str], List[str], "MessageType"]:
        """Pre-enrich image attachments via auxiliary vision in parallel.

        Why this lives in the parley plugin (and not in hermes core):
        parley is the only platform that rasterizes PDFs to N image
        pages — every other adapter (telegram, signal, slack, ...) sees
        at most a handful of attached images per turn. The gateway's
        ``_enrich_message_with_vision`` (gateway/run.py) iterates
        ``image_paths`` SERIALLY by design — fine for 1-3 images, brutal
        for a 21-page PDF (21 × ~5s = ~100s before the primary model
        sees any text). Parallelizing in the plugin keeps the win where
        the cost actually lands without forcing a hermes-core change.

        Strategy: split image entries off ``media_urls``, run
        ``vision_analyze_tool`` in parallel via ``asyncio.gather``, and
        prepend the descriptions to ``text`` using the SAME format the
        gateway's enrich loop produces — so agent behavior is identical
        (the path-embedded follow-up hint lets the agent re-call
        ``vision_analyze`` for a closer look at any specific page).

        Non-image media (audio, video) is left in ``media_urls`` for the
        gateway to handle through its own enrichers — those run once per
        attachment and aren't a multi-page bottleneck.

        NOTE: this pre-analysis only makes sense in TEXT image-input mode.
        When the active model takes images natively (``image_input_mode:
        native``), pre-analyzing here and stripping the images from
        ``media_urls`` would silently defeat the gateway's native-image
        path — the primary model would get a text description instead of
        the pixels (field report 2026-06-17). In native mode we leave the
        images untouched so the gateway attaches them natively; the serial
        multi-page latency this method exists to avoid doesn't apply,
        because native mode skips the vision-enrich loop entirely.
        """
        if self._image_input_mode_is_native():
            return text, media_urls, media_types, message_type

        from tools.vision_tools import vision_analyze_tool

        image_indices = [
            i for i, m in enumerate(media_types)
            if m.startswith("image/") or message_type == MessageType.PHOTO
        ]
        if not image_indices:
            return text, media_urls, media_types, message_type

        image_paths = [media_urls[i] for i in image_indices]

        analysis_prompt = (
            "Describe everything visible in this image in thorough detail. "
            "Include any text, code, data, objects, people, layout, colors, "
            "and any other notable visual information."
        )

        async def _analyze_one(path: str) -> str:
            try:
                result_json = await vision_analyze_tool(
                    image_url=path,
                    user_prompt=analysis_prompt,
                )
                result = json.loads(result_json)
                if result.get("success"):
                    description = result.get("analysis", "")
                    return (
                        f"[The user sent an image~ Here's what I can see:\n{description}]\n"
                        f"[If you need a closer look, use vision_analyze with "
                        f"image_url: {path} ~]"
                    )
                return (
                    "[The user sent an image but I couldn't quite see it "
                    "this time (>_<) You can try looking at it yourself "
                    f"with vision_analyze using image_url: {path}]"
                )
            except Exception as e:
                logger.error("[parley] parallel vision enrich error: %s", e)
                return (
                    "[The user sent an image but something went wrong when I "
                    "tried to look at it~ You can try examining it yourself "
                    f"with vision_analyze using image_url: {path}]"
                )

        enriched_parts = await asyncio.gather(*(_analyze_one(p) for p in image_paths))

        prefix = "\n\n".join(enriched_parts)
        new_text = f"{prefix}\n\n{text}" if text else prefix

        # Strip image entries from the media arrays so the gateway's
        # serial enrich loop doesn't re-process them. Audio / video
        # entries (if any) are preserved for the gateway to handle.
        image_set = set(image_indices)
        keep = [(media_urls[i], media_types[i]) for i in range(len(media_urls)) if i not in image_set]
        if keep:
            new_urls, new_types = map(list, zip(*keep))
            new_kinds = [self._kind_for_mime(t) for t in new_types]
        else:
            new_urls, new_types, new_kinds = [], [], []
        return new_text, new_urls, new_types, self._dominant_message_type(new_kinds)

    @staticmethod
    def _rasterize_pdf(path: Path) -> List[Path]:
        """Rasterize a PDF to per-page PNG files alongside the source.

        Shells out to ``pdftoppm`` (poppler-utils). Output PNGs land in
        the same directory as ``path`` with the input stem as their
        prefix; pdftoppm names them ``<prefix>-<N>.png`` (zero-padded
        when there are 10+ pages, plain otherwise).

        Limits — all overridable via env (see module-level constants):

        * ``PARLEY_PDF_MAX_BYTES`` (default 20 MB): if the PDF on disk
          exceeds this, we log a warning and return ``[]`` — caller
          drops the attachment, agent sees no images for it.
        * ``PARLEY_PDF_MAX_PAGES`` (default 50): passed to pdftoppm
          via ``-l N`` so it stops after N pages.
        * ``PARLEY_PDF_DPI`` (default 150): ``-r N``.
        * ``PARLEY_PDF_RASTERIZE_TIMEOUT_S`` (default 30): subprocess
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

        if file_size > PARLEY_PDF_MAX_BYTES:
            logger.warning(
                "[hermes-plugin] PDF %s rejected: %dB > %dB cap",
                path, file_size, PARLEY_PDF_MAX_BYTES,
            )
            return []

        # pdftoppm writes <prefix>-1.png, <prefix>-2.png ... in the
        # parent dir. Use the input's stem as the prefix so cleanup
        # (which already walks the per-turn paths list) is uniform.
        prefix = str(path.with_suffix(""))
        cmd = [
            "pdftoppm",
            "-png",
            "-r", str(PARLEY_PDF_DPI),
            "-l", str(PARLEY_PDF_MAX_PAGES),
            str(path),
            prefix,
        ]
        try:
            subprocess.run(
                cmd,
                capture_output=True,
                timeout=PARLEY_PDF_RASTERIZE_TIMEOUT_S,
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
                PARLEY_PDF_RASTERIZE_TIMEOUT_S, path,
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

        # Truncation must be LOUD. `-l MAX_PAGES` silently stops at the
        # cap and nothing downstream can tell a 50-page deck from the
        # first 50 pages of a 120-page one, so the agent reasons over a
        # partial document and answers with full confidence. Field
        # 2026-09-04: a deck hit the cap exactly, the remaining slides
        # were never rasterized, and the only trace was an INFO line
        # reading "rasterized 50 pages" — indistinguishable from a deck
        # that really had 50. Ask pdfinfo for the true count so we can
        # say so. Best-effort: a pdfinfo failure must not fail the
        # upload, it just costs us the warning.
        total_pages = None
        try:
            info = subprocess.run(
                ["pdfinfo", str(path)],
                capture_output=True, timeout=10, check=True,
            )
            for line in (info.stdout or b"").decode(errors="ignore").splitlines():
                if line.startswith("Pages:"):
                    total_pages = int(line.split(":", 1)[1].strip())
                    break
        except Exception:
            pass

        if total_pages is not None and total_pages > len(pages):
            logger.warning(
                "[hermes-plugin] PDF TRUNCATED: %s has %d pages, rasterized "
                "only %d (PARLEY_PDF_MAX_PAGES=%d) — the agent will not see "
                "pages %d-%d",
                path, total_pages, len(pages), PARLEY_PDF_MAX_PAGES,
                len(pages) + 1, total_pages,
            )

        logger.info(
            "[hermes-plugin] rasterized %d pages from %s (%sp, %dB)",
            len(pages), path,
            len(pages) if total_pages is None else f"{len(pages)}/{total_pages}",
            file_size,
        )
        return pages

    def _materialize_attachments(
        self, attachments: list,
    ) -> Tuple[List[str], List[str], "MessageType"]:
        """Decode base64 ``data:`` URL payloads to tempfiles. Returns
        ``(paths, mime_types, dominant_message_type)``.

        The PWA sends each attachment as
        ``{type, mimeType, fileName, content}`` where ``content`` is a
        full ``data:<mime>;base64,<payload>`` string — OR, for large
        files (task #158), as ``{type, mimeType, fileName, uploadId}``
        referencing a file already staged via ``/v1/parley/upload``
        (handled by the ``uploadId`` branch below). Hermes wants
        on-disk paths in ``MessageEvent.media_urls`` (telegram adapter
        models this — it downloads photos to a cache dir, then sets
        media_urls to those paths). We mirror that contract for the
        parley path: write to ``/tmp/parley-attach-<uuid>.<ext>``
        and let the OS clean tmpdirs on its own schedule (parley is
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

        Parley-only scope: telegram/whatsapp/slack/signal each have
        their own platform adapters with separate attachment flows
        (``gateway/platforms/*.py``). Cross-channel PDF support is a
        follow-up.
        """
        import base64
        import tempfile

        from . import parley_route_upload as _route_upload

        paths: List[str] = []
        mimes: List[str] = []
        kinds: List[str] = []
        for a in attachments:
            if not isinstance(a, dict):
                continue
            # Large-file path (task #158): the attachment references a
            # previously-staged upload by id instead of inlining base64.
            # Resolve the id to its on-disk staging path and run it
            # through the same PDF-rasterize / image branches below.
            upload_id = a.get("uploadId") or a.get("upload_id")
            if upload_id:
                staged = _route_upload.staged_path(str(upload_id))
                if staged is None:
                    logger.warning(
                        "[parley] upload_id %r not found in staging", upload_id,
                    )
                    continue
                mime = a.get("mimeType") or ""
                if mime.lower() == "application/pdf":
                    pages = self._rasterize_pdf(staged)
                    try:
                        staged.unlink()
                    except OSError:
                        pass
                    for page in pages:
                        paths.append(str(page))
                        mimes.append("image/png")
                        kinds.append("image")
                else:
                    paths.append(str(staged))
                    mimes.append(mime)
                    kinds.append(self._kind_for_mime(mime))
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
                logger.warning("[parley] base64 decode failed for attachment")
                continue
            ext = self._ext_for_mime(mime, a.get("fileName"))
            fd, path = tempfile.mkstemp(
                prefix="parley-attach-", suffix=ext, dir="/tmp",
            )
            try:
                with os.fdopen(fd, "wb") as f:
                    f.write(payload)
            except Exception:
                logger.exception("[parley] failed writing attachment to %s", path)
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
        return paths, mimes, self._dominant_message_type(kinds)

    @staticmethod
    def _dominant_message_type(kinds: List[str]) -> "MessageType":
        """First-wins precedence over a kinds list ('image' | 'video' |
        'audio' | 'document'). Empty list → TEXT. Used by both
        _materialize_attachments (initial classification) and
        _parallel_image_enrich (post-strip recompute) so the two paths
        never drift on classification rules."""
        if not kinds:
            return MessageType.TEXT
        first = kinds[0]
        if first == "video":
            return MessageType.VIDEO
        if first == "audio":
            return MessageType.AUDIO
        if first == "document":
            return MessageType.DOCUMENT
        return MessageType.PHOTO

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


    async def _handle_search_conversations(self, request: "web.Request") -> "web.Response":
        """GET /v1/conversations/search?q=&limit=20 — FTS5 cross-conversation search.

        Reads against hermes' `messages_fts` index (maintained by
        hermes_state.SessionDB) — we just SELECT, hermes owns the writes.
        Filters to user/assistant roles by default (tool blobs would
        dominate noise from JSON-heavy outputs). Returns the
        `{sessions, hits}` shape `src/proxyClientTypes.ts:SearchResult`
        defines, so the PWA cmd+K palette renders without translation.
        """
        if not self._check_http_auth(request):
            return web.Response(status=401, text="invalid token")
        q = (request.query.get("q") or "").strip()
        try:
            limit = max(1, min(50, int(request.query.get("limit") or "20")))
        except (TypeError, ValueError):
            limit = 20
        if not q:
            return web.json_response({"sessions": [], "hits": []})
        if self._state_db_path is None or not self._state_db_path.exists():
            return web.json_response({"sessions": [], "hits": []})
        try:
            sessions, hits = await asyncio.get_running_loop().run_in_executor(
                None, self._search_conversations_sync, q, limit,
            )
        except Exception as e:
            logger.exception("[parley] search failed")
            return web.json_response(
                {"sessions": [], "hits": [], "error": str(e)},
                status=500,
            )
        return web.json_response({"sessions": sessions, "hits": hits})

    def _search_conversations_sync(
        self, q: str, limit: int,
    ) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        """Synchronous worker for `/v1/conversations/search`.

        FTS5 query syntax: auto-prefix-wildcards on bare tokens (matches
        hermes_cli/web_server.py:740's pattern — `nimb` → `nimb*` so
        partial-word queries match). Quoted phrases and existing wildcards
        pass through. Tokens with FTS5 operator chars are passed verbatim
        for power users.
        """
        prefix_query = self._fts5_query_for(q)
        sql = f"""
            SELECT
                m.id           AS message_id,
                m.session_id   AS session_id,
                m.role         AS role,
                snippet(messages_fts, 0, '', '', '…', 32) AS snippet,
                m.timestamp    AS timestamp,
                s.user_id      AS chat_id,
                s.source       AS source,
                COALESCE(s.title, '') AS session_title
            FROM messages_fts
            JOIN messages m ON m.id = messages_fts.rowid
            JOIN sessions s ON s.id = m.session_id
            WHERE messages_fts MATCH ?
              AND m.role IN ('user', 'assistant')
              AND s.source IN ({",".join("?" for _ in GATEWAY_DRAWER_SOURCES)})
            ORDER BY rank
            LIMIT ?
        """
        params: List[Any] = [prefix_query, *GATEWAY_DRAWER_SOURCES, limit]
        uri = f"file:{self._state_db_path}?mode=ro"
        with contextlib.closing(
            sqlite3.connect(uri, uri=True, timeout=2.0)
        ) as conn:
            try:
                rows = conn.execute(sql, params).fetchall()
            except sqlite3.OperationalError:
                # FTS5 syntax error despite sanitization (e.g. user passed
                # raw `OR` token without context). Empty rather than 500 —
                # the cmd+K palette keeps showing the cached session-filter
                # results above.
                rows = []
            id_rows = self._session_id_matches(conn, q)

        # Group by (chat_id, source) for the sessions list. Best rank
        # wins for ordering; preserve hit order in the flat list.
        # Session-ID matches go FIRST: when the query looks like a
        # hermes session id (FTS can't see those — they never appear
        # in message text), the resolved conversation is almost
        # certainly what the user wants.
        hits: List[Dict[str, Any]] = []
        sessions_by_key: Dict[Tuple[str, str], Dict[str, Any]] = {}
        for (chat_id, source, session_title) in id_rows:
            key = (chat_id, source)
            if key in sessions_by_key:
                continue
            sessions_by_key[key] = {
                "id": _format_gateway_id(source, chat_id),
                "source": source,
                "title": session_title or None,
                "snippet": None,
                "messageCount": None,
                "lastMessageAt": None,
            }
        for (message_id, session_id, role, snippet, timestamp,
             chat_id, source, session_title) in rows:
            prefixed_id = _format_gateway_id(source, chat_id)
            hits.append({
                "session_id": prefixed_id,
                "message_id": int(message_id),
                "role": role or "",
                "snippet": snippet or "",
                "timestamp": float(timestamp or 0),
                "session_title": session_title or "",
                "session_source": source or "",
            })
            key = (chat_id, source)
            if key not in sessions_by_key:
                sessions_by_key[key] = {
                    "id": prefixed_id,
                    "source": source,
                    "title": session_title or None,
                    "snippet": None,
                    "messageCount": None,
                    "lastMessageAt": None,
                }

        return list(sessions_by_key.values()), hits

    @staticmethod
    def _session_id_matches(
        conn: "sqlite3.Connection", q: str,
    ) -> List[Tuple[str, str, str]]:
        """Match `q` as a hermes session-id substring → owning chats.

        FTS can't find session ids (they never appear in message
        text), so searching `20260611_223425_98bd2b` returned nothing
        even though the session exists. This pass LIKE-matches
        sessions.id and resolves each hit to its root conversation.

        Rotated/compacted child sessions have user_id=NULL — walk
        parent_session_id up (bounded, same pattern as
        _session_belongs_to_chat) until a user_id-bearing root is
        found, and filter on the ROOT's source so child rows with
        NULL source still resolve.

        Only runs for queries that plausibly are id fragments: a
        single [A-Za-z0-9_] token of >= 4 chars. `_` is a LIKE
        single-char wildcard, so the pattern is escaped.

        Returns [(chat_id, source, title)] — at most a handful.
        """
        token = q.strip()
        if (len(token) < 4 or not token.replace("_", "").isalnum()
                or any(c.isspace() for c in token)
                or not all(ord(c) < 128 for c in token)):
            return []
        escaped = (token.replace("\\", "\\\\")
                        .replace("%", "\\%")
                        .replace("_", "\\_"))
        sql = f"""
            WITH RECURSIVE walk(start_id, cur_user_id, cur_source,
                                cur_title, parent_id, depth) AS (
                SELECT s.id, s.user_id, s.source, COALESCE(s.title, ''),
                       s.parent_session_id, 0
                  FROM sessions s
                 WHERE s.id LIKE ? ESCAPE '\\'
                UNION ALL
                SELECT w.start_id, p.user_id, p.source,
                       COALESCE(p.title, ''), p.parent_session_id,
                       w.depth + 1
                  FROM walk w
                  JOIN sessions p ON p.id = w.parent_id
                 WHERE w.cur_user_id IS NULL AND w.depth < 20
            )
            SELECT DISTINCT w.cur_user_id, w.cur_source, w.cur_title
              FROM walk w
             WHERE w.cur_user_id IS NOT NULL
               AND w.cur_source IN ({",".join("?" for _ in GATEWAY_DRAWER_SOURCES)})
             LIMIT 10
        """
        try:
            return conn.execute(
                sql, ["%" + escaped + "%", *GATEWAY_DRAWER_SOURCES],
            ).fetchall()
        except sqlite3.OperationalError:
            return []

    @staticmethod
    def _fts5_query_for(q: str) -> str:
        """Auto-add prefix wildcards on bare tokens so partial words match.

        Mirrors hermes_cli/web_server.py:740. `"quoted phrases"` and
        existing `wildcards*` pass through. Tokens containing FTS5
        operator chars (parens, colons) pass through verbatim — power
        users get raw FTS5 syntax; everyone else gets prefix matching.

        Special-char tokens (e.g. `@s.whatsapp.net`, `foo-bar-baz`,
        `user@example.com`) are wrapped in double quotes so FTS5
        doesn't parse `-` as NOT, `.`/`@` as separators with prefix-*
        producing junk, etc. Quoted phrases match the unicode61-
        tokenized subwords as a NEAR-style consecutive run, which
        recovers indexability of these tokens. No prefix-* on quoted
        phrases (FTS5 doesn't allow it inside quotes; users typing
        these strings want exact substring anyway).

        Field-driven additions 2026-05-11: `@s.whatsapp.net` returned
        zero hits because `s.net` got tokenized weirdly with the prefix
        wildcard. Quoting fixes it. Same for dashed tokens — `-` is
        the FTS5 NOT operator and a bare token like `smoke-search-marker`
        was parsing as `smoke AND NOT search AND NOT marker`.
        """
        import re
        tokens = []
        for token in re.findall(r'"[^"]*"|\S+', q.strip()):
            # Power-user passthroughs: existing quotes, existing
            # wildcard, or any of (, ), : which the original logic
            # treated as raw-FTS5-syntax markers.
            if (token.startswith('"')
                    or token.endswith("*")
                    or any(c in token for c in '():')):
                tokens.append(token)
                continue
            # Wrap any token with non-word characters in quotes so
            # FTS5 operator chars (-, +, etc.) and unicode61 splitters
            # (@, ., /) don't corrupt the query. Escape embedded
            # quotes by doubling per FTS5 convention.
            if any(not (c.isalnum() or c == '_') for c in token):
                tokens.append('"' + token.replace('"', '""') + '"')
                continue
            tokens.append(token + "*")
        return " ".join(tokens) or q.strip()

    async def _handle_list_commands(self, request: "web.Request") -> "web.Response":
        """GET /v1/commands — slash-command catalog for the parley PWA.

        Serializes the central CommandDef registry from
        ``hermes_cli.commands`` plus any plugin-registered commands so
        the PWA composer can render an autocomplete popover. Filter
        rules mirror the gateway's other surfaces (telegram BotCommands,
        Slack subcommand mapping): drop ``cli_only`` entries unless
        their ``gateway_config_gate`` is truthy. Aliases ride on the
        canonical row (no separate entries) — the PWA matches both.

        Response shape:

            {
              "object": "list",
              "data": [
                {"name": "new", "description": "...", "category": "Session",
                 "aliases": ["reset"], "args_hint": "", "subcommands": []},
                ...
              ]
            }
        """
        if not self._check_http_auth(request):
            return web.Response(status=401, text="invalid token")
        try:
            data = await asyncio.to_thread(_serialize_command_registry)
        except Exception as e:
            logger.exception("[parley] /v1/commands build failed")
            return web.json_response(
                {"error": {"type": "server_error", "message": str(e)}},
                status=500,
            )
        return web.json_response({"object": "list", "data": data})


    # Pretty names for the auth-error enrichment below. Provider slugs
    # come from hermes' credential pool; the user-facing reply uses
    # these instead so "openai-codex" doesn't appear verbatim.
    _PROVIDER_DISPLAY_NAMES = {
        "openai-codex": "ChatGPT (Codex)",
        "openrouter": "OpenRouter",
        "copilot": "GitHub Copilot",
        "anthropic": "Anthropic",
    }

    def _enrich_auth_error_text(self, original: str) -> Optional[str]:
        """If `original` is the misleading "Provider authentication
        failed: No <X> credentials stored" wrapper hermes core emits
        when its resolver skips an `exhausted` credential (post-429),
        return a richer replacement with reset time + UI hint.

        Returns None when no exhausted credential matches — caller
        keeps the original message unchanged.

        Intercept point lives in `_safe_send_envelope` so both
        blocking and streaming /v1/responses paths benefit from one
        substitution. Reads ~/.hermes/auth.json directly because
        hermes core has no read-only credential-status endpoint and
        we don't want to import its private auth_store internals.
        """
        if "Provider authentication failed" not in original:
            return None
        auth_path = Path(os.environ.get("HERMES_HOME") or "~/.hermes").expanduser() / "auth.json"
        try:
            with open(auth_path, encoding="utf-8") as f:
                store = json.load(f)
        except (OSError, json.JSONDecodeError):
            return None
        active = (store.get("active_provider") or "").strip()
        if not active:
            return None
        pool = store.get("credential_pool") or {}
        creds = pool.get(active) or []
        exhausted: Optional[Dict[str, Any]] = None
        for cred in creds:
            if isinstance(cred, dict) and cred.get("last_status") == "exhausted":
                exhausted = cred
                break
        if exhausted is None:
            return None
        display = self._PROVIDER_DISPLAY_NAMES.get(active, active)
        reset_at = exhausted.get("last_error_reset_at")
        when = ""
        if isinstance(reset_at, (int, float)) and reset_at > 0:
            now = time.time()
            remaining = max(0, int(reset_at - now))
            hours, mins = divmod(remaining // 60, 60)
            if hours >= 24:
                days, hours = divmod(hours, 24)
                relative = f"{days}d {hours}h"
            elif hours:
                relative = f"{hours}h {mins}m"
            else:
                relative = f"{mins}m"
            try:
                absolute = time.strftime("%a %-I:%M %p", time.localtime(reset_at))
            except Exception:
                absolute = time.strftime("%a %H:%M", time.localtime(reset_at))
            when = f" Resets in {relative} ({absolute})."
        return (
            f"⚠️ {display} usage limit reached.{when}"
            f" Switch to a different model in Settings → Agent → Model to continue."
        )


    # ------------------------------------------------------------------
    # Outbound
    # ------------------------------------------------------------------

    def _reserve_response_message_id(self, chat_id: str, message_id: str) -> None:
        """Bind the current /v1/responses assistant item id to ``chat_id``.

        The route handler mints the OpenAI Responses ``msg_*`` id before
        dispatch. Hermes core then calls ``send()`` from inside the adapter.
        Without this reservation, ``send()`` minted a separate ``sk-*`` id for
        the Parley envelope/write-through row while the SSE response exposed
        ``msg_*`` to the proxy/PWA. B2 then joined durable rows back with the
        ``sk-*`` id, so inflight and durable bubbles no longer shared identity.
        """
        if chat_id and message_id:
            self._response_message_ids[chat_id] = message_id

    def _release_response_message_id(self, chat_id: str, message_id: str) -> None:
        """Drop a reservation if it still points at this request's id."""
        if not chat_id:
            return
        if self._response_message_ids.get(chat_id) == message_id:
            self._response_message_ids.pop(chat_id, None)

    def _next_message_id(self, chat_id: Optional[str] = None) -> str:
        if chat_id:
            reserved = self._response_message_ids.get(chat_id)
            if reserved:
                return reserved
        self._message_seq += 1
        return f"msg_{secrets.token_hex(10)}"

    @staticmethod
    def _push_owned_by_plugin() -> bool:
        """Mirrors the proxy's ``isPushOwnedByPlugin`` env check.
        When set, dispatch lives here; the proxy is just a passthrough."""
        v = env_get("PARLEY_PUSH_OWNED_BY_PLUGIN", "")
        return v == "true" or v == "1"

    def _maybe_migrate_legacy_push_subs(self) -> None:
        """One-shot migration: copy push subscriptions out of the
        proxy's JSON file (``~/.parley/notifications/push-subscriptions.json``)
        into the supplemental DB. Idempotent — re-runs skip rows that
        already exist by endpoint. Failure is non-fatal: legacy subs
        stay working until migration succeeds on a later boot.
        """
        if self._parley_db is None:
            return
        from .parley_state import upsert_subscription, list_subscriptions
        try:
            json_path = Path.home() / ".parley" / "notifications" / "push-subscriptions.json"
            if not json_path.exists():
                return
            with open(json_path, "r", encoding="utf-8") as f:
                rows = json.load(f)
            if not isinstance(rows, list):
                return
            existing = {s["endpoint"] for s in list_subscriptions(self._parley_db)}
            imported = 0
            for r in rows:
                ep = r.get("endpoint") if isinstance(r, dict) else None
                keys = (r.get("keys") or {}) if isinstance(r, dict) else {}
                p256dh = keys.get("p256dh")
                auth = keys.get("auth")
                ua = r.get("userAgent") or ""
                if not ep or not p256dh or not auth:
                    continue
                if ep in existing:
                    continue
                upsert_subscription(
                    self._parley_db,
                    endpoint=ep, p256dh=p256dh, auth=auth, user_agent=ua,
                )
                imported += 1
            if imported:
                logger.info("[parley] migrated %d legacy push subscriptions → sqlite", imported)
        except Exception as exc:
            logger.warning("[parley] legacy push subs migration skipped: %s", exc)

    def _record_envelope_writethrough(
        self, env: Dict[str, Any], env_type: Optional[str],
    ) -> None:
        """Parley.db write-through (Phase 1) + targeted cache flushes.

        Upserts the envelope into the parley.db message store, then
        drops the compute_unread TTL cache ONLY when the write can
        actually change an unread count: a persisted reply_final /
        notification (the sole producers of role='assistant'
        status='final' rows — see _UNREAD_AFFECTING_ENVELOPE_TYPES in
        parley_unread).

        This used to invalidate on EVERY call on the theory that
        persist-detection was "much pricier than a dict.clear()" —
        which inverted reality (2026-08-26 200%-CPU diagnosis, "5-30s
        replies" field report): every streaming reply_delta cleared
        the cache, so each /unread poll during a turn re-ran the full
        multi-second scan and two executor threads sat in
        _compute_unread_uncached continuously. The type gate is a
        set-membership check; a spurious clear costs a full recompute
        per poller.

        reply_final/notification also mean state.db just gained (or is
        about to gain) new session/title rows — flush the session-rows
        poll cache too, so the session_changed poller sees the
        post-turn state on its next 1.5s tick instead of after the
        TTL. Extracted from _safe_send_envelope so the gating is unit-
        testable without the full envelope-routing machinery.
        """
        if self._parley_db is None:
            return
        try:
            from . import parley_state as _sstate  # local import
            persisted_row_id = _sstate.record_envelope(self._parley_db, env)
            from . import parley_unread as _sunread
            if (persisted_row_id is not None
                    and _sunread.envelope_affects_unread(env_type)):
                _sunread.invalidate_unread_cache()
                self.invalidate_session_rows_cache()
        except Exception as exc:
            logger.warning("[parley] parley.db record failed: %s", exc)

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

        # Stamp `should_push` so the parley proxy can decide push
        # delivery without having to reverse-engineer it from type +
        # content. Plugin owns "what is user-actionable":
        #   - reply_final + notification → True (the user-facing
        #     surfaces; the proxy's isPushEligible defaults to these
        #     types anyway, but explicit is better than implicit).
        #   - everything else → False (streaming deltas, typing,
        #     tool envelopes, session_changed metadata).
        # Caller can override by setting should_push explicitly before
        # calling _safe_send_envelope — useful for the (eventual)
        # notification kind='debug' carve-out or for a chatty
        # reply_final that's just a tool acknowledgement.
        if "should_push" not in env:
            # Mutate the caller-owned envelope. Notification persistence
            # deliberately stamps ``parley_id`` onto this same object and
            # send() returns that id to the gateway. Rebinding to a shallow
            # copy here made the persisted/live envelope correct while the
            # caller still saw an empty message_id.
            env["should_push"] = env_type in ("reply_final", "notification")

        # Replace hermes' misleading "No <provider> credentials stored"
        # wrapper with a chat message that names the actual problem
        # (quota exhausted, reset time) and points the user at the UI
        # control. Single intercept point covers both /v1/responses
        # paths + the out-of-turn channel.
        if env_type == "reply_delta":
            text = env.get("text")
            if isinstance(text, str):
                replacement = self._enrich_auth_error_text(text)
                if replacement is not None:
                    env = {**env, "text": replacement}

        # In-flight turn buffer: capture tool/reply envelopes for the
        # mid-flight /items merge. Closes on reply_final (state.db is
        # now authoritative). Independent of the in-turn vs out-of-turn
        # routing below. The popped TurnEntry is kept for the turn
        # linker's close capture (scheduled further down) — it carries
        # the turn's call-id set + reply_final message_id.
        closed_turn_entry = None
        if self._turn_buffer is not None:
            try:
                self._turn_buffer.observe_envelope(env)
                if env_type == "reply_final" and chat_id and not env.get("interim"):
                    closed_turn_entry = self._turn_buffer.close_turn(chat_id)
            except Exception as exc:
                logger.warning("[parley] turn buffer observe failed: %s", exc)

        # Notification persistence: cron output, /background results,
        # scheduled reminders, approval prompts all flow as
        # `type=notification` envelopes today. Persist first so the
        # minted parley_id is the single identity used by state.db,
        # parley.db write-through, and the live SSE envelope.
        if env_type == "notification":
            self._persist_notification(env)

        # Phase 1: parley.db write-through. Every persisted envelope
        # type (user_message / reply_delta / reply_final / tool_call /
        # tool_result / notification) upserts a row into the parley.db
        # message store. Items endpoint doesn't read from this yet
        # (Phase 2 switches the read path) — rows accumulate alongside
        # the existing state.db path so a write-path bug here can't
        # break reads. See top-of-file design block in parley_db.py.
        self._record_envelope_writethrough(env, env_type)

        # Transcript v3 Phase 1 (dark launch): schedule the turn
        # linker's turn-end capture off-loop. reply_final closes the
        # open watermark window; a notification with no open window is
        # a background turn (cron/scheduler) and synthesizes one. Safe
        # to capture now: hermes-core persists the turn's rows strictly
        # BEFORE the plugin sees reply_final — the gateway's single
        # end-of-run persistence step commits before final_response is
        # extracted and delivered (see _process_message_background in
        # gateway/run.py). Runs AFTER _persist_notification + the
        # write-through above so a notification's agent_row_id link is
        # already in msg_links when the window classifies (rule-1
        # pre-exclusion). No-op when PARLEY_TURN_LINKER=0.
        if env_type in ("reply_final", "notification") and chat_id:
            try:
                from . import parley_turn_linker as _linker  # noqa: WPS433
                _linker.schedule_close(self, chat_id, env, closed_turn_entry)
            except Exception as exc:
                logger.warning(
                    "[parley] turn-linker close schedule failed: %s", exc,
                )

        # Plugin-owned push dispatch. Fires on push-eligible envelopes
        # (reply_final, notification) when PARLEY_PUSH_OWNED_BY_PLUGIN
        # is set on the matching proxy. Independent of the in-turn vs
        # out-of-turn routing below — we ship the push REGARDLESS of
        # which channel the envelope rides client-side.
        if self._push_dispatcher and self._push_owned_by_plugin():
            try:
                # Reply-buffer side-channel: reply_delta envelopes
                # carry cumulative agent text; reply_final carries
                # only the terminator. observe_envelope stashes
                # delta text per-chat and drains on final, returning
                # the body for dispatch. Notification envelopes pass
                # through unchanged.
                body_override = self._push_dispatcher.observe_envelope(env)
                if body_override is None and env_type == "reply_final":
                    # Pre-buffer state (proxy started mid-turn) or
                    # adapter emitted text on the final itself —
                    # fall back to env.text/content.
                    body_override = env.get("text") or env.get("content") or ""
                dispatch_result = self._push_dispatcher.dispatch_envelope(
                    env, body_override=body_override
                )
                self._persist_activity_for_push(
                    env,
                    body_override=body_override,
                    dispatch_result=dispatch_result,
                )
            except Exception as exc:
                logger.warning("[parley.push] dispatch failed: %s", exc)

        from . import parley_route_events as _route_events

        if env_type in in_turn_types and chat_id:
            queue = self._turn_queues.get(chat_id)
            if queue is not None:
                # Tool events are observational UI state. Keep feeding the
                # active /v1/responses queue for Responses-compatible clients,
                # but also publish them on the persistent Parley event stream
                # so every open PWA sees tool progress incrementally. Without
                # this, the originating request stream saw function-call items
                # but the transcript-centric event channel only caught up from
                # /messages after the turn ended.
                if env_type in ("tool_call", "tool_result"):
                    try:
                        _route_events.publish_out_of_turn(self, env)
                    except Exception as exc:
                        logger.warning("[parley] tool event publish failed: %s", exc)
                try:
                    queue.put_nowait(env)
                    return True
                except asyncio.QueueFull:
                    logger.warning(
                        "[parley] turn queue full for %s, dropping %s",
                        chat_id, env_type,
                    )

        # Out-of-band envelopes
        # only existed in the proxy's SSE replay ring (minutes of
        # retention) and Web Push delivery (one-shot banner) — never
        # persisted to state.db.messages because that table feeds the
        # LLM context loop. Result: clicking an iOS push notification
        # opened the chat but the content wasn't anywhere durable, so
        # the user lost the body whenever the banner dismissed.
        #
        # Mint a parley_id for the envelope, write a row to the plugin-owned
        # `parley_notifications` sibling table, stamp the id on the
        # outgoing envelope. The history endpoint merges these rows
        # into /v1/conversations/{id}/items so a refresh-and-scroll
        # finds the notification in the transcript with the same
        # data-message-id machinery cmdk + pin-drawer already use.
        published = _route_events.publish_out_of_turn(self, env)

        # Cross-device unread sync: when a push-eligible envelope lands
        # for a chat, every connected device needs to know its unread
        # count just changed. Without this, other devices' badges stay
        # stale until they manually foreground. The PWA's listener (in
        # badge.ts) is debounced 1500ms, so the cumulative effect of
        # an active conversation is one re-fetch per ~1.5s window per
        # chat — cheap.
        #
        # Ordering note (corrected 2026-07-20): hermes' state.db write
        # commits BEFORE the plugin sees reply_final — the gateway's
        # end-of-run persistence step runs inside the agent-result
        # chain, and final_response is only extracted and delivered
        # after it returns (gateway/run.py _process_message_background;
        # the turn linker's turn-end capture relies on the same
        # ordering). An earlier version of this comment claimed the
        # opposite; the badge count computed on the PWA's follow-up
        # fetch is NOT racing the row flush.
        if env_type in ("reply_final", "notification") and chat_id:
            try:
                _route_events.publish_out_of_turn(self, {
                    "type": "unread_changed",
                    "chat_id": chat_id,
                    "cause": env_type,
                })
            except Exception as exc:
                logger.debug("[parley] unread_changed publish failed: %s", exc)

        return published

    def _persist_activity_for_push(
        self,
        env: Dict[str, Any],
        *,
        body_override: Optional[str] = None,
        dispatch_result: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Persist Activity rows for notifications that actually fired.

        Activity is the durable counterpart to OS/Web Push, not an all-message
        feed. If dispatch is suppressed because the chat is engaged, muted, or
        disabled by prefs, do not create an Activity item. This keeps the right
        drawer aligned with what the user was externally alerted about.
        """
        if self._parley_db is None:
            return
        delivered = 0
        if isinstance(dispatch_result, dict):
            try:
                delivered = int(dispatch_result.get("delivered") or 0)
            except Exception:
                delivered = 0
        if delivered <= 0:
            return

        env_type = env.get("type") if isinstance(env.get("type"), str) else ""
        raw_chat_id = env.get("chat_id") if isinstance(env.get("chat_id"), str) else ""
        if not raw_chat_id:
            return
        chat_id = raw_chat_id if _GATEWAY_ID_SEP in raw_chat_id else f"{PARLEY_SOURCE}{_GATEWAY_ID_SEP}{raw_chat_id}"

        if env_type == "reply_final":
            kind = "agent_reply"
            item_id = env.get("message_id") if isinstance(env.get("message_id"), str) else ""
            title_label = env.get("title") if isinstance(env.get("title"), str) else ""
            title = f"Reply · {title_label}" if title_label else "Agent reply"
            body = body_override or env.get("content") or env.get("text") or ""
        elif env_type == "notification":
            env_kind = env.get("kind") if isinstance(env.get("kind"), str) else "notification"
            kind = env_kind if env_kind in ("approval", "cron") else "notification"
            item_id = env.get("parley_id") if isinstance(env.get("parley_id"), str) else ""
            if not item_id:
                item_id = env.get("message_id") if isinstance(env.get("message_id"), str) else ""
            if not item_id:
                item_id = f"notif_{int(time.time() * 1000)}_{secrets.token_hex(3)}"
                env["parley_id"] = item_id
            raw_title = env.get("title") if isinstance(env.get("title"), str) else ""
            if kind == "approval":
                title = raw_title or "Approval required"
            elif kind == "cron":
                title = raw_title or "Cron notification"
            else:
                title = raw_title or "Notification"
            body = body_override or env.get("content") or env.get("text") or ""
        else:
            return

        if not item_id:
            return
        if not isinstance(body, str):
            body = str(body)
        urgent = bool(env.get("urgent")) or kind == "approval"

        try:
            from . import parley_state as _sstate
            # True mint time: notif_* ids embed their epoch-ms mint. A
            # replayed envelope (gateway restart re-driving the
            # notification path) re-persisting a PRUNED item must land
            # at its original time, not the replay batch's time.time()
            # — otherwise old items resurrect at the top of the pane
            # (field 2026-07-20: four cron items spanning Jul 18-20
            # re-inserted with one identical replay-batch created_at).
            created_at = _sstate.mint_time_from_activity_id(item_id)
            if created_at is None:
                created_at = time.time()
            # Born-read coverage: an item older than the chat's
            # last_read_at pointer is something the user has already
            # read past — insert it read so a replay of a pruned item
            # can't mint a phantom unread the chat can no longer clear.
            # NEVER for unresolved approvals (this path always inserts
            # resolved=None): they block a workflow until actioned.
            read = False
            if kind != "approval":
                try:
                    row = _sstate.get_unread_row(self._parley_db, chat_id)
                    if row is None and raw_chat_id != chat_id:
                        # Legacy bare-id unread_state rows.
                        row = _sstate.get_unread_row(self._parley_db, raw_chat_id)
                    last_read_at = row.get("lastReadAt") if row else None
                    if isinstance(last_read_at, (int, float)) and created_at <= last_read_at:
                        read = True
                except Exception:
                    read = False
            _sstate.upsert_activity_item(
                self._parley_db,
                id=item_id,
                chat_id=chat_id,
                kind=kind,
                title=title,
                body=body,
                created_at=created_at,
                urgent=urgent,
                read=read,
                message_id=item_id,
                resolved=None,
            )
            try:
                from . import parley_route_events as _route_events
                _route_events.publish_out_of_turn(self, {
                    "type": "activity_changed",
                    "chat_id": chat_id,
                    "item_id": item_id,
                    "kind": kind,
                    "cause": env_type,
                })
            except Exception as exc:
                logger.debug("[parley] activity_changed publish failed: %s", exc)
        except Exception as exc:
            logger.warning("[parley] activity persist failed: %s", exc)

    def _persist_notification(self, env: Dict[str, Any]) -> None:
        """Persist a notification in Hermes' canonical message history.

        The assistant body belongs in ``state.db.messages`` so the agent sees
        its own out-of-turn output on the next turn. Parley-specific identity
        and ``kind`` metadata belong in ``parley.db.msg_links``; the
        subsequent write-through reads ``agent_row_id`` from this envelope and
        links the supplemental row directly. The retired
        ``state.db.parley_msg_links`` table must not be recreated.

        Best-effort: failures only mean the row won't enter Hermes context or
        survive through state.db alone. The parley.db write-through and live
        SSE fan-out still happen regardless."""
        if self._state_db_path is None or not self._state_db_path.exists():
            return
        chat_id_raw = env.get("chat_id", "")
        if not isinstance(chat_id_raw, str) or not chat_id_raw:
            return
        chat_id_bare = chat_id_raw
        if _GATEWAY_ID_SEP in chat_id_bare:
            _src, _, rest = chat_id_bare.partition(_GATEWAY_ID_SEP)
            chat_id_bare = rest
        content = env.get("content")
        if not isinstance(content, str) or not content:
            return
        existing_sk_id = env.get("parley_id")
        if isinstance(existing_sk_id, str) and existing_sk_id.startswith("notif_"):
            return
        session_id = self._resolve_session_id_for_chat(chat_id_bare)
        if not session_id:
            logger.warning(
                "[parley] notification persist: no session for chat=%s — skipping",
                chat_id_bare,
            )
            return
        sk_id = f"notif_{int(time.time() * 1000)}_{secrets.token_hex(3)}"
        env["parley_id"] = sk_id
        try:
            with contextlib.closing(
                sqlite3.connect(self._state_db_path, timeout=5.0)
            ) as conn:
                with conn:
                    cur = conn.execute(
                        "INSERT INTO messages "
                        "(session_id, role, content, timestamp) "
                        "VALUES (?, 'assistant', ?, ?)",
                        (session_id, content, time.time()),
                    )
                    state_db_id = cur.lastrowid
                # The transaction committed successfully. The parley.db
                # write-through immediately after this method consumes the
                # cross-link and stores kind + parley_id there.
                env["agent_row_id"] = str(state_db_id)
        except Exception as exc:
            logger.warning(
                "[parley] notification persist failed (non-fatal): %s", exc
            )

    def _resolve_session_id_for_chat(self, chat_id_bare: str) -> Optional[str]:
        """Best-effort: return the latest active state.db session_id
        for a parley chat. Used by notification persistence so the
        row lands in the same session lineage hermes will read at
        history-fetch time. None when state.db is missing or the chat
        has no rows yet (fresh-chat notification — should be rare)."""
        if self._state_db_path is None or not self._state_db_path.exists():
            return None
        uri = f"file:{self._state_db_path}?mode=ro"
        try:
            with contextlib.closing(
                sqlite3.connect(uri, uri=True, timeout=2.0)
            ) as conn:
                row = conn.execute(
                    "SELECT id FROM sessions "
                    "WHERE user_id = ? AND source = ? "
                    "ORDER BY started_at DESC LIMIT 1",
                    (chat_id_bare, PARLEY_SOURCE),
                ).fetchone()
            return row[0] if row else None
        except Exception:
            return None

    # _publish_out_of_turn moved to parley_route_events.publish_out_of_turn
    # (2026-05-17). Call sites use `_route_events.publish_out_of_turn(self,
    # env)` directly so the same module owns the SSE reader + publisher.

    async def send_clarify(
        self,
        chat_id: str,
        question: str,
        choices: Optional[list],
        clarify_id: str,
        session_key: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        """Deliver hermes 0.18's blocking ``clarify`` prompt as a
        first-class ``agent_question`` envelope (unified elicitation
        protocol, 2026-07-13).

        Without this override, the base class's plain-text "❓" fallback
        rode the reply path during an active turn and never surfaced —
        the agent then blocked invisibly for up to ``clarify_timeout``
        (field incident: 58 minutes at "iteration 25/60, clarify").

        The PWA renders the envelope as a pop-up with choice buttons +
        free text; the answer comes back via POST /v1/questions/{id}
        which resolves ``tools.clarify_gateway``. ``expires_at`` (epoch
        ms) drives the pop-up's countdown so UI lifetime always matches
        the gateway's actual wait. Text replies in the chat also still
        resolve it via the gateway's text-intercept — the envelope also
        enables mark_awaiting_text for choice prompts so a typed answer
        works exactly like the base fallback promised.
        """
        expires_at_ms: Optional[int] = None
        try:
            from tools.clarify_gateway import get_clarify_timeout, mark_awaiting_text  # noqa: WPS433
            expires_at_ms = int((time.time() + get_clarify_timeout()) * 1000)
            # Typed replies must resolve choice prompts too (parity with
            # the base-class text fallback).
            if choices:
                mark_awaiting_text(clarify_id)
        except Exception:  # pragma: no cover — pre-0.18 hermes without clarify
            pass
        env = {
            "type": "agent_question",
            "chat_id": chat_id,
            "question_id": clarify_id,
            "kind": "clarify",
            "question": question,
            "choices": list(choices) if choices else [],
            "allow_free_text": True,
            "expires_at": expires_at_ms,
            "urgent": True,
        }
        ok = await self._safe_send_envelope(env)
        logger.info(
            "[parley] clarify %s → agent_question envelope (chat=%s choices=%d ok=%s)",
            clarify_id, chat_id, len(choices or []), ok,
        )
        return SendResult(success=ok, message_id=clarify_id)

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
        from .parley_dispatcher import is_approval_prompt, is_progress_heartbeat
        from .parley_route_conversations import is_chat_deleted

        # Late output for a chat the user DELETED mid-turn: drop it.
        # The delete handler interrupts the running turn, but a reply
        # already past the loop's last interrupt check still lands here
        # — and letting it through re-adds the chat to known ids, fans
        # out an envelope, and (via turn-end persistence) resurrects
        # the session as a zombie (field 2026-07-13: a 6s test
        # recording's ingest reply rebuilt its deleted session).
        # Reporting success keeps the gateway loop unwinding normally.
        # Residual: hermes-core turn-end persistence may still recreate
        # the state.db session row (we're patch-free upstream by
        # policy); it stays invisible here and the user can re-delete
        # the rare zombie row. Tombstone TTL 10min.
        if is_chat_deleted(self, chat_id):
            logger.info(
                "[parley] send() dropped for deleted chat %s (%d chars) — "
                "turn outlived its session's deletion", chat_id, len(content or ""),
            )
            return SendResult(success=True, message_id="")

        # Hermes approval prompts are blocking workflow events. They
        # arrive as normal adapter text, so classify them into a
        # Parley-owned urgent notification before the regular reply
        # path persists/renders them as assistant prose.
        if is_approval_prompt(content or ""):
            if chat_id not in self._known_chat_ids:
                self._known_chat_ids.add(chat_id)
            # expires_at (epoch ms) mirrors the gateway's real approval
            # window (tools.approval, config approvals.timeout, default
            # 60s) so the PWA pop-up can live exactly as long as the
            # approval does and render EXPIRED when it dies — instead of
            # the user approving a corpse ("/approve → No pending
            # command", field 2026-07-13).
            approval_timeout_s = 60
            try:
                from hermes_cli.config import load_config  # noqa: WPS433
                _cfg = load_config() or {}
                approval_timeout_s = int(
                    ((_cfg.get("approvals", {}) or {}).get("timeout", 60)) or 60
                )
            except Exception:
                pass
            env = {
                "type": "notification",
                "chat_id": chat_id,
                "kind": "approval",
                "content": content,
                "text": content,
                "urgent": True,
                "expires_at": int((time.time() + approval_timeout_s) * 1000),
            }
            ok = await self._safe_send_envelope(env)
            return SendResult(success=ok, message_id=env.get("parley_id") or "")

        # Hermes cron delivery naturally arrives here through the live
        # platform adapter as a regular send() with a canonical wrapper.
        # There is no active /v1/responses queue for that background
        # delivery, so classify it as the product-facing cron notification
        # category instead of a normal agent reply. During an active user
        # turn, preserve the reply_delta/reply_final contract even if the
        # model happens to print the wrapper text.
        if chat_id not in self._turn_queues and _CRON_RESPONSE_RE.match(content or ""):
            if chat_id not in self._known_chat_ids:
                self._known_chat_ids.add(chat_id)
            env = {
                "type": "notification",
                "chat_id": chat_id,
                "kind": "cron",
                "content": content,
                "text": content,
            }
            ok = await self._safe_send_envelope(env)
            return SendResult(success=ok, message_id=env.get("parley_id") or "")

        # Mid-turn plumbing from the gateway (run_turn.py): the progress
        # heartbeat ("⏳ Working — N min — iteration i/n, tool") and the
        # inactivity warning arrive through send() because we deliberately
        # don't implement edit_message. Both carry the gateway's
        # `_interim_send` metadata marker; the agent's own holding replies
        # (run_turn_runner._send_status_text) do NOT.
        #
        # Heartbeats are a pulse, not conversation: emit them as an
        # ephemeral `status` envelope keyed per chat (the PWA renders a
        # working indicator, never a bubble; the proxy never pushes it).
        # Returning the status id as message_id makes the gateway's next
        # edit_message attempt target it, which we reject, so it falls
        # back to send() and we land here again — same key, text replaced.
        interim = bool(metadata and metadata.get("_interim_send"))
        if is_progress_heartbeat(content or ""):
            status_id = f"status_{chat_id}"
            ok = await self._safe_send_envelope({
                "type": "status",
                "chat_id": chat_id,
                "message_id": status_id,
                "text": content,
                "state": "working",
                "should_push": False,
                "ts": int(time.time() * 1000),
            })
            return SendResult(success=ok, message_id=status_id)

        # One bubble per send. The /v1/responses route reserves the turn's
        # msg_* id so the OAI item id and the Parley envelope id agree —
        # but every send() in the turn used to return that SAME id, so a
        # holding reply, then the real reply, then anything else all
        # edited one bubble and the earlier text vanished (field
        # 2026-09-05). Consume the reservation on first use; later sends
        # in the turn mint their own id. Interim advisories never take
        # the reservation at all — the OAI item id belongs to a reply.
        message_id = self._next_message_id(None if interim else chat_id)
        self._release_response_message_id(chat_id, message_id)
        # Surface a session_changed envelope the first time we ever see this
        # chat_id outbound. Today the gateway resolves session_id internally
        # so we don't have a stable session_id to surface; emit the chat_id
        # itself (the proxy already knows that) as a no-op stub. A future
        # on-compression callback would replace this with a real session_id.
        if chat_id not in self._known_chat_ids:
            self._known_chat_ids.add(chat_id)

        delta: Dict[str, Any] = {
            "type": "reply_delta",
            "chat_id": chat_id,
            "text": content,
            "message_id": message_id,
        }
        final: Dict[str, Any] = {
            "type": "reply_final", "chat_id": chat_id, "message_id": message_id,
        }
        if interim:
            # Tells the PWA this bubble does not end the turn (keep the
            # working indicator; don't treat it as "agent moved on").
            delta["interim"] = True
            final["interim"] = True
        ok = await self._safe_send_envelope(delta)
        await self._safe_send_envelope(final)
        return SendResult(success=ok, message_id=message_id)

    # NOTE: We deliberately DO NOT override edit_message. The base class
    # default returns success=False with "Not supported", which the
    # gateway's tool-progress sender (gateway/run.py:9576) interprets as
    # "this adapter doesn't support edit-in-place" — and consequently
    # drains the entire progress queue silently without invoking the
    # adapter at all.
    #
    # That's the behaviour we want here. Tool-progress messages
    # (`⚙️ tool_name: "preview"` lines) reach parley TWICE on every
    # tool call: once via the gateway's progress_callback path (would
    # become reply_delta text bubbles if we accepted them) and once via
    # this plugin's own on_pre_tool_call hook (which emits proper
    # `tool_call` envelopes that the PWA routes to the activity-row,
    # collapsed-by-default per agentActivity=summary). Accepting both
    # produced double-delivery: N consecutive cumulative
    # agent bubbles with tool-call lines, the actual agent reply buried
    # beneath them, only re-rendering cleanly after a session-switch
    # (which re-fetches from state.db where the ephemeral progress
    # messages were never persisted).
    #
    # The agent's actual reply text still flows through `send()` as a
    # single full-text message (gateway/platforms/base.py:2150-2157
    # uses `_send_with_retry` which calls `adapter.send()` once with
    # the full text — no per-token edits), so dropping edit_message
    # costs us nothing for real replies.

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

    # ------------------------------------------------------------------
    # Native file sends — `MEDIA:/abs/path` delivery
    #
    # Every other adapter (telegram, whatsapp, slack, matrix) implements
    # these. Parley did not, so `MEDIA:` markers fell through to
    # BasePlatformAdapter's fallback notice ("⚠️ Couldn't deliver the
    # image attachment") and the file was simply lost. That cost a real
    # deliverable on 2026-09-01: three deck assets produced, all dropped.
    #
    # No new envelope goes on the wire. We register the local file with
    # the parley proxy's media registry (proxy/parley/media.ts, whose
    # contract names "hermes plugin session" as a first-class caller) and
    # hand the resulting URL to the existing send_image path. The client
    # cannot distinguish this from an agent that embedded the markdown
    # reference by hand — which is the point: one delivery lane, not two.
    #
    # Failure is always non-fatal and falls back to super(), i.e. the
    # pre-existing notice. A split-host deployment whose proxy cannot see
    # our filesystem therefore behaves exactly as it does today.
    # ------------------------------------------------------------------

    def _proxy_origin(self) -> str:
        """Origin of the parley proxy that owns the media registry.

        The plugin's own HTTP port (DEFAULT_PORT) is the /v1/responses
        server — a different process from the Node proxy, hence a
        separate knob rather than a reuse.
        """
        return (env_get("PARLEY_PROXY_ORIGIN") or "http://127.0.0.1:3001").rstrip("/")

    async def _register_media(self, raw_path: str) -> Optional[Dict[str, Any]]:
        """Register a local file with the proxy; return its entry or None.

        Deliberately does NOT duplicate the proxy's extension allowlist.
        The registry is the single source of truth for what is servable
        and we interpret its error rather than second-guessing it — so
        widening the allowlist there needs no change here. It refuses
        true documents (.pdf, .svg) on purpose: that route reads the
        filesystem, and SVG in particular is scriptable and renders
        inline.
        """
        safe = self.validate_media_delivery_path(raw_path)
        if not safe:
            logger.warning(
                "[%s] media path rejected by the delivery guard: %s", self.name, raw_path
            )
            return None
        try:
            import aiohttp  # guarded — unit tests stub the runtime install
        except ImportError:
            logger.warning("[%s] aiohttp unavailable; cannot register media", self.name)
            return None
        url = f"{self._proxy_origin()}/api/parley/media/register"
        try:
            timeout = aiohttp.ClientTimeout(total=10)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(url, json={"path": safe}) as resp:
                    body = await resp.json(content_type=None)
                    if resp.status != 200 or not (body or {}).get("url"):
                        logger.warning(
                            "[%s] media register refused %s: HTTP %s %s",
                            self.name, safe, resp.status, (body or {}).get("error", ""),
                        )
                        return None
                    return body
        except Exception as exc:  # proxy down, network, bad JSON — all non-fatal
            logger.warning(
                "[%s] media register failed for %s: %s", self.name, safe, exc
            )
            return None

    async def send_image_file(
        self,
        chat_id: str,
        image_path: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs,
    ) -> SendResult:
        """Deliver a local image by registering it, then reusing send_image."""
        entry = await self._register_media(image_path)
        if not entry:
            return await super().send_image_file(
                chat_id, image_path, caption=caption,
                reply_to=reply_to, metadata=metadata, **kwargs,
            )
        return await self.send_image(
            chat_id, entry["url"], caption=caption,
            reply_to=reply_to, metadata=metadata,
        )

    async def send_document(
        self,
        chat_id: str,
        file_path: str,
        caption: Optional[str] = None,
        file_name: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs,
    ) -> SendResult:
        """Deliver a local file when the registry will serve it.

        The registry is a *media* lane, so true documents (.pdf, .svg,
        .csv) are refused and we fall back to the base notice — which
        names the file, so the user can still retrieve it themselves.
        Media that hermes happened to route as a document (an .mp4 or
        .png selected by mimetype) does get through: the markdown
        reference rides plain reply text and the client's card fallback
        parser classifies it by extension.
        """
        entry = await self._register_media(file_path)
        if not entry:
            return await super().send_document(
                chat_id, file_path, caption=caption, file_name=file_name,
                reply_to=reply_to, metadata=metadata, **kwargs,
            )
        label = caption or file_name or entry.get("filename") or "attachment"
        return await self.send(
            chat_id=chat_id,
            content=f"![{label}]({entry['url']})",
            reply_to=reply_to,
            metadata=metadata,
        )

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": chat_id, "type": "parley", "chat_id": chat_id}

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
    # adapter is intentionally promiscuous: it relays every parley
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
        non-parley sessions."""
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
        there's no matching pre_tool_call entry (filters non-parley)."""
        if not tool_call_id:
            return
        entry = self._inflight_tool_calls.pop(tool_call_id, None)
        if entry is None:
            # Either pre fired in a non-parley session (and we filtered
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
            "tool_name": tool_name,
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
                "[parley] index ensure failed (non-fatal): %s", exc
            )

    # Legacy linker methods (_capture_msg_high_water_mark,
    # _write_msg_links_after_turn) + the state.db parley_msg_links
    # side-table were deleted 2026-05-19 as part of the supplemental-
    # store migration. The replacement is parley.db.msg_links plus
    # the content-fingerprint linker in
    # `parley_state.reconcile_from_state_db`. See top-of-file design
    # block in `parley_db.py` for the full architecture.
    #
    # If a rollback is ever needed, the deleted code lives in git
    # history at commit a7d6c17's parent (8d4820a).

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
                logger.exception("[parley] session poll iteration failed")
            await asyncio.sleep(SESSION_POLL_INTERVAL_S)

    async def _poll_sessions_once(self) -> None:
        """One pass over the gateway's sessions table. Pushed off the
        event loop via a thread executor so the (tiny) sqlite read
        doesn't stall the WS pump."""
        rows = await asyncio.to_thread(self._read_session_rows)
        for chat_id, session_id, title in rows:
            prev = self._session_state_cache.get(chat_id)
            display_title = self._get_conversation_title_override(chat_id) or title or ""
            current = (session_id or "", display_title)
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
                "[parley] session_changed chat_id=%s session_id=%s title=%r",
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
        """Map a hermes session_id back to its parley chat_id, if any.

        chat_id IS ``sessions.user_id`` for parley sessions, so we
        look it up directly in state.db (one row, primary-key seek).
        Non-parley sessions naturally fail to resolve (source filter)
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
                    (session_id, PARLEY_SOURCE),
                ).fetchone()
        except Exception:
            return None
        if row is None or not row[0]:
            return None
        chat_id = row[0]
        self._sid_to_chat_id_cache[session_id] = chat_id
        return chat_id

    def _get_conversation_title_override(self, chat_id: str) -> Optional[str]:
        db = getattr(self, "_parley_db", None)
        if db is None:
            return None
        try:
            row = db.fetchone(
                "SELECT title FROM conversation_titles WHERE source = ? AND chat_id = ?",
                (PARLEY_SOURCE, chat_id),
            )
        except Exception as exc:
            logger.debug("[parley] title override read failed for %s: %s", chat_id, exc)
            return None
        if row is None:
            return None
        title = str(row["title"] if hasattr(row, "keys") else row[0]).strip()
        return title or None

    def invalidate_session_rows_cache(self) -> None:
        """Drop the _read_session_rows TTL cache so the next poll tick
        re-reads state.db. Called when sessions/titles are known to
        have changed: turn-end envelopes (record_envelope path) and the
        rename/delete conversation handlers. Rename in particular NEEDS
        this — the handler pre-seeds _session_state_cache with the new
        title, and a stale cached row would make the very next tick
        emit a session_changed that reverts the title client-side."""
        self._session_rows_cache = None

    def _read_session_rows(self) -> list:
        """Synchronous sqlite read — runs in a worker thread. Returns
        ``[(chat_id, session_id, title), …]`` for every parley
        chat's currently-latest session. Callers swallow exceptions.

        Powers the session_changed poller: a transition in either
        ``session_id`` or ``title`` for a known chat_id triggers a
        ``session_changed`` envelope to the proxy.

        Picks the LATEST session per ``user_id`` (chat_id) where
        ``source = 'parley'`` — i.e., whatever rotation
        compression/auto-reset has done, the row reflects what hermes
        is actively writing into right now. Also opportunistically
        refreshes the session_id → chat_id cache so the tool-event
        hook resolver gets warm data without an extra read.

        TTL-cached (SESSION_ROWS_CACHE_TTL_S) with event-driven flush
        via ``invalidate_session_rows_cache``: the poller ticks every
        1.5s but only needs fresh data after a turn end or a
        rename/delete; between events the tick serves from memory.
        """
        if self._state_db_path is None or not self._state_db_path.exists():
            return []
        now = time.monotonic()
        cached = self._session_rows_cache
        if cached is not None:
            cached_at, rows = cached
            if now - cached_at < SESSION_ROWS_CACHE_TTL_S:
                return rows
        # For each parley user_id, pick the row with the largest
        # started_at. The window-function approach keeps this to a
        # single round-trip; the index on (user_id, source) added at
        # startup speeds the partition scan.
        #
        # PERF (2026-08-26, 200%-CPU diagnosis): the recursive CTE used
        # to carry the FULL system_prompt (avg ~21KB) through every
        # recursion row and the planner re-scanned the accumulated
        # queue per candidate — 4.3s per call on the live 1322-session
        # state.db, running back-to-back at every 1.5s poll tick (one
        # of the two continuously-busy executor threads). Carrying only
        # the 200-char prompt HEAD + length and pinning the join order
        # with CROSS JOIN (the same rewrite _summaries_by_user_id got
        # on 2026-07-13) cuts it to ~16ms. Semantics identical: the
        # original also compared only the first 200 chars of the ROOT's
        # prompt, propagated unchanged.
        sql = """
            WITH RECURSIVE session_root(id, root_user_id, root_source, prompt_head, prompt_len) AS (
                SELECT id, user_id, source,
                       SUBSTR(COALESCE(system_prompt, ''), 1, 200),
                       LENGTH(COALESCE(system_prompt, ''))
                  FROM sessions
                 WHERE user_id IS NOT NULL
                UNION ALL
                SELECT s.id, sr.root_user_id, sr.root_source, sr.prompt_head, sr.prompt_len
                  FROM session_root sr CROSS JOIN sessions s
                 WHERE s.parent_session_id = sr.id
                   AND s.user_id IS NULL
                   AND sr.prompt_len >= 200
                   AND SUBSTR(COALESCE(s.system_prompt, ''), 1, 200) = sr.prompt_head
            )
            SELECT root_user_id, id, COALESCE(title, '') FROM (
                SELECT
                    sr.root_user_id,
                    s.id,
                    s.title,
                    ROW_NUMBER() OVER (
                        PARTITION BY sr.root_user_id, sr.root_source
                        ORDER BY s.started_at DESC
                    ) AS rn
                FROM session_root sr
                JOIN sessions s ON s.id = sr.id
                WHERE sr.root_source = ?
            )
            WHERE rn = 1
        """
        uri = f"file:{self._state_db_path}?mode=ro"
        try:
            with contextlib.closing(
                sqlite3.connect(uri, uri=True, timeout=2.0)
            ) as conn:
                rows = conn.execute(sql, (PARLEY_SOURCE,)).fetchall()
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
                    sql_fallback, (PARLEY_SOURCE, PARLEY_SOURCE),
                ).fetchall()
        out = [(chat_id, sid, title) for chat_id, sid, title in rows]
        # Refresh the sid → chat_id cache opportunistically.
        self._sid_to_chat_id_cache = {sid: cid for cid, sid, _t in out}
        self._session_rows_cache = (now, out)
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


def _parley_env_enablement() -> Optional[Dict[str, Any]]:
    """Read PARLEY_PLATFORM_TOKEN at startup.

    Returning a non-None dict signals to the platform registry that the
    plugin is enabled for this run. Mirrors the env-var gate the
    pre-migration patch installed in ``_apply_env_overrides``: token
    present → enabled, missing → adapter never instantiates.
    """
    token = env_get("PARLEY_PLATFORM_TOKEN")
    if not token:
        return None
    return {"enabled": True, "token": token}


def register(ctx) -> None:  # noqa: ANN001 — PluginContext type is internal
    """Hermes plugin entry point.

    Two responsibilities:

    1. Platform registration (added 2026-05). Replaces the
       0001-add-parley-platform.patch we used to carry against
       gateway/config.py + gateway/run.py + hermes_cli/platforms.py.
       Upstream's gateway/platform_registry.py now offers a clean
       hook for this.
    2. Tool-event hooks (pre_tool_call / post_tool_call). These dispatch
       to the live ParleyAdapter via a module-level reference set in
       connect(); when no adapter is live the callbacks are silent
       no-ops.
    """
    # hermes ≥ 0.21 validates cron delivery targets before dispatch and only
    # treats a PLUGIN platform as a valid ``deliver=parley:<chat>`` target when
    # its PlatformEntry declares ``cron_deliver_env_var`` (the home-channel env
    # var, PARLEY_HOME_CHANNEL). Without it every cron job delivering to a
    # Parley chat is BLOCKED with "not a known cron delivery target"
    # (2026-09-05: the three Press Radar jobs). Older hermes rejects the
    # unknown kwarg with TypeError, so retry without it there.
    _platform_kwargs = dict(
        name="parley",
        label="Parley",
        adapter_factory=lambda cfg: ParleyAdapter(cfg),
        check_fn=check_parley_requirements,
        required_env=["PARLEY_PLATFORM_TOKEN"],
        install_hint="aiohttp ships with hermes-agent — no extra packages needed",
        env_enablement_fn=_parley_env_enablement,
        allowed_users_env="PARLEY_PLATFORM_ALLOWED_USERS",
        allow_all_env="PARLEY_PLATFORM_ALLOW_ALL_USERS",
        emoji="🎙️",
        pii_safe=False,
        allow_update_command=True,
        platform_hint=(
            "You are chatting via the Parley PWA — a same-browser "
            "interface with full markdown + image rendering. Replies "
            "are streamed token-by-token. The user can also speak to "
            "you via the audio bridge (Deepgram STT → text → reply → "
            "TTS), so when audio is in flight, prefer concise replies."
        ),
    )
    try:
        try:
            ctx.register_platform(cron_deliver_env_var="PARLEY_HOME_CHANNEL", **_platform_kwargs)
        except TypeError as exc:
            if "cron_deliver_env_var" not in str(exc):
                raise
            logger.warning(
                "[parley] this hermes predates PlatformEntry.cron_deliver_env_var — "
                "cron jobs with deliver=parley:<chat> will not validate here"
            )
            ctx.register_platform(**_platform_kwargs)
    except AttributeError:
        # Older hermes-agent without ctx.register_platform — fall back to
        # the patch-driven path (a hardcoded Platform entry + _create_adapter
        # branch). If both are missing, the adapter just won't load and
        # the gateway logs will say so. We don't crash the plugin.
        logger.warning(
            "[parley] ctx.register_platform unavailable on this hermes "
            "version; falling back to patch-driven registration"
        )
    except Exception:
        logger.exception("[parley] register_platform failed")

    # Agent-facing display_doc tool (Docs side panel in the PWA).
    # Registered against hermes' public tools.registry via its own
    # guarded module — a hermes tree without the registry (or a
    # registration failure) must never take the plugin down; the PWA's
    # Docs panel just stays empty. The lambda re-reads _active_adapter
    # per call so adapter restarts don't strand a stale reference.
    try:
        from .parley_doc_tool import register_display_doc_tool
        register_display_doc_tool(lambda: _active_adapter)
    except Exception:
        logger.exception("[parley] display_doc tool wiring failed")

    def _pre(**kwargs: Any) -> None:
        adapter = _active_adapter
        if adapter is None:
            return
        try:
            adapter.on_pre_tool_call(**kwargs)
        except Exception:
            logger.exception("[parley] pre_tool_call hook crashed")

    def _post(**kwargs: Any) -> None:
        adapter = _active_adapter
        if adapter is None:
            return
        try:
            adapter.on_post_tool_call(**kwargs)
        except Exception:
            logger.exception("[parley] post_tool_call hook crashed")

    try:
        ctx.register_hook("pre_tool_call", _pre)
        ctx.register_hook("post_tool_call", _post)
    except Exception:
        logger.exception(
            "[parley] failed to register pre/post_tool_call hooks; "
            "tool-event envelopes will not be emitted"
        )
        return
    logger.debug("[parley] registered pre_tool_call / post_tool_call hooks")
