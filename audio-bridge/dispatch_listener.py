"""
Data-channel inbound listener: PWA → bridge control messages.

The PWA sends JSON envelopes over the same RTCDataChannel used for
outbound transcripts.  Schema:

    {type: 'dispatch', text: '<utterance to send to the agent>'}

        Bridge calls stt_bridge.dispatch_to_agent(peer, text).  The bridge
        POSTs to the sidekick proxy and streams the reply back as
        assistant transcript envelopes.

    {type: 'interrupt'}

        Reserved for future barge-in support.  V1 logs and ignores.

Signaling.handle_offer wires this listener via attach(peer) right after
the data channel is opened by the browser.
"""

from __future__ import annotations

import json
import logging

import stt_bridge

logger = logging.getLogger(__name__)


def attach(peer) -> None:
    """Register an on-message handler on the peer's data channel.

    Idempotent against repeated calls — only the first attach binds.
    Safe to call before the channel has been opened by the remote peer;
    aiortc's ondatachannel hook in signaling.py defers the binding until
    the channel object exists.
    """
    if peer.extra.get("dispatch_listener_attached"):
        return
    peer.extra["dispatch_listener_attached"] = True

    def _bind(channel) -> None:
        @channel.on("message")
        def _on_message(raw):  # pragma: no cover — wiring hook
            _handle_inbound(peer, raw)

    # Either the data channel already exists (signaling.handle_offer
    # may have stashed it before this attach was called) or we wait
    # for the ondatachannel hook to fire.
    dc = peer.data_channel
    if dc is not None:
        _bind(dc)
        return

    peer.extra["dispatch_listener_pending_bind"] = _bind


def bind_if_pending(peer, channel) -> None:
    """Hook called from signaling's ondatachannel handler.

    If attach() was called before the data channel existed, the bind
    closure is stashed under peer.extra; flush it now.
    """
    pending = peer.extra.pop("dispatch_listener_pending_bind", None)
    if pending is None:
        return
    pending(channel)


def _handle_inbound(peer, raw) -> None:
    """Parse one inbound DataChannel message from the PWA."""
    if isinstance(raw, (bytes, bytearray)):
        try:
            raw = raw.decode("utf-8", errors="replace")
        except Exception:
            logger.debug("[dispatch-listener] peer %s non-utf8 binary message", peer.peer_id)
            return
    if not isinstance(raw, str):
        return
    try:
        payload = json.loads(raw)
    except (ValueError, TypeError):
        logger.debug("[dispatch-listener] peer %s bad json: %r", peer.peer_id, raw[:80])
        return
    if not isinstance(payload, dict):
        return

    msg_type = payload.get("type")
    if msg_type == "dispatch":
        text = (payload.get("text") or "").strip()
        if not text:
            logger.debug("[dispatch-listener] peer %s empty dispatch ignored", peer.peer_id)
            return
        logger.info(
            "[dispatch-listener] peer %s dispatch: %s",
            peer.peer_id,
            text[:120] + ("..." if len(text) > 120 else ""),
        )
        # Schedule but don't await — the listener must return promptly
        # so further data-channel messages can be processed.
        import asyncio
        asyncio.create_task(
            stt_bridge.dispatch_to_agent(peer, text),
            name=f"dispatch-listener-{peer.peer_id[:8]}",
        )
    elif msg_type == "interrupt":
        # Reserved for future barge-in support.
        logger.info("[dispatch-listener] peer %s interrupt (ignored in V1)", peer.peer_id)
    else:
        logger.debug("[dispatch-listener] peer %s unknown type %r", peer.peer_id, msg_type)


__all__ = ["attach", "bind_if_pending"]
