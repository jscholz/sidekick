"""
TTS bridge: agent reply text-stream -> TTSProvider.synth -> outbound RTC track.

Per peer (talk mode only):

    text_queue (asyncio.Queue[str])    # populated by stt_bridge
        |
        |  async generator: drain queue
        v
    TTSProvider.synth(text_iter)
        |
        v  16 kHz mono int16 PCM bytes
    PCMTrack (MediaStreamTrack subclass)
        |
        v  av.AudioFrame chunks of 20 ms
    aiortc.PeerConnection.addTrack -> Opus encode -> outbound RTP

The PCMTrack instance is constructed up-front and added to the peer
connection BEFORE we accept the offer so the answer SDP advertises the
outbound track.  The synth task fires lazily — it sits idle until the
text queue starts producing.

Resampling: The Aura adapter returns 16 kHz int16 PCM (we requested
linear16/16000 in the URL).  aiortc happily encodes any sample rate to
Opus via PyAV; we just package the bytes into 20 ms AudioFrame slices.
"""

from __future__ import annotations

import asyncio
import fractions
import logging
import time
from typing import Any, AsyncIterator, Optional

from config import VoiceConfig
from providers import get_tts_provider

logger = logging.getLogger(__name__)

# 20 ms frames at 16 kHz mono int16 = 16000 * 0.02 * 2 bytes = 640 bytes.
TTS_SAMPLE_RATE = 16000
TTS_FRAME_MS = 20
TTS_FRAME_SAMPLES = int(TTS_SAMPLE_RATE * TTS_FRAME_MS / 1000)
TTS_FRAME_BYTES = TTS_FRAME_SAMPLES * 2

# Cap text queue so a runaway delta stream doesn't OOM us.
MAX_TEXT_QUEUE = 1024
# PCM frame queue cap. The producer (synth feed loop) blocks via
# `await queue.put()` when the queue is full, so this cap is purely
# a memory ceiling — not a correctness threshold. 200 frames = 4 s.
# Was 150 with silent drops on overflow (rushed/garbled audio after
# 5-6 s of long replies). True backpressure replaces the drops:
# producer waits, consumer drains at 20 ms wall-clock, no frames
# ever lost. Receiver always sees a continuous, properly-paced
# stream.
MAX_PCM_FRAME_QUEUE = 200


def attach(peer, *, voice_config: VoiceConfig, api_server: Any) -> None:
    """Wire an outbound TTS track onto *peer*.

    Must be called before :func:`signaling.handle_offer` calls
    setLocalDescription so the SDP answer advertises the outbound track.
    """
    try:
        from aiortc import MediaStreamTrack  # type: ignore
    except ImportError as exc:  # pragma: no cover
        logger.error("[tts-bridge] aiortc missing: %s", exc)
        return

    text_queue: "asyncio.Queue[Optional[str]]" = asyncio.Queue(maxsize=MAX_TEXT_QUEUE)
    peer.extra["tts_text_queue"] = text_queue

    track = PCMTrack()
    peer.pc.addTrack(track)
    peer.extra["tts_track"] = track

    peer.tts_task = asyncio.create_task(
        _run_tts(peer, voice_config, text_queue, track),
        name=f"webrtc-tts-{peer.peer_id[:8]}",
    )

    logger.info("[tts-bridge] peer %s outbound TTS track wired", peer.peer_id)


async def _run_tts(peer, voice_config: VoiceConfig, text_queue, track) -> None:
    """Drain the text queue, run TTSProvider.synth, push PCM into the track."""
    tts = get_tts_provider(voice_config.tts)

    async def _text_iter() -> AsyncIterator[str]:
        # We don't end after the first None — the agent may produce
        # several replies in one call (one per utterance).  Instead we
        # treat None as an end-of-reply marker and keep the iterator
        # alive for the next reply.
        while True:
            chunk = await text_queue.get()
            if chunk is None:
                # End of one reply; reset and continue.  This relies on
                # the provider's internal buffer flushing on its own
                # when the inner generator ``yield``s nothing more —
                # most providers will close the upstream HTTP request
                # at that point.  Practical workaround: re-instantiate
                # the provider per reply.
                return
            if not chunk:
                continue
            yield chunk

    try:
        # Loop forever: each iteration handles one reply round.
        while not peer.closed:
            # Wait for the first chunk — peeking lets us avoid making
            # a fresh HTTP TTS connection until there's actually text.
            first: Optional[str] = await text_queue.get()
            if first is None:
                # Spurious end marker; loop back and wait.
                continue
            if not first:
                continue

            async def _iter_with_first() -> AsyncIterator[str]:
                yield first
                while True:
                    chunk = await text_queue.get()
                    if chunk is None:
                        return
                    if chunk:
                        yield chunk

            buf = bytearray()
            halted = False
            try:
                async for pcm in tts.synth(_iter_with_first()):
                    # Halt signal — server-side barge or future
                    # explicit interrupt has been raised. Bail out of
                    # the current TTS reply ASAP so new frames don't
                    # refill the queue that halt() just drained.
                    # We do NOT raise: the halt is cooperative, the
                    # outer loop should keep running for the next
                    # reply round.
                    if track.halt_event.is_set():
                        halted = True
                        break
                    if not pcm:
                        continue
                    buf.extend(pcm)
                    while len(buf) >= TTS_FRAME_BYTES:
                        frame_bytes = bytes(buf[:TTS_FRAME_BYTES])
                        del buf[:TTS_FRAME_BYTES]
                        # Backpressure-by-await: if PCMTrack's queue
                        # is full, the synth loop blocks here until
                        # recv() drains a slot. The upstream HTTP
                        # connection from Aura idles for a few hundred
                        # ms; that's fine — Aura tolerates pauses.
                        # This is the structural alternative to the
                        # old silent-drop-on-overflow which caused
                        # rushed/garbled audio on long replies.
                        try:
                            await track.feed_async(frame_bytes)
                        except Exception as e:  # pragma: no cover
                            logger.warning("[tts-bridge] track.feed_async failed: %s", e)
                if halted:
                    # Drop any partial buffer — don't flush halted
                    # audio to the now-empty queue. Drain text_queue
                    # up to and including the reply's terminator
                    # (None) so leftover deltas from the halted reply
                    # don't bleed into the next round. Then clear the
                    # event so the next reply's synth loop runs free.
                    buf.clear()
                    drained = 0
                    while True:
                        try:
                            item = text_queue.get_nowait()
                        except asyncio.QueueEmpty:
                            break
                        drained += 1
                        if item is None:
                            break
                    logger.info(
                        "[tts-bridge] peer %s halted; drained %d text-queue items",
                        peer.peer_id, drained,
                    )
                    track.halt_event.clear()
                    continue
                # Flush tail (zero-pad to frame boundary so the encoder
                # gets a clean last frame).
                if buf:
                    pad = TTS_FRAME_BYTES - (len(buf) % TTS_FRAME_BYTES)
                    if pad and pad < TTS_FRAME_BYTES:
                        buf.extend(b"\x00" * pad)
                    while len(buf) >= TTS_FRAME_BYTES:
                        frame_bytes = bytes(buf[:TTS_FRAME_BYTES])
                        del buf[:TTS_FRAME_BYTES]
                        try:
                            await track.feed_async(frame_bytes)
                        except Exception:  # pragma: no cover
                            pass
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning("[tts-bridge] peer %s synth error: %s", peer.peer_id, e)
    except asyncio.CancelledError:
        raise
    except Exception as e:
        logger.exception("[tts-bridge] peer %s outer loop crashed: %s", peer.peer_id, e)
    finally:
        try:
            await tts.aclose()
        except Exception:  # pragma: no cover
            pass


# ----------------------------------------------------------------------
# PCMTrack: MediaStreamTrack subclass that emits 20ms av.AudioFrame slices
# from a bytes-feeding queue.  When the queue is empty we emit silence so
# the RTP track keeps flowing — iOS Safari likes a continuously-paced
# track over a stop/start one.
# ----------------------------------------------------------------------

try:
    from aiortc import MediaStreamTrack  # type: ignore
    from av.audio.frame import AudioFrame  # type: ignore
    import numpy as np  # type: ignore
    _AIORTC_OK = True
except ImportError:  # pragma: no cover
    MediaStreamTrack = object  # type: ignore
    AudioFrame = None  # type: ignore
    np = None  # type: ignore
    _AIORTC_OK = False


class PCMTrack(MediaStreamTrack):  # type: ignore[misc]
    """Outbound audio MediaStreamTrack fed from an in-process bytes queue.

    External producers call :meth:`feed` with 20 ms (640-byte) PCM
    chunks; the track's :meth:`recv` paces them out at 20 ms wall-clock.
    Empty queue -> silence.
    """

    kind = "audio"

    def __init__(self) -> None:
        super().__init__()
        if not _AIORTC_OK:
            raise RuntimeError("aiortc/PyAV not installed")
        self._frame_queue: "asyncio.Queue[bytes]" = asyncio.Queue(maxsize=MAX_PCM_FRAME_QUEUE)
        self._sample_rate = TTS_SAMPLE_RATE
        self._samples_per_frame = TTS_FRAME_SAMPLES
        self._pts = 0
        self._silence = bytes(TTS_FRAME_BYTES)
        self._next_send_time: Optional[float] = None
        self._closed = False
        # Monotonic timestamp of the last non-silent frame emitted to
        # the wire. The STT bridge consults this via is_active() to
        # gate inbound transcription during TTS playback (kills the
        # iOS speakerphone echo loop deterministically).
        self._last_nonsilent_at: Optional[float] = None
        # Halt signal: set by halt() to tell the synthesis loop in
        # _run_tts to bail out of the current TTS reply ASAP. The
        # synth loop polls this between provider chunks (Option A —
        # see halt() docstring for why over a generation token).
        # Cleared by _run_tts itself after it has drained the leftover
        # text_queue and is ready for a fresh reply round.
        self.halt_event: asyncio.Event = asyncio.Event()

    def feed(self, pcm_bytes: bytes) -> None:
        """Synchronous push, kept for any non-async caller.

        Drops on full queue rather than blocking. Prefer feed_async
        from async producer code paths to get true backpressure.
        """
        if self._closed:
            return
        if len(pcm_bytes) != TTS_FRAME_BYTES:
            if len(pcm_bytes) < TTS_FRAME_BYTES:
                pcm_bytes = pcm_bytes + bytes(TTS_FRAME_BYTES - len(pcm_bytes))
            else:
                pcm_bytes = pcm_bytes[:TTS_FRAME_BYTES]
        try:
            self._frame_queue.put_nowait(pcm_bytes)
        except asyncio.QueueFull:
            pass

    async def feed_async(self, pcm_bytes: bytes) -> None:
        """Async push that BLOCKS when the queue is full — true
        backpressure to the producer.

        When `recv()` (paced at 20 ms wall-clock) can't drain fast
        enough to keep up with the synth feed rate, this await pauses
        the producer until a slot frees. Receiver sees a continuous,
        correctly-paced RTP stream regardless of upstream burstiness.
        No frame drops, no buffer-overflow speedup symptoms.
        """
        if self._closed:
            return
        if len(pcm_bytes) != TTS_FRAME_BYTES:
            if len(pcm_bytes) < TTS_FRAME_BYTES:
                pcm_bytes = pcm_bytes + bytes(TTS_FRAME_BYTES - len(pcm_bytes))
            else:
                pcm_bytes = pcm_bytes[:TTS_FRAME_BYTES]
        await self._frame_queue.put(pcm_bytes)

    async def recv(self):  # noqa: D401 — aiortc API
        """Return the next AudioFrame, paced at 20 ms wall-clock.

        Strict pacing: if the consumer is asking too fast (delay > 0)
        we sleep until the next slot. If the consumer is asking too
        SLOW (delay <= 0, we're past schedule), we DON'T catch up by
        emitting fast — we resync to wall-clock so the next slot is
        20 ms from `now`, not 20 ms from a stale past schedule.

        The previous version (always `+= 20ms` regardless) accumulated
        phase debt: a few ms of drift per call, no resync, eventually
        bursting frames as fast as the consumer pulled them. Browser
        plays the burst sped-up + garbled — empirically reproducible
        ~5-6 s into a TTS reply across both desktop and mobile.
        """
        now = time.monotonic()
        if self._next_send_time is None:
            self._next_send_time = now
        delay = self._next_send_time - now
        if delay > 0.001:
            await asyncio.sleep(delay)
            self._next_send_time += TTS_FRAME_MS / 1000.0
        else:
            # Behind schedule — resync to wall-clock. No burst.
            self._next_send_time = now + TTS_FRAME_MS / 1000.0

        # Pull a frame; fall back to silence to keep the track active.
        try:
            pcm = self._frame_queue.get_nowait()
            self._last_nonsilent_at = now
        except asyncio.QueueEmpty:
            pcm = self._silence

        # Build an av.AudioFrame.  layout=mono, format=s16, samples=320.
        arr = np.frombuffer(pcm, dtype=np.int16).reshape(1, -1)
        frame = AudioFrame.from_ndarray(arr, format="s16", layout="mono")
        frame.sample_rate = self._sample_rate
        frame.pts = self._pts
        frame.time_base = fractions.Fraction(1, self._sample_rate)
        self._pts += self._samples_per_frame
        return frame

    # Grace period after the last non-silent frame was put on the wire
    # before the STT bridge resumes forwarding mic audio to Deepgram.
    # Covers TTS audio still in transit (network buffer, decoder lag,
    # speakerphone-driver latency) plus the room reverb tail. 1.2s
    # mirrors the PWA-side duplex tail we used and gives a comfortable
    # margin without making barge-in feel laggy.
    TTS_TAIL_GRACE_S = 1.2

    def is_active(self, grace_s: Optional[float] = None) -> bool:
        """True if a non-silent TTS frame was emitted recently.

        STT bridge calls this to decide whether to forward mic audio
        to Deepgram. While True, mic frames are replaced with silence
        — Deepgram sees a quiet input and produces no false transcripts
        from the speakerphone echo of TTS playback.
        """
        if self._last_nonsilent_at is None:
            return False
        g = grace_s if grace_s is not None else PCMTrack.TTS_TAIL_GRACE_S
        return (time.monotonic() - self._last_nonsilent_at) < g

    def halt(self) -> None:
        """Drop queued frames + mark inactive immediately. Symmetrizes
        the bridge-side TTS state with the PWA-side <audio> pause on
        barge.

        Two effects, both required for a clean stop:

        1. Drain `_frame_queue` so the next ~MAX_PCM_FRAME_QUEUE recv()
           calls fall back to silence rather than emitting buffered
           TTS audio that the PWA has already paused — without this,
           recv() keeps `_last_nonsilent_at` fresh and `is_active()`
           stays true.

        2. Reset `_last_nonsilent_at` to None so `is_active()` flips
           false on the very next call. The STT bridge polls
           `is_active()` per inbound frame; a False return immediately
           reopens the mic→Deepgram path.

        Halt synthesis-in-flight via `halt_event`: the `_run_tts` loop
        polls this between provider chunks and bails out of the current
        TTS reply, so new frames don't refill the queue right after
        we drained it.

        Idempotent: safe to call multiple times. Safe to call from
        a sync context (no awaits)."""
        self.halt_event.set()
        while not self._frame_queue.empty():
            try:
                self._frame_queue.get_nowait()
            except asyncio.QueueEmpty:
                break
        self._last_nonsilent_at = None

    def stop(self) -> None:  # pragma: no cover — aiortc lifecycle
        self._closed = True
        try:
            super().stop()
        except Exception:
            pass


__all__ = ["attach", "PCMTrack"]
