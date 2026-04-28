"""
HTTP signaling endpoints for the WebRTC voice transport.

Mounted onto the existing api_server aiohttp Application by
:func:`mount_routes`.  No separate port; same authentication policy as
the rest of /v1/.

Routes:

    POST /v1/rtc/offer
        Body: { "sdp": "<offer SDP>", "type": "offer", "mode": "stream"|"talk",
                "session_id": "<optional hermes session id>" }
        Returns: { "peer_id": "...", "sdp": "<answer SDP>", "type": "answer",
                   "mode": "stream"|"talk" }

    POST /v1/rtc/ice
        Body: { "peer_id": "...", "candidate": {sdp..., sdpMid, sdpMLineIndex} }
        Returns: { "ok": true }

    POST /v1/rtc/close
        Body: { "peer_id": "..." }
        Returns: { "ok": true }

    GET  /v1/rtc/health
        Returns: { "ok": true, "peers": <count>, "providers": {...} }

    POST /v1/transcribe
        Body: raw audio bytes; Content-Type indicates the mime
        Returns: { "transcript": "..." }

        Batch transcription path (one-shot voice memos).  Routes through
        the same STTProvider as the streaming WebRTC path so swapping
        provider in voice config affects both.

Trickle ICE: the client may post candidates after the answer is
received.  Empty candidate string ("end of candidates") is a no-op.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

try:
    from aiohttp import web  # type: ignore
    AIOHTTP_AVAILABLE = True
except ImportError:  # pragma: no cover
    web = None  # type: ignore
    AIOHTTP_AVAILABLE = False

from config import VoiceConfig
from peer import (
    AIORTC_AVAILABLE,
    REGISTRY,
    PeerSession,
    create_peer_connection,
    make_peer_id,
    parse_ice_candidate,
)

# Filled in by register_routes(); used by the request handlers.
_VOICE_CONFIG: Optional[VoiceConfig] = None
_API_SERVER_REF: Any = None  # legacy: reference to in-process APIServerAdapter
_PROXY_URL: Optional[str] = None  # sidekick proxy URL, e.g. http://127.0.0.1:3001
                                  # — bridge dispatches to <proxy>/api/<backend>/responses
_BACKEND: str = "hermes"  # active backend slug for the proxy responses endpoint


def _err(message: str, status: int = 400, code: str = "rtc_error") -> "web.Response":
    return web.json_response(
        {"error": {"message": message, "type": code}}, status=status,
    )


async def _read_json(request: "web.Request", max_bytes: int = 64 * 1024) -> Dict[str, Any]:
    """Best-effort JSON parse with a hard size cap."""
    try:
        body = await request.read()
    except Exception as e:
        raise ValueError(f"could not read body: {e}") from e
    if len(body) > max_bytes:
        raise ValueError(f"body too large ({len(body)} > {max_bytes})")
    if not body:
        return {}
    try:
        return json.loads(body)
    except json.JSONDecodeError as e:
        raise ValueError(f"invalid JSON: {e}") from e


async def handle_offer(request: "web.Request") -> "web.Response":
    """POST /v1/rtc/offer — create a new peer connection and return the answer."""
    if not AIORTC_AVAILABLE:
        return _err(
            "aiortc not installed on the server (pip install hermes-agent[webrtc])",
            status=501, code="not_installed",
        )

    try:
        payload = await _read_json(request)
    except ValueError as e:
        return _err(str(e))

    sdp = payload.get("sdp") or ""
    sdp_type = payload.get("type") or "offer"
    mode = (payload.get("mode") or "stream").lower()
    if not sdp or sdp_type != "offer":
        return _err("missing or non-offer sdp")
    if mode not in {"stream", "talk"}:
        return _err(f"invalid mode {mode!r}; expected 'stream' or 'talk'")

    # conv_name is sidekick's stable conversation identifier
    # (sidekick-<slug>), the same key the classic-mode chat path sends.
    # Backwards-compat: an older client using `session_id` is read but
    # treated as conv_name; the bridge passes it through as
    # body["conversation"] when dispatching to /api/<backend>/responses,
    # so voice and text turns chain through one session row.
    conv_name = (
        payload.get("conv_name")
        or payload.get("session_id")
        or ""
    ).strip() or None

    # chat_id is the hermes-gateway path's session-routing primitive,
    # opaque UUID minted PWA-side per conversation (see
    # src/conversations.ts). When present, the bridge dispatches user
    # transcripts to <proxy>/api/sidekick/messages with {chat_id, text}
    # instead of <proxy>/api/<backend>/responses with {input,
    # conversation}. The two routing paths coexist so legacy
    # `backend.type: hermes` deployments keep working unchanged — the
    # PWA only sets chat_id when its active backend is hermes-gateway.
    chat_id = (payload.get("chat_id") or "").strip() or None

    # Build the PeerConnection and accept the offer.
    from aiortc import RTCSessionDescription  # local for lazy import

    pc = create_peer_connection()
    peer_id = make_peer_id()
    peer = PeerSession(peer_id=peer_id, mode=mode, pc=pc)
    peer.extra["conv_name"] = conv_name
    peer.extra["chat_id"] = chat_id
    # Bridge dispatches to <proxy>/api/<be>/responses, NOT directly to the
    # agent backend. The sidekick proxy is the sole gateway between
    # sidekick-land and agent-land. <be> is the active backend slug
    # configured at startup (default 'hermes'). When peer.extra["chat_id"]
    # is set, dispatch routes through /api/sidekick/messages instead.
    peer.extra["proxy_url"] = _PROXY_URL
    peer.extra["backend"] = _BACKEND
    # Per-peer STT vocabulary biasing. The PWA owns the canonical list
    # (per-user IndexedDB) and ships it in the offer payload; we stash
    # it on the peer so stt_bridge._run_stt can clone the configured
    # ProviderSpec with peer-specific options. Empty / missing list →
    # bridge falls back to whatever options were resolved at startup.
    peer_keyterms = payload.get("keyterms") or []
    if isinstance(peer_keyterms, list):
        peer.extra["keyterms"] = [
            str(t).strip() for t in peer_keyterms if isinstance(t, (str, int, float)) and str(t).strip()
        ]
    else:
        peer.extra["keyterms"] = []
    # Log count unconditionally so an empty offer is visible too — the
    # only signal we have for "PWA didn't send anything." Without this,
    # an empty list silently slips through and STT runs un-biased.
    logger.info(
        "[signaling] peer %s offer keyterms=%d %s",
        peer_id, len(peer.extra["keyterms"]),
        f"first={peer.extra['keyterms'][0]!r}" if peer.extra["keyterms"] else "(empty)",
    )

    # Defer to bridge modules to install ontrack / outbound track wiring.
    # The dispatch listener handles inbound DataChannel control messages
    # ({type:'dispatch', text} from the PWA).
    import stt_bridge
    import tts_bridge
    import dispatch_listener

    stt_bridge.attach(peer, voice_config=_VOICE_CONFIG, api_server=_API_SERVER_REF)
    if mode == "talk":
        tts_bridge.attach(peer, voice_config=_VOICE_CONFIG, api_server=_API_SERVER_REF)
    dispatch_listener.attach(peer)

    # Lifecycle logging — useful for postmortems on the bike.
    @pc.on("connectionstatechange")
    async def _on_state_change():  # pragma: no cover — logging hook
        state = pc.connectionState
        logger.info("[peer %s] connection state -> %s", peer_id, state)
        if state in ("failed", "closed"):
            await REGISTRY.evict(peer_id)

    @pc.on("iceconnectionstatechange")
    async def _on_ice_state():  # pragma: no cover
        logger.info("[peer %s] ICE state -> %s", peer_id, pc.iceConnectionState)

    @pc.on("datachannel")
    def _on_datachannel(channel):  # pragma: no cover — wiring hook
        # The browser opens an 'events' channel inside the offer SDP for
        # transcript + reply-delta text events. Stash it on the peer so
        # the STT bridge can push JSON envelopes when transcripts arrive,
        # and bind the dispatch listener so PWA-initiated control
        # messages ({type:'dispatch', text}) reach the bridge.
        peer.data_channel = channel
        logger.info(
            "[peer %s] data channel opened: label=%s id=%s",
            peer_id, channel.label, channel.id,
        )
        dispatch_listener.bind_if_pending(peer, channel)

        @channel.on("close")
        def _on_dc_close():  # pragma: no cover
            logger.info("[peer %s] data channel closed", peer_id)
            if peer.data_channel is channel:
                peer.data_channel = None

    try:
        await pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type=sdp_type))
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
    except Exception as e:
        logger.exception("[peer %s] offer/answer setup failed", peer_id)
        try:
            await pc.close()
        except Exception:
            pass
        return _err(f"setup failed: {e}", status=500, code="rtc_setup_failed")

    # Earlier experiment: munged the answer SDP to add voice-call-style
    # Opus fmtp params (useinbandfec=1, usedtx=0, stereo=0,
    # sprop-stereo=0) + transport-cc rtcp-fb. Hypothesis was that iOS
    # Safari's voiceChat AEC engagement keys on those signals. It did
    # NOT engage AEC (confirmed empirically) AND a TTS garble symptom
    # appeared ~5-6s into agent replies — likely the stereo=0 fmtp
    # contradicting the rtpmap's `/2` channel count, leaving the
    # decoder interpreting frames inconsistently. The bridge-side
    # mic→Deepgram gate (stt_bridge.py is_active() check) now solves
    # the loop deterministically without touching codec negotiation,
    # so the munge is reverted. Keeping the helper in case we want it
    # for some future-proofing experiment.
    munged_sdp = pc.localDescription.sdp

    await REGISTRY.add(peer)

    logger.info(
        "[peer %s] offer accepted, mode=%s conv=%s chat_id=%s",
        peer_id, mode, conv_name or "<none>", chat_id or "<none>",
    )

    return web.json_response({
        "peer_id": peer_id,
        "type": pc.localDescription.type,
        "sdp": munged_sdp,
        "mode": mode,
    })


_OPUS_FMTP_PARAMS = (
    "minptime=10;useinbandfec=1;usedtx=0;stereo=0;sprop-stereo=0"
)


def _add_opus_voice_params(sdp: str) -> str:
    """Inject voice-call-friendly fmtp + rtcp-fb lines for the Opus codec.

    Walks the SDP line-by-line looking for ``a=rtpmap:<pt> opus/48000/...``,
    captures the payload type, and inserts the missing fmtp + feedback
    lines immediately after it. Idempotent: skips insertion if the lines
    are already present for that payload type. Leaves unrelated codecs
    alone.
    """
    import re

    lines = sdp.split("\r\n") if "\r\n" in sdp else sdp.split("\n")
    sep = "\r\n" if "\r\n" in sdp else "\n"

    rtpmap_re = re.compile(r"^a=rtpmap:(\d+)\s+opus/", re.IGNORECASE)
    out: list[str] = []
    seen_pts_with_fmtp: set[str] = set()
    seen_pts_with_transportcc: set[str] = set()
    seen_pts_with_nack: set[str] = set()

    # First pass: note which payload types already have fmtp / rtcp-fb.
    for ln in lines:
        m = re.match(r"^a=fmtp:(\d+)\s+", ln)
        if m:
            seen_pts_with_fmtp.add(m.group(1))
        m = re.match(r"^a=rtcp-fb:(\d+)\s+transport-cc\b", ln)
        if m:
            seen_pts_with_transportcc.add(m.group(1))
        m = re.match(r"^a=rtcp-fb:(\d+)\s+nack\b", ln)
        if m:
            seen_pts_with_nack.add(m.group(1))

    # Second pass: emit lines, inserting voice-call params after each
    # opus rtpmap line that's missing them.
    for ln in lines:
        out.append(ln)
        m = rtpmap_re.match(ln)
        if not m:
            continue
        pt = m.group(1)
        if pt not in seen_pts_with_fmtp:
            out.append(f"a=fmtp:{pt} {_OPUS_FMTP_PARAMS}")
        if pt not in seen_pts_with_transportcc:
            out.append(f"a=rtcp-fb:{pt} transport-cc")
        if pt not in seen_pts_with_nack:
            out.append(f"a=rtcp-fb:{pt} nack")

    return sep.join(out)


async def handle_ice(request: "web.Request") -> "web.Response":
    """POST /v1/rtc/ice — trickle a remote ICE candidate."""
    if not AIORTC_AVAILABLE:
        return _err("aiortc not installed", status=501, code="not_installed")

    try:
        payload = await _read_json(request)
    except ValueError as e:
        return _err(str(e))

    peer_id = (payload.get("peer_id") or "").strip()
    if not peer_id:
        return _err("missing peer_id")

    peer = await REGISTRY.get(peer_id)
    if peer is None or peer.closed:
        return _err("unknown peer", status=404, code="peer_not_found")

    candidate_payload = payload.get("candidate")
    # End-of-candidates sentinel: { "candidate": "" } or { "candidate": null }
    if not candidate_payload or not (candidate_payload or {}).get("candidate"):
        logger.debug("[peer %s] end-of-candidates", peer_id)
        return web.json_response({"ok": True, "end_of_candidates": True})

    cand = parse_ice_candidate(candidate_payload)
    if cand is None:
        return _err("could not parse ICE candidate")

    try:
        await peer.pc.addIceCandidate(cand)
    except Exception as e:
        logger.warning("[peer %s] addIceCandidate failed: %s", peer_id, e)
        return _err(f"addIceCandidate failed: {e}", status=500, code="ice_failed")

    return web.json_response({"ok": True})


async def handle_close(request: "web.Request") -> "web.Response":
    """POST /v1/rtc/close — explicitly tear down a peer connection."""
    try:
        payload = await _read_json(request)
    except ValueError as e:
        return _err(str(e))

    peer_id = (payload.get("peer_id") or "").strip()
    if not peer_id:
        return _err("missing peer_id")

    evicted = await REGISTRY.evict(peer_id)
    if evicted:
        logger.info("[peer %s] closed by client", peer_id)
    return web.json_response({"ok": True, "closed": evicted})


async def handle_transcribe(request: "web.Request") -> "web.Response":
    """POST /v1/transcribe — batch-transcribe a blob via the configured STT provider.

    Body is the raw audio (the sidekick proxy forwards what the browser
    POSTs to /transcribe verbatim — no multipart wrapping).  Content-Type
    must indicate the mime so providers can decode appropriately; we
    default to ``audio/webm`` to match what the PWA records.

    Per-request keyterms: the PWA may send `?keyterms=foo&keyterms=bar`
    (or repeated `keyterms` form values) in the query string. We merge
    them into the configured provider spec the same way the streaming
    path merges `peer.extra["keyterms"]` in `stt_bridge._run_stt`, so
    memos and dictate-batch get the same vocabulary biasing as call mode.
    Empty / missing list → falls back to the configured base spec.

    On NotImplementedError (placeholder providers like local_whisper)
    we return 501 so callers can surface a clear "this provider doesn't
    support batch yet" message.
    """
    if _VOICE_CONFIG is None:
        return _err("not initialized", status=503, code="not_ready")

    mime = request.headers.get("Content-Type", "audio/webm")
    try:
        audio = await request.read()
    except Exception as e:
        return _err(f"could not read body: {e}", status=400)

    if not audio:
        return _err("empty body", status=400, code="empty_body")

    # Per-request keyterm biasing — accepts repeated `?keyterms=…&keyterms=…`
    # so the PWA can ship the same IDB list it sends with the WebRTC offer
    # without re-encoding into a single param. Stripped + dedup'd
    # case-insensitive to match signaling.handle_offer's normalization.
    req_keyterms_raw = request.query.getall("keyterms", [])
    seen_kt: set[str] = set()
    req_keyterms: list[str] = []
    for t in req_keyterms_raw:
        s = str(t).strip()
        if s and s.lower() not in seen_kt:
            seen_kt.add(s.lower())
            req_keyterms.append(s)

    # Lazy import so a config without webrtc deps still serves /v1/rtc/health.
    # Importing the package (not just the module) triggers self-registration
    # of the bundled deepgram adapter via providers/__init__.py.
    from providers import get_stt_provider

    base_spec = _VOICE_CONFIG.stt
    if req_keyterms:
        from dataclasses import replace
        merged_options = dict(base_spec.options)
        existing_lc = {str(t).strip().lower() for t in merged_options.get("keyterms", []) or []}
        existing = list(merged_options.get("keyterms", []) or [])
        for t in req_keyterms:
            if t.lower() not in existing_lc:
                existing.append(t)
                existing_lc.add(t.lower())
        merged_options["keyterms"] = existing
        spec = replace(base_spec, options=merged_options)
        logger.info(
            "[transcribe] keyterms=%d (req=%d, base=%d)",
            len(existing), len(req_keyterms),
            len(base_spec.options.get("keyterms", []) or []),
        )
    else:
        spec = base_spec

    try:
        provider = get_stt_provider(spec)
    except KeyError as e:
        return _err(str(e), status=500, code="unknown_provider")

    try:
        text = await provider.transcribe(audio, mime)
    except NotImplementedError as e:
        return web.json_response(
            {"error": f"provider does not support batch: {e}"},
            status=501,
        )
    except Exception as e:
        logger.exception("[transcribe] failed")
        return _err(str(e), status=500, code="transcribe_failed")
    finally:
        try:
            await provider.aclose()
        except Exception:  # pragma: no cover
            pass

    return web.json_response({"transcript": text or ""})


async def handle_health(request: "web.Request") -> "web.Response":
    """GET /v1/rtc/health — diagnostic endpoint."""
    if not AIORTC_AVAILABLE:
        return web.json_response({
            "ok": False, "reason": "aiortc not installed",
        }, status=501)
    if _VOICE_CONFIG is None:
        return web.json_response({"ok": False, "reason": "not initialized"}, status=503)
    # Don't grab the lock here; the count is informational.
    peer_count = len(REGISTRY._peers)  # noqa: SLF001 — info only
    return web.json_response({
        "ok": True,
        "peers": peer_count,
        "providers": {
            "stt": _VOICE_CONFIG.stt.provider,
            "tts": _VOICE_CONFIG.tts.provider,
        },
    })


def register_routes(
    app: "web.Application",
    *,
    voice_config: Optional[VoiceConfig] = None,
    proxy_url: Optional[str] = None,
    backend: str = "hermes",
    api_server: Any = None,
) -> None:
    """Register the /v1/rtc/* routes onto an aiohttp Application.

    *proxy_url* is the sidekick proxy base URL (e.g. http://127.0.0.1:3001).
    The bridge dispatches utterances to ``<proxy_url>/api/<backend>/responses``
    rather than POSTing directly to the agent backend. Routing through the
    proxy keeps the proxy as the sole sidekick→agent gateway and lets
    bridge implementations (aiortc / node-webrtc / future) stay agent-agnostic.

    *backend* is the active backend slug whose responses endpoint the
    proxy routes (default ``hermes``). Override per deployment so the
    bridge can target whichever agent backend the proxy is wired to.

    *api_server* is the legacy in-process APIServerAdapter reference, kept
    for backwards compatibility while embedded bridges existed.
    Standalone callers should leave it None and pass *proxy_url* instead.
    """
    if not AIOHTTP_AVAILABLE:
        logger.error("[webrtc-signaling] aiohttp missing; skipping route mount")
        return

    if voice_config is None:
        # Bridge invocation path: load defaults so the routes can answer.
        voice_config = VoiceConfig.defaults()

    if not voice_config.enabled:
        logger.info("[webrtc-signaling] disabled in config; skipping route mount")
        return

    if not AIORTC_AVAILABLE:
        # We still mount the routes so clients get a 501 instead of 404
        # — the error surface is more discoverable.
        logger.warning(
            "[webrtc-signaling] aiortc not installed; routes will return 501",
        )

    global _VOICE_CONFIG, _API_SERVER_REF, _PROXY_URL, _BACKEND
    _VOICE_CONFIG = voice_config
    _API_SERVER_REF = api_server
    _PROXY_URL = proxy_url
    _BACKEND = backend

    app.router.add_post("/v1/rtc/offer", handle_offer)
    app.router.add_post("/v1/rtc/ice", handle_ice)
    app.router.add_post("/v1/rtc/close", handle_close)
    app.router.add_get("/v1/rtc/health", handle_health)
    # Batch transcription — same STT provider as the streaming path,
    # so swapping providers in voice config affects live + memo together.
    app.router.add_post("/v1/transcribe", handle_transcribe)

    # Defer the registry sweep loop until the event loop is running.
    # When mounted in-process by an existing aiohttp app (the legacy
    # hermes path), the loop is already alive and start_sweep is safe
    # to call directly; for the standalone bridge the app's on_startup
    # hook runs after the loop is up.
    async def _start_sweep(_app: "web.Application") -> None:  # pragma: no cover
        REGISTRY.start_sweep()
    app.on_startup.append(_start_sweep)

    logger.info(
        "[webrtc-signaling] mounted /v1/rtc/{offer,ice,close,health} + /v1/transcribe "
        "(stt=%s, tts=%s, proxy=%s)",
        voice_config.stt.provider, voice_config.tts.provider, proxy_url or "<none>",
    )


# Backwards-compatible alias for older callers (api_server.py used this name).
mount_routes = register_routes


__all__ = [
    "register_routes",
    "mount_routes",
    "handle_offer",
    "handle_ice",
    "handle_close",
    "handle_health",
    "handle_transcribe",
]
