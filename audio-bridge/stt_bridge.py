"""
STT bridge: incoming RTC audio track -> 16 kHz mono int16 PCM -> STTProvider
-> agent input.

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
            - on Transcript.is_final + non-empty text:
                dispatch(text) -> agent (api_server adapter or raw call)
            - on Transcript (interim): forward to peer.on_transcript
              callback if registered (so the client can render live caps).

Agent dispatch path:

    The cleanest hook in the existing code is APIServerAdapter._run_agent
    (which both /v1/chat/completions and /v1/responses go through).
    We grab the api_server reference passed to attach() and call
    _run_agent in a background task, plumbing the streaming callback
    through to the TTS bridge (if attached) and to the peer's
    on_transcript hook (so the client gets the assistant text as it
    streams).

    Session continuity: if the offer payload included session_id, we
    pass it through so multi-turn voice conversations chain.  Otherwise
    each utterance is a fresh session — adequate for the bike-ride
    smoke-test.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import Any, AsyncIterator, List, Optional

from config import VoiceConfig
from providers import Transcript, get_stt_provider

logger = logging.getLogger(__name__)

# Threshold at which Deepgram's native utterance_end_ms tops out.  Above
# this, the bridge wraps the silence detection with a manual asyncio
# timer that flushes the buffered utterance if no new is_final arrives
# within the configured window.
_DG_NATIVE_SILENCE_CAP_SEC = 5.0


def _make_commit_regex(phrase: str) -> Optional[re.Pattern]:
    """Build the commit-phrase matcher.  Returns None for empty/disabled.

    Mirrors the JS regex in voice.ts:

        /^(.*)\s*\b<escaped>\b[\s.,!?]*$/i

    A non-empty match yields the prefix-text (without the phrase) so the
    bridge can flush the cleaned utterance to the agent.
    """
    if not phrase:
        return None
    escaped = re.escape(phrase)
    return re.compile(
        rf"^(.*)\s*\b{escaped}\b[\s.,!?]*$",
        re.IGNORECASE,
    )


def _check_commit_phrase(
    pattern: Optional[re.Pattern],
    transcript: str,
) -> Optional[str]:
    """Run the commit-phrase regex against *transcript*.

    Returns the stripped prefix (with surrounding whitespace trimmed)
    when the phrase matches; None otherwise.  Empty stripped text still
    counts as a match — the user said the commit word with nothing
    before it, intent is "send whatever's already buffered".
    """
    if pattern is None:
        return None
    m = pattern.match(transcript)
    if not m:
        return None
    return m.group(1).strip()

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


def attach(peer, *, voice_config: VoiceConfig, api_server: Any) -> None:
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
            _run_stt(peer, voice_config, api_server, pcm_q, pump_task),
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
    api_server: Any,
    pcm_q: "asyncio.Queue[Optional[bytes]]",
    pump_task: asyncio.Task,
) -> None:
    """Consume the PCM queue, drive the STT provider, dispatch finals to the agent."""
    stt = get_stt_provider(voice_config.stt)

    async def _pcm_iter() -> AsyncIterator[bytes]:
        while True:
            chunk = await pcm_q.get()
            if chunk is None:
                return
            yield chunk

    try:
        async for tx in stt.stream(_pcm_iter()):
            await _handle_transcript(peer, tx, api_server)
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


def _cancel_silence_timer(peer) -> None:
    timer: Optional[asyncio.Task] = peer.extra.get("silence_timer")
    if timer is not None and not timer.done():
        timer.cancel()
    peer.extra["silence_timer"] = None


def _arm_silence_timer(peer, api_server: Any, silence_sec: float) -> None:
    """Schedule a flush of the current utterance buffer after *silence_sec*.

    Only used when the configured silence window exceeds Deepgram's native
    utterance_end_ms cap (5s).  Cancelled on every new is_final.
    """
    _cancel_silence_timer(peer)

    async def _wait_then_flush() -> None:
        try:
            await asyncio.sleep(silence_sec)
        except asyncio.CancelledError:
            return
        # Pull whatever's still buffered and dispatch.
        buffer: List[str] = peer.extra.setdefault("utterance_buffer", [])
        if not buffer:
            return
        utterance = " ".join(buffer).strip()
        buffer.clear()
        if not utterance:
            return
        logger.info(
            "[stt-bridge] peer %s silence-timer flush: %s",
            peer.peer_id,
            utterance[:120] + ("..." if len(utterance) > 120 else ""),
        )
        asyncio.create_task(
            _dispatch_to_agent(peer, utterance, api_server),
            name=f"webrtc-agent-{peer.peer_id[:8]}",
        )

    peer.extra["silence_timer"] = asyncio.create_task(
        _wait_then_flush(),
        name=f"webrtc-silence-{peer.peer_id[:8]}",
    )


async def _handle_transcript(peer, tx: Transcript, api_server: Any) -> None:
    """Forward an interim or final transcript downstream.

    Live captions: if the peer has registered an ``on_transcript``
    callback or opened the 'events' data channel, every transcript
    (interim + final) is forwarded.  Empty-final markers
    (UtteranceEnd) are skipped — they're internal sync points, not
    user-visible text.

    Final dispatch: only non-empty finals trigger an agent run.  An
    empty final = UtteranceEnd marker, which we use to flush a buffered
    utterance to the agent.

    Commit phrase: when configured, an utterance ending in the commit
    word (e.g. "over") is stripped and dispatched immediately, without
    waiting for UtteranceEnd.

    Silence timer: when ``silence_sec`` exceeds 5s (Deepgram's native
    cap), a manual asyncio timer is armed on every new is_final and
    flushes the buffer if no further speech arrives in the window.
    """
    if peer.on_transcript is not None:
        try:
            await peer.on_transcript(tx.text, tx.is_final)
        except Exception as e:  # pragma: no cover
            logger.warning("[stt-bridge] peer %s on_transcript hook raised: %s", peer.peer_id, e)

    # Push user-speech transcripts over the data channel so the client
    # can render live captions / final user bubbles without waiting for
    # the agent to echo them back through the chat path.
    if tx.text:
        _send_data_channel(peer, {
            "type": "transcript",
            "text": tx.text,
            "is_final": tx.is_final,
            "role": "user",
        })

    if not tx.is_final:
        return

    # Lazy-build the commit-phrase pattern once per peer.
    if "commit_pattern" not in peer.extra:
        peer.extra["commit_pattern"] = _make_commit_regex(
            str(peer.extra.get("commit_phrase") or "")
        )
    commit_pattern = peer.extra["commit_pattern"]
    silence_sec = float(peer.extra.get("silence_sec") or 0)

    # Buffer up multiple finals so we batch the agent dispatch on
    # UtteranceEnd.  Deepgram emits is_final per utterance segment, then
    # an UtteranceEnd marker when the speaker pauses.
    buffer: List[str] = peer.extra.setdefault("utterance_buffer", [])

    if tx.text:
        # Commit-phrase short-circuit: build the joined buffer + this
        # segment, run the regex against the combined text, and if it
        # matches, flush immediately (skip the UtteranceEnd wait).
        if commit_pattern is not None:
            joined = (" ".join(buffer + [tx.text])).strip()
            cleaned = _check_commit_phrase(commit_pattern, joined)
            if cleaned is not None:
                buffer.clear()
                _cancel_silence_timer(peer)
                if cleaned:
                    logger.info(
                        "[stt-bridge] peer %s commit-phrase flush: %s",
                        peer.peer_id,
                        cleaned[:120] + ("..." if len(cleaned) > 120 else ""),
                    )
                    asyncio.create_task(
                        _dispatch_to_agent(peer, cleaned, api_server),
                        name=f"webrtc-agent-{peer.peer_id[:8]}",
                    )
                return

        buffer.append(tx.text)

        # Re-arm the manual silence timer for windows that exceed
        # Deepgram's native cap.  Below the cap, Deepgram's UtteranceEnd
        # is the trusted trigger; above it we add our own backstop.
        if silence_sec > _DG_NATIVE_SILENCE_CAP_SEC:
            _arm_silence_timer(peer, api_server, silence_sec)
        return

    # Empty final => UtteranceEnd.
    #
    # When the user has configured a commit phrase OR a silence window
    # larger than Deepgram's native cap, we IGNORE UtteranceEnd as a
    # dispatch trigger — DG fires it on every ~1.5s pause, which would
    # ship a half-formed sentence to the agent before the user is done
    # thinking. Instead we let either the commit-phrase short-circuit or
    # the manual silence timer be the dispatch trigger, and treat
    # UtteranceEnd as an internal sync point only.
    #
    # When neither is configured (commit_phrase empty AND silence_sec
    # under the DG cap), UtteranceEnd is the trusted natural-conversation
    # trigger — we honor it as before.
    if commit_pattern is not None or silence_sec > _DG_NATIVE_SILENCE_CAP_SEC:
        return

    _cancel_silence_timer(peer)
    if not buffer:
        return
    utterance = " ".join(buffer).strip()
    buffer.clear()
    if not utterance:
        return

    logger.info(
        "[stt-bridge] peer %s utterance: %s",
        peer.peer_id,
        utterance[:120] + ("..." if len(utterance) > 120 else ""),
    )
    asyncio.create_task(
        _dispatch_to_agent(peer, utterance, api_server),
        name=f"webrtc-agent-{peer.peer_id[:8]}",
    )


async def _dispatch_to_agent(peer, utterance: str, api_server: Any) -> None:
    """Run an agent turn for *utterance* and route the streaming reply.

    Two sinks for the reply tokens:

    1. The peer's TTS bridge (if attached, i.e. talk mode) — the bridge
       registers a queue under peer.extra["tts_text_queue"].  We push
       text deltas into that queue.

    2. The peer's on_transcript hook is reused to also surface assistant
       text back to the client (clients can disambiguate via a flag, or
       — current V1 — render both into the chat log).

    For the first overnight pass we keep the integration narrow: rather
    than hijack /v1/chat/completions plumbing, we open an aiohttp client
    against ``http://127.0.0.1:<port>/v1/chat/completions`` so we travel
    the same code path as a normal client.  This is slower than calling
    APIServerAdapter._run_agent directly but it's MUCH safer (uses the
    same auth, same tokenization, same response_store).
    """
    # Determine which port to talk to.  api_server may be None during
    # in-process tests.
    host = "127.0.0.1"
    port = 8642
    if api_server is not None:
        try:
            host = getattr(api_server, "_host", host) or host
            if host in ("0.0.0.0", "::", ""):
                host = "127.0.0.1"
            port = int(getattr(api_server, "_port", port) or port)
        except Exception:
            pass

    headers = {"Content-Type": "application/json"}
    api_key = None
    if api_server is not None:
        api_key = getattr(api_server, "_api_key", None) or None
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    # conv_name is sidekick's stable conversation key (sidekick-<slug>);
    # passing it as body.conversation rather than the older
    # X-Hermes-Session-Id header keeps voice and chat turns chained
    # through ONE session row in state.db.  Earlier wire format spawned
    # a divergent session (the duplicate moennxml-rooted row).
    conv_name = peer.extra.get("conv_name")
    body = {
        "model": "hermes-agent",
        "messages": [{"role": "user", "content": utterance}],
        "stream": True,
    }
    if conv_name:
        body["conversation"] = conv_name

    try:
        import aiohttp  # type: ignore
    except ImportError:  # pragma: no cover
        logger.error("[stt-bridge] aiohttp missing for agent dispatch")
        return

    url = f"http://{host}:{port}/v1/chat/completions"
    logger.debug("[stt-bridge] peer %s dispatching to %s", peer.peer_id, url)

    text_queue: Optional[asyncio.Queue] = peer.extra.get("tts_text_queue")

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
                async for line in resp.content:
                    line = line.strip()
                    if not line or line.startswith(b":"):
                        continue
                    if not line.startswith(b"data:"):
                        continue
                    data = line[len(b"data:"):].strip()
                    if data == b"[DONE]":
                        break
                    try:
                        import json as _json
                        chunk = _json.loads(data)
                    except (ValueError, TypeError):
                        continue
                    delta = (
                        (chunk.get("choices") or [{}])[0]
                        .get("delta", {})
                        .get("content")
                    )
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
                    # Mirror assistant deltas onto the data channel so the
                    # PWA can render the reply bubble without subscribing
                    # to the same /v1/chat/completions stream the bridge
                    # already consumes.  Each delta is a partial; the
                    # client appends rather than replaces.
                    _send_data_channel(peer, {
                        "type": "transcript",
                        "text": delta,
                        "is_final": False,
                        "role": "assistant",
                    })
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
            # the streaming-cursor on the assistant bubble. Without this,
            # the bubble keeps `class="agent streaming"` forever and shows
            # a perpetual blinking thinking-cursor under every prior reply.
            _send_data_channel(peer, {
                "type": "transcript",
                "text": "",
                "is_final": True,
                "role": "assistant",
            })


__all__ = ["attach"]
