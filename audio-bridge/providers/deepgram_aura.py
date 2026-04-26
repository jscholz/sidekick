"""
Deepgram Aura TTS adapter.

Strategy: buffer the agent reply text-stream into sentence-sized chunks,
call the Aura REST ``/v1/speak`` endpoint with ``encoding=linear16&
sample_rate=16000`` per chunk, stream the raw PCM bytes back as they
arrive over HTTP.  This trades a bit of latency vs. the (more complex)
Aura WebSocket streaming API for code we can confidently ship overnight.

If you want the WS path later, re-implement ``_synth_chunk`` to open a
single WS for the whole call and write text frames as the chunks arrive
— the public ``synth`` method's contract is unchanged.

A blank text_iter end-of-stream is fine; the iterator naturally closes
on the next ``async for`` exit.
"""

from __future__ import annotations

import asyncio
import logging
import re
import urllib.parse
from typing import AsyncIterator, Optional

from config import ProviderSpec
from .tts import TTSProvider, register_tts_provider

logger = logging.getLogger(__name__)

DEEPGRAM_TTS_URL = "https://api.deepgram.com/v1/speak"
DEFAULT_VOICE = "aura-2-thalia-en"
DEFAULT_SAMPLE_RATE = 16000

# Flush text to TTS at sentence-ish boundaries — trades latency for
# prosody.  ``.``, ``!``, ``?`` and newlines all close a chunk.
_SENTENCE_SPLIT = re.compile(r"(?<=[\.!?])\s+|\n+")
# Force-flush after this many chars without a sentence break, so a long
# unpunctuated reply doesn't sit in the buffer forever.
_MAX_BUFFER_CHARS = 240


class DeepgramAuraTTS(TTSProvider):
    def __init__(self, spec: ProviderSpec) -> None:
        self._spec = spec
        self._api_key: Optional[str] = spec.get_api_key()
        self._voice = str(spec.options.get("voice", DEFAULT_VOICE))
        self._sample_rate = int(spec.options.get("sample_rate", DEFAULT_SAMPLE_RATE))
        self._session = None  # aiohttp.ClientSession, opened lazily

    async def _ensure_session(self):
        if self._session is None:
            try:
                import aiohttp  # type: ignore
            except ImportError as exc:  # pragma: no cover
                raise RuntimeError(
                    "aiohttp not installed; install hermes-agent[messaging] or [webrtc]"
                ) from exc
            self._session = aiohttp.ClientSession()
        return self._session

    def _build_url(self) -> str:
        params = {
            "model": self._voice,
            "encoding": "linear16",
            "sample_rate": str(self._sample_rate),
            "container": "none",
        }
        return f"{DEEPGRAM_TTS_URL}?{urllib.parse.urlencode(params)}"

    async def _synth_chunk(self, text: str) -> AsyncIterator[bytes]:
        if not text.strip():
            return
        if not self._api_key:
            raise RuntimeError(
                "DeepgramAuraTTS requires an API key.  Set the env var named in "
                "voice.tts.api_key_env (default DEEPGRAM_API_KEY)."
            )
        session = await self._ensure_session()
        url = self._build_url()
        headers = {
            "Authorization": f"Token {self._api_key}",
            "Content-Type": "application/json",
        }
        body = {"text": text}
        logger.debug("[deepgram-aura] POST %s len=%d", url, len(text))
        try:
            async with session.post(url, json=body, headers=headers) as resp:
                if resp.status != 200:
                    err = (await resp.text())[:200]
                    logger.warning(
                        "[deepgram-aura] %d: %s", resp.status, err,
                    )
                    return
                async for chunk in resp.content.iter_chunked(4096):
                    if chunk:
                        yield chunk
        except Exception as e:
            logger.warning("[deepgram-aura] synth error: %s", e)

    async def synth(self, text_iter: AsyncIterator[str]) -> AsyncIterator[bytes]:
        buf = ""
        async for piece in text_iter:
            if not piece:
                continue
            buf += piece
            # Flush completed sentences out of the buffer.
            while True:
                match = _SENTENCE_SPLIT.search(buf)
                if match:
                    chunk, buf = buf[: match.end()].strip(), buf[match.end():]
                    if chunk:
                        async for pcm in self._synth_chunk(chunk):
                            yield pcm
                    continue
                # No sentence boundary; still flush if we've accumulated
                # too much (long unpunctuated reply).
                if len(buf) >= _MAX_BUFFER_CHARS:
                    chunk, buf = buf, ""
                    async for pcm in self._synth_chunk(chunk):
                        yield pcm
                break
        # Final flush — partial sentence at end of stream.
        tail = buf.strip()
        if tail:
            async for pcm in self._synth_chunk(tail):
                yield pcm

    async def aclose(self) -> None:
        if self._session is not None:
            try:
                await self._session.close()
            except Exception:  # pragma: no cover
                pass
            self._session = None


def _factory(spec: ProviderSpec) -> TTSProvider:
    return DeepgramAuraTTS(spec)


# Self-register on import.
register_tts_provider("deepgram_aura", _factory)
