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
# Cap PCM frame queue (~3 s of audio at 20 ms each).
MAX_PCM_FRAME_QUEUE = 150


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
            try:
                async for pcm in tts.synth(_iter_with_first()):
                    if not pcm:
                        continue
                    buf.extend(pcm)
                    while len(buf) >= TTS_FRAME_BYTES:
                        frame_bytes = bytes(buf[:TTS_FRAME_BYTES])
                        del buf[:TTS_FRAME_BYTES]
                        try:
                            track.feed(frame_bytes)
                        except Exception as e:  # pragma: no cover
                            logger.warning("[tts-bridge] track.feed failed: %s", e)
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
                            track.feed(frame_bytes)
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

    def feed(self, pcm_bytes: bytes) -> None:
        """Push one 20 ms PCM frame into the outbound queue.

        Drops frames if the queue is full (the call is from a coroutine
        but synchronous to it) — better to lose a frame than to block
        the synth loop.
        """
        if self._closed:
            return
        if len(pcm_bytes) != TTS_FRAME_BYTES:
            # Caller didn't slice on a frame boundary; pad/truncate.
            if len(pcm_bytes) < TTS_FRAME_BYTES:
                pcm_bytes = pcm_bytes + bytes(TTS_FRAME_BYTES - len(pcm_bytes))
            else:
                pcm_bytes = pcm_bytes[:TTS_FRAME_BYTES]
        try:
            self._frame_queue.put_nowait(pcm_bytes)
        except asyncio.QueueFull:
            pass

    async def recv(self):  # noqa: D401 — aiortc API
        """Return the next AudioFrame, paced at 20 ms."""
        # Pace
        now = time.monotonic()
        if self._next_send_time is None:
            self._next_send_time = now
        delay = self._next_send_time - now
        if delay > 0.001:
            await asyncio.sleep(delay)
        self._next_send_time += TTS_FRAME_MS / 1000.0

        # Pull a frame; fall back to silence to keep the track active.
        try:
            pcm = self._frame_queue.get_nowait()
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

    def stop(self) -> None:  # pragma: no cover — aiortc lifecycle
        self._closed = True
        try:
            super().stop()
        except Exception:
            pass


__all__ = ["attach", "PCMTrack"]
