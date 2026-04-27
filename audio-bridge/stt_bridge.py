"""
STT bridge: incoming RTC audio track -> 16 kHz mono int16 PCM -> STTProvider
-> data-channel transcript envelopes.

Per peer:

    pc.ontrack(track)
        |
        +- async pump task
            - frame = await track.recv()           # 48 kHz Opus-decoded
            - resampled = resampler(frame)         # 16 kHz mono int16
            - put(pcm_bytes) onto pcm_queue
        |
        +- async stt task
            - get pcm_bytes off pcm_queue
            - feed STTProvider.stream(pcm_iter)
            - on every Transcript:
                send {type: 'transcript', role: 'user', text, is_final}
                over the peer's data channel.  Pass-through only — no
                buffering, no commit-phrase, no silence timer.  The PWA
                owns all UX logic (utterance buffer, silence timeout,
                commit-phrase, dispatch decision).

Dispatch path:

    The PWA decides when to send an utterance to the agent and posts a
    {type: 'dispatch', text} envelope back over the data channel.  The
    bridge's dispatch_listener (in dispatch_listener.py) handles those
    messages and calls _dispatch_to_agent() here, which POSTs to
    ``<proxy_url>/api/hermes/responses`` and streams the SSE reply
    back over the data channel as assistant transcript envelopes.

    Bridge → proxy → agent: the bridge does NOT POST directly to the
    agent backend.  The sidekick proxy is the sole sidekick→agent
    gateway.  proxy_url is stashed on the PeerSession at offer time.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, AsyncIterator, Optional

from config import VoiceConfig
from providers import Transcript, get_stt_provider

logger = logging.getLogger(__name__)

# Target sample rate / format for STT providers (Deepgram nova-3 prefers
# 16 kHz mono int16, plus the local_whisper stub will too).  If a provider
# wants something else, add a per-provider format hint to ProviderSpec
# and resample again — keep this bridge ignorant of provider details.
TARGET_SAMPLE_RATE = 16000
TARGET_LAYOUT = "mono"
TARGET_FORMAT = "s16"

# Cap the audio queue so a slow STT upstream doesn't grow memory
# unboundedly.  20 ms frames * 100 = ~2 s of buffer.
MAX_PCM_QUEUE = 100


def attach(peer, *, voice_config: VoiceConfig, api_server: Any = None) -> None:
    """Wire the inbound audio track of *peer* into the configured STT provider.

    Idempotent: if attach() is called twice on the same peer, only the
    first ontrack handler dispatches.  (We rely on aiortc invoking each
    handler exactly once per inbound track; a defensive guard is in the
    handler itself.)
    """
    pc = peer.pc

    @pc.on("track")
    async def _on_track(track):
        if track.kind != "audio":
            logger.debug(
                "[stt-bridge] peer %s ignoring %s track", peer.peer_id, track.kind,
            )
            return
        if peer.extra.get("stt_attached"):
            logger.debug(
                "[stt-bridge] peer %s additional audio track ignored", peer.peer_id,
            )
            return
        peer.extra["stt_attached"] = True

        logger.info(
            "[stt-bridge] peer %s audio track received; starting STT pump",
            peer.peer_id,
        )
        # Two cooperating tasks: the audio pump and the STT consumer.
        pcm_q: "asyncio.Queue[Optional[bytes]]" = asyncio.Queue(maxsize=MAX_PCM_QUEUE)

        pump_task = asyncio.create_task(
            _pump_audio(track, pcm_q, peer.peer_id),
            name=f"webrtc-pump-{peer.peer_id[:8]}",
        )
        stt_task = asyncio.create_task(
            _run_stt(peer, voice_config, pcm_q, pump_task),
            name=f"webrtc-stt-{peer.peer_id[:8]}",
        )
        peer.stt_task = stt_task
        peer.extra["pump_task"] = pump_task


async def _pump_audio(track, pcm_q: "asyncio.Queue[Optional[bytes]]", peer_id: str) -> None:
    """Receive Opus-decoded frames from the inbound track, resample to 16 kHz mono int16, push to the queue."""
    try:
        from av.audio.resampler import AudioResampler  # type: ignore
    except ImportError as exc:  # pragma: no cover
        logger.error("[stt-bridge] PyAV missing: %s", exc)
        await pcm_q.put(None)
        return

    resampler = AudioResampler(
        format=TARGET_FORMAT, layout=TARGET_LAYOUT, rate=TARGET_SAMPLE_RATE,
    )
    frames_seen = 0
    bytes_pushed = 0
    started = time.time()
    try:
        while True:
            frame = await track.recv()
            frames_seen += 1
            for resampled in resampler.resample(frame):
                # av AudioFrame.to_ndarray() => int16 array shaped (channels, samples)
                pcm = resampled.to_ndarray().tobytes()
                if not pcm:
                    continue
                bytes_pushed += len(pcm)
                # If the queue is full, drop frames rather than blocking
                # the audio pump (which would also block aiortc).  In
                # practice the consumer should keep up; this guard is
                # for the case where Deepgram's WS is unreachable.
                try:
                    pcm_q.put_nowait(pcm)
                except asyncio.QueueFull:
                    logger.warning(
                        "[stt-bridge] peer %s pcm queue full; dropping frame",
                        peer_id,
                    )
            if frames_seen in (1, 50, 250):
                elapsed = time.time() - started
                logger.info(
                    "[stt-bridge] peer %s frames=%d bytes=%d elapsed=%.1fs",
                    peer_id, frames_seen, bytes_pushed, elapsed,
                )
    except asyncio.CancelledError:
        raise
    except Exception as e:
        # MediaStreamError on track end is normal; aiortc raises it when
        # the remote half-closes.  Log debug, not warning.
        logger.debug("[stt-bridge] peer %s pump exit: %s", peer_id, e)
    finally:
        # Sentinel so the consumer can exit.
        try:
            pcm_q.put_nowait(None)
        except asyncio.QueueFull:
            pass


async def _run_stt(
    peer,
    voice_config: VoiceConfig,
    pcm_q: "asyncio.Queue[Optional[bytes]]",
    pump_task: asyncio.Task,
) -> None:
    """Consume the PCM queue, drive the STT provider, forward transcripts to the data channel."""
    stt = get_stt_provider(voice_config.stt)

    # Frame of pure silence at the same shape the mic produces (16 kHz
    # mono int16, 20 ms = 640 bytes). Substituted for the real mic
    # frame whenever TTS is currently playing on this peer's outbound
    # track, so Deepgram sees clean silence instead of the speakerphone
    # echo of our own TTS — kills the iOS Safari feedback loop without
    # disconnecting the WSS or starving Deepgram of paced audio.
    silence_frame = bytes(640)

    async def _pcm_iter() -> AsyncIterator[bytes]:
        tts_track = peer.extra.get("tts_track")
        was_active = False
        while True:
            chunk = await pcm_q.get()
            if chunk is None:
                return
            if tts_track is not None and tts_track.is_active():
                if not was_active:
                    logger.info(
                        "[stt-bridge] peer %s: gating mic→Deepgram (TTS active)",
                        peer.peer_id,
                    )
                    was_active = True
                yield silence_frame
                continue
            if was_active:
                logger.info(
                    "[stt-bridge] peer %s: resuming mic→Deepgram (TTS done)",
                    peer.peer_id,
                )
                was_active = False
            yield chunk

    try:
        async for tx in stt.stream(_pcm_iter()):
            await _handle_transcript(peer, tx)
    except asyncio.CancelledError:
        raise
    except Exception as e:
        logger.exception("[stt-bridge] peer %s STT error: %s", peer.peer_id, e)
    finally:
        try:
            await stt.aclose()
        except Exception:  # pragma: no cover
            pass
        if not pump_task.done():
            pump_task.cancel()
            try:
                await pump_task
            except (asyncio.CancelledError, Exception):
                pass


def _send_data_channel(peer, payload: dict) -> None:
    """Best-effort send of a JSON envelope over the peer's data channel.

    A closed / not-yet-opened channel silently no-ops — the channel is a
    parallel telemetry path; the agent run continues regardless.
    """
    dc = peer.data_channel
    if dc is None:
        return
    try:
        # aiortc tracks ready-state; sending while not 'open' raises.
        if getattr(dc, "readyState", "open") != "open":
            return
        import json as _json
        dc.send(_json.dumps(payload, ensure_ascii=False))
    except Exception as e:  # pragma: no cover
        logger.debug(
            "[stt-bridge] peer %s data-channel send failed: %s",
            peer.peer_id, e,
        )


async def _handle_transcript(peer, tx: Transcript) -> None:
    """Forward an interim or final transcript to the data channel.

    Pass-through behavior: every non-empty transcript (interim + final)
    goes out as a {type:'transcript', role:'user'} envelope. The bridge
    does NOT buffer, gate on commit-phrase, or run a silence timer —
    those decisions belong to the PWA, which owns the dispatch trigger.

    Empty finals (Deepgram's UtteranceEnd marker) are skipped — they're
    internal sync points, not user-visible text.
    """
    if peer.on_transcript is not None:
        try:
            await peer.on_transcript(tx.text, tx.is_final)
        except Exception as e:  # pragma: no cover
            logger.warning("[stt-bridge] peer %s on_transcript hook raised: %s", peer.peer_id, e)

    if not tx.text:
        return

    _send_data_channel(peer, {
        "type": "transcript",
        "text": tx.text,
        "is_final": tx.is_final,
        "role": "user",
    })


async def dispatch_to_agent(peer, utterance: str) -> None:
    """Public dispatch entry point invoked by the PWA-driven dispatch listener.

    POSTs *utterance* to the sidekick proxy and streams the agent's
    reply back over the data channel as assistant transcript envelopes.
    """
    asyncio.create_task(
        _dispatch_to_agent(peer, utterance),
        name=f"webrtc-agent-{peer.peer_id[:8]}",
    )


async def _dispatch_to_agent(peer, utterance: str) -> None:
    """Run an agent turn for *utterance* and route the streaming reply.

    Wire shape: POST <proxy_url>/api/hermes/responses with the OpenAI
    Responses API body (input + conversation + stream).  The proxy
    forwards to the agent's /v1/responses, returns the SSE stream as-is.
    The bridge parses the Responses API event format
    (response.output_text.delta + response.completed) and mirrors text
    deltas onto the data channel.

    Two sinks for the reply tokens:

    1. The peer's TTS bridge (talk mode) — registers a queue under
       peer.extra["tts_text_queue"]; we push text deltas into it.

    2. The data channel — the PWA renders the assistant bubble from
       these envelopes.  A terminal {role:'assistant', is_final:true}
       fires after the SSE stream completes so the PWA can drop the
       streaming-cursor on the bubble.
    """
    proxy_url = (peer.extra.get("proxy_url") or "http://127.0.0.1:3001").rstrip("/")
    url = f"{proxy_url}/api/hermes/responses"

    conv_name = peer.extra.get("conv_name")
    body = {
        "input": utterance,
        "stream": True,
    }
    if conv_name:
        body["conversation"] = conv_name

    headers = {"Content-Type": "application/json"}

    try:
        import aiohttp  # type: ignore
    except ImportError:  # pragma: no cover
        logger.error("[stt-bridge] aiohttp missing for agent dispatch")
        return

    logger.debug("[stt-bridge] peer %s dispatching to %s", peer.peer_id, url)

    text_queue: Optional[asyncio.Queue] = peer.extra.get("tts_text_queue")

    # Responses API SSE events arrive as `event: <name>\ndata: <json>\n\n`
    # frames.  We track the current event name across lines so the
    # data: payload can be interpreted in context.  See hermes-agent
    # gateway/platforms/api_server.py:_handle_responses for the writer.
    current_event: Optional[str] = None

    async with aiohttp.ClientSession() as sess:
        try:
            async with sess.post(url, json=body, headers=headers) as resp:
                if resp.status != 200:
                    err = (await resp.text())[:200]
                    logger.warning(
                        "[stt-bridge] peer %s agent dispatch %d: %s",
                        peer.peer_id, resp.status, err,
                    )
                    return
                async for raw in resp.content:
                    line = raw.rstrip(b"\r\n")
                    if not line:
                        # Blank line marks end of an SSE frame; reset event.
                        current_event = None
                        continue
                    if line.startswith(b":"):
                        continue  # comment
                    if line.startswith(b"event:"):
                        current_event = line[len(b"event:"):].strip().decode(
                            "utf-8", errors="replace",
                        )
                        continue
                    if not line.startswith(b"data:"):
                        continue
                    data = line[len(b"data:"):].strip()
                    if not data:
                        continue
                    try:
                        import json as _json
                        chunk = _json.loads(data)
                    except (ValueError, TypeError):
                        continue
                    # Honor an explicit type field on the payload when
                    # the event header was missing (some SSE writers omit
                    # the `event:` line and rely on payload.type).
                    event_name = current_event or chunk.get("type")
                    if event_name == "response.output_text.delta":
                        delta = chunk.get("delta") or ""
                        if not delta:
                            continue
                        if text_queue is not None:
                            try:
                                text_queue.put_nowait(delta)
                            except asyncio.QueueFull:
                                pass
                        if peer.on_transcript is not None:
                            try:
                                await peer.on_transcript(delta, False)
                            except Exception:  # pragma: no cover
                                pass
                        _send_data_channel(peer, {
                            "type": "transcript",
                            "text": delta,
                            "is_final": False,
                            "role": "assistant",
                        })
                    elif event_name == "response.completed":
                        # Terminal event; loop will exit on next iter.
                        break
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.warning("[stt-bridge] peer %s agent dispatch error: %s", peer.peer_id, e)
        finally:
            # Tell the TTS bridge to flush any tail buffer.
            if text_queue is not None:
                try:
                    text_queue.put_nowait(None)
                except asyncio.QueueFull:
                    pass
            # Signal end-of-reply on the data channel so the PWA can drop
            # the streaming-cursor on the assistant bubble.
            _send_data_channel(peer, {
                "type": "transcript",
                "text": "",
                "is_final": True,
                "role": "assistant",
            })


__all__ = ["attach", "dispatch_to_agent"]
