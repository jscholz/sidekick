"""
Deepgram nova-3 streaming STT adapter.

Mirrors the parameters used by the sidekick node proxy
(``server.ts`` /ws/deepgram path) so behaviour is identical between the
classic-pipeline path and the WebRTC path: same model, same smart_format,
diarize, endpointing, utterance_end, interim_results.

The bridge feeds us 16 kHz mono int16 PCM (rather than 48 kHz like the
browser path) because aiortc decodes Opus -> 48 kHz and we resample down
inside :mod:`stt_bridge`.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import urllib.parse
from typing import AsyncIterator, Optional

from config import ProviderSpec
from .stt import STTProvider, Transcript, register_stt_provider

logger = logging.getLogger(__name__)

DEEPGRAM_WS_URL = "wss://api.deepgram.com/v1/listen"
DEFAULT_MODEL = "nova-3"
DEFAULT_LANGUAGE = "en-US"
DEFAULT_SAMPLE_RATE = 16000

# Collapses any run of whitespace (including the newlines smart_format
# inserts on speaker pauses / paragraph breaks) to a single space.
_WHITESPACE_RE = re.compile(r"\s+")


class DeepgramSTT(STTProvider):
    def __init__(self, spec: ProviderSpec) -> None:
        self._spec = spec
        self._api_key: Optional[str] = spec.get_api_key()
        self._model = str(spec.options.get("model", DEFAULT_MODEL))
        self._language = str(spec.options.get("language", DEFAULT_LANGUAGE))
        self._sample_rate = int(spec.options.get("sample_rate", DEFAULT_SAMPLE_RATE))
        self._diarize = bool(spec.options.get("diarize", True))
        self._smart_format = bool(spec.options.get("smart_format", True))
        self._endpointing = int(spec.options.get("endpointing", 300))
        self._utterance_end_ms = int(spec.options.get("utterance_end_ms", 1500))
        self._keyterms = list(spec.options.get("keyterms", []) or [])
        self._ws = None  # type: ignore[assignment]
        self._closed = False

    def _build_url(self) -> str:
        params = {
            "model": self._model,
            "language": self._language,
            "smart_format": "true" if self._smart_format else "false",
            "diarize": "true" if self._diarize else "false",
            "filler_words": "false",
            "endpointing": str(self._endpointing),
            "encoding": "linear16",
            "sample_rate": str(self._sample_rate),
            "channels": "1",
            "interim_results": "true",
            "utterance_end_ms": str(self._utterance_end_ms),
        }
        qs = urllib.parse.urlencode(params)
        for kw in self._keyterms:
            # Deepgram supports repeated &keyterm=... params (one per term).
            qs += "&keyterm=" + urllib.parse.quote(str(kw))
        return f"{DEEPGRAM_WS_URL}?{qs}"

    async def stream(self, pcm_iter: AsyncIterator[bytes]) -> AsyncIterator[Transcript]:
        if not self._api_key:
            raise RuntimeError(
                "DeepgramSTT requires an API key.  Set the env var named in "
                "voice.stt.api_key_env (default DEEPGRAM_API_KEY)."
            )

        # websockets is a lazy import so the rest of the gateway can boot
        # without aiortc/websockets installed.  If the user selects the
        # deepgram provider without the optional deps, this is where the
        # error becomes obvious.
        try:
            import websockets  # type: ignore
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                "websockets package not installed; run `pip install hermes-agent[webrtc]`"
            ) from exc

        url = self._build_url()
        # Deepgram authenticates via either Authorization: Token <key> or
        # the WebSocket subprotocol pair ('token', <key>).  We use the
        # header form because subprotocol negotiation is finicky on some
        # client libraries and the header version is rock-solid.
        headers = {"Authorization": f"Token {self._api_key}"}

        logger.info(
            "[deepgram-stt] opening %s model=%s rate=%d",
            DEEPGRAM_WS_URL, self._model, self._sample_rate,
        )

        # Use the websockets connect API; old/new versions disagree on
        # whether the kwarg is ``extra_headers`` or ``additional_headers``.
        try:
            ws = await websockets.connect(url, additional_headers=headers, max_size=2**20)
        except TypeError:
            ws = await websockets.connect(url, extra_headers=headers, max_size=2**20)

        self._ws = ws

        send_task: Optional[asyncio.Task] = None

        async def _pump_pcm() -> None:
            try:
                async for chunk in pcm_iter:
                    if self._closed:
                        break
                    if not chunk:
                        continue
                    await ws.send(chunk)
            except Exception as e:  # pragma: no cover
                logger.warning("[deepgram-stt] pcm pump stopped: %s", e)
            finally:
                # Tell Deepgram we're done so it flushes the final hypothesis.
                try:
                    await ws.send(json.dumps({"type": "CloseStream"}))
                except Exception:
                    pass

        send_task = asyncio.create_task(_pump_pcm(), name="deepgram-stt-pcm-pump")

        try:
            async for raw in ws:
                if isinstance(raw, (bytes, bytearray)):
                    # We never expect binary frames back from Deepgram on
                    # this path — log and skip.
                    continue
                try:
                    payload = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    continue
                msg_type = payload.get("type")
                if msg_type == "Results":
                    for t in _parse_results(payload):
                        yield t
                elif msg_type == "UtteranceEnd":
                    # Emit an empty final to signal end-of-utterance to
                    # callers that want to gate agent dispatch on it.
                    yield Transcript(text="", is_final=True)
                # Metadata / SpeechStarted ignored
        finally:
            self._closed = True
            try:
                await ws.close()
            except Exception:
                pass
            if send_task and not send_task.done():
                send_task.cancel()
                try:
                    await send_task
                except (asyncio.CancelledError, Exception):
                    pass

    async def aclose(self) -> None:
        self._closed = True
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:  # pragma: no cover
                pass


def _parse_results(payload: dict):
    """Convert a Deepgram Results frame into one or more Transcripts."""
    is_final = bool(payload.get("is_final", False))
    channel = payload.get("channel") or {}
    alts = channel.get("alternatives") or []
    if not alts:
        return
    primary = alts[0]
    text = (primary.get("transcript") or "").strip()
    if not text:
        return
    # Normalize whitespace: smart_format=true injects newlines on speaker
    # pauses / paragraph splits, which leak into user bubbles and the
    # agent prompt verbatim. Collapse all whitespace runs to a single
    # space so downstream consumers see clean inline text. Punctuation
    # is preserved (only \s class collapsed).
    text = _WHITESPACE_RE.sub(" ", text).strip()
    if not text:
        return
    confidence = primary.get("confidence")
    speaker = None
    words = primary.get("words") or []
    if words:
        # Use the most-frequent speaker label across the words; Deepgram
        # tags speakers per-word when diarize=true.
        from collections import Counter

        labels = [w.get("speaker") for w in words if w.get("speaker") is not None]
        if labels:
            speaker = str(Counter(labels).most_common(1)[0][0])
    yield Transcript(
        text=text,
        is_final=is_final,
        confidence=float(confidence) if isinstance(confidence, (int, float)) else None,
        speaker=speaker,
    )


def _factory(spec: ProviderSpec) -> STTProvider:
    return DeepgramSTT(spec)


# Self-register on import.
register_stt_provider("deepgram", _factory)
