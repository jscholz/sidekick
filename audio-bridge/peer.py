"""
Single-peer aiortc wrapper.

Lifecycle:

    PeerConnection             — created in :meth:`PeerSession.handle_offer`
    .ontrack                    — once the inbound audio track lands, the
                                  STT bridge is started against it.
    addTrack(outbound)          — for ``mode='talk'``, an outbound TTS
                                  track is added before answering.
    setLocalDescription(answer) — answer SDP returned to the client.
    .iceCandidate (trickle)     — added incrementally via add_ice_candidate.
    teardown                    — cancel bridges, close PeerConnection.

Concurrency model: one ``PeerSession`` instance per peer; the
``PeerRegistry`` indexes them by an opaque server-issued peer_id.  The
registry caps concurrent peers (single-user app, but a leaked phone
session shouldn't be able to fill the table forever).

Why a registry, not a single global peer: even though we expect one
phone at a time, swapping branches / reconnecting / phone-killing-pwa
all leave a stale peer hanging while a fresh one comes in.  Keying
sessions lets us garbage-collect old peers explicitly when their
keep-alive expires or when a new offer arrives with the same
``X-Sidekick-Replace-Peer`` header.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Dict, Optional

logger = logging.getLogger(__name__)

# Lazy aiortc import — let the rest of the gateway boot without optional
# deps.  All callers that touch peer.py will fail with a clear error.
try:
    from aiortc import (  # type: ignore
        RTCConfiguration,
        RTCDataChannel,
        RTCIceCandidate,
        RTCPeerConnection,
        RTCSessionDescription,
    )
    from aiortc.sdp import candidate_from_sdp  # type: ignore

    AIORTC_AVAILABLE = True
except ImportError:  # pragma: no cover
    RTCPeerConnection = None  # type: ignore
    RTCSessionDescription = None  # type: ignore
    RTCIceCandidate = None  # type: ignore
    RTCDataChannel = None  # type: ignore
    RTCConfiguration = None  # type: ignore
    candidate_from_sdp = None  # type: ignore
    AIORTC_AVAILABLE = False


PEER_TTL_SECONDS = 600  # GC peers idle for 10 min
MAX_CONCURRENT_PEERS = 4  # Cap to keep memory bounded if signalling misbehaves


@dataclass
class PeerSession:
    """One active WebRTC peer (PeerConnection + bridges + bookkeeping)."""

    peer_id: str
    mode: str  # 'stream' | 'talk'
    pc: "RTCPeerConnection" = field(repr=False)
    created_at: float = field(default_factory=time.time)
    last_active: float = field(default_factory=time.time)
    # Bridge tasks are populated by the bridges themselves (avoids a
    # circular import — peer.py doesn't import stt_bridge / tts_bridge).
    stt_task: Optional[asyncio.Task] = None
    tts_task: Optional[asyncio.Task] = None
    # Registry hooks for the bridges to push events through.
    on_transcript: Optional[Callable[[str, bool], Awaitable[None]]] = None
    # Client-initiated data channel ('events') for transcript + reply
    # text, populated by signaling's ondatachannel handler when the
    # browser PC offer carries one.  None until the client opens it.
    data_channel: Optional["RTCDataChannel"] = None
    closed: bool = False
    # Misc per-session state — bridges stash intermediate handles here
    # (Deepgram WS, outbound MediaStreamTrack, etc) without polluting
    # the dataclass schema.
    extra: Dict[str, object] = field(default_factory=dict)

    def touch(self) -> None:
        self.last_active = time.time()

    async def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        for task_attr in ("stt_task", "tts_task"):
            t: Optional[asyncio.Task] = getattr(self, task_attr)
            if t and not t.done():
                t.cancel()
                try:
                    await t
                except (asyncio.CancelledError, Exception):
                    pass
        try:
            await self.pc.close()
        except Exception as e:  # pragma: no cover
            logger.warning("[peer %s] pc.close raised: %s", self.peer_id, e)


class PeerRegistry:
    """Process-wide registry of active PeerSession objects."""

    def __init__(self, max_peers: int = MAX_CONCURRENT_PEERS) -> None:
        self._peers: Dict[str, PeerSession] = {}
        self._max = max_peers
        self._lock = asyncio.Lock()
        self._sweep_task: Optional[asyncio.Task] = None

    def start_sweep(self) -> None:
        """Begin background TTL sweeping.  Idempotent."""
        if self._sweep_task is None or self._sweep_task.done():
            self._sweep_task = asyncio.create_task(
                self._sweep_loop(), name="webrtc-peer-sweep",
            )

    async def stop(self) -> None:
        if self._sweep_task and not self._sweep_task.done():
            self._sweep_task.cancel()
            try:
                await self._sweep_task
            except (asyncio.CancelledError, Exception):
                pass
        async with self._lock:
            peers = list(self._peers.values())
            self._peers.clear()
        for p in peers:
            await p.close()

    async def _sweep_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(60)
                await self._sweep_once()
        except asyncio.CancelledError:
            return

    async def _sweep_once(self) -> None:
        now = time.time()
        async with self._lock:
            stale = [
                pid for pid, p in self._peers.items()
                if now - p.last_active > PEER_TTL_SECONDS
            ]
        for pid in stale:
            logger.info("[peer-registry] sweeping idle peer %s", pid)
            await self.evict(pid)

    async def add(self, peer: PeerSession) -> None:
        async with self._lock:
            # Cap concurrent peers; oldest-first eviction.
            if len(self._peers) >= self._max:
                oldest_pid = min(
                    self._peers, key=lambda k: self._peers[k].last_active,
                )
                logger.info("[peer-registry] cap reached, evicting %s", oldest_pid)
                old = self._peers.pop(oldest_pid)
                # Don't await close inside the lock; schedule it.
                asyncio.create_task(old.close())
            self._peers[peer.peer_id] = peer

    async def get(self, peer_id: str) -> Optional[PeerSession]:
        async with self._lock:
            p = self._peers.get(peer_id)
        if p is not None:
            p.touch()
        return p

    async def evict(self, peer_id: str) -> bool:
        async with self._lock:
            p = self._peers.pop(peer_id, None)
        if p is None:
            return False
        await p.close()
        return True


def make_peer_id() -> str:
    return uuid.uuid4().hex


def create_peer_connection() -> "RTCPeerConnection":
    """Build a fresh aiortc PeerConnection with our standard config.

    Tailscale-only deployment: we don't configure STUN/TURN servers; host
    candidates between the phone and the Pi are sufficient on the
    tailnet.  Override here later if we add an off-tailnet TURN.
    """
    if not AIORTC_AVAILABLE:
        raise RuntimeError(
            "aiortc not installed; pip install hermes-agent[webrtc]"
        )
    config = RTCConfiguration(iceServers=[])
    return RTCPeerConnection(configuration=config)


def parse_ice_candidate(payload: dict) -> Optional["RTCIceCandidate"]:
    """Convert a JSON ICE candidate dict from the client into an RTCIceCandidate.

    The browser's ``RTCPeerConnection.onicecandidate`` event yields
    ``RTCIceCandidate`` objects whose ``.toJSON()`` produces::

        {
            "candidate": "candidate:1 1 UDP 2122252543 …",
            "sdpMid": "0",
            "sdpMLineIndex": 0,
        }

    aiortc's ``candidate_from_sdp`` parses the ``candidate:...`` SDP line
    only; we attach ``sdpMid`` and ``sdpMLineIndex`` afterwards.

    Returns None for end-of-candidates (the empty-candidate sentinel).
    """
    if not AIORTC_AVAILABLE:
        raise RuntimeError("aiortc not installed; pip install hermes-agent[webrtc]")
    cand_str = (payload or {}).get("candidate") or ""
    if not cand_str:
        return None
    # Strip the leading "candidate:" prefix that aiortc's parser doesn't want.
    if cand_str.startswith("candidate:"):
        cand_str = cand_str[len("candidate:") :]
    try:
        candidate = candidate_from_sdp(cand_str)
    except Exception as e:
        logger.warning("[peer] failed to parse ICE candidate %r: %s", payload, e)
        return None
    candidate.sdpMid = payload.get("sdpMid")
    sdpm = payload.get("sdpMLineIndex")
    if sdpm is not None:
        try:
            candidate.sdpMLineIndex = int(sdpm)
        except (TypeError, ValueError):
            pass
    return candidate


# Module-level registry so signaling.py and the bridges share a single
# instance.  The api_server adapter is the entry-point that calls
# .start_sweep() once during startup.
REGISTRY = PeerRegistry()


__all__ = [
    "AIORTC_AVAILABLE",
    "PEER_TTL_SECONDS",
    "MAX_CONCURRENT_PEERS",
    "PeerSession",
    "PeerRegistry",
    "REGISTRY",
    "create_peer_connection",
    "make_peer_id",
    "parse_ice_candidate",
]
