"""
TTS provider Protocol + registry.

Contract:

    text_iter yields ``str`` reply chunks (a sentence, a clause, or a
    full reply — the provider decides how aggressively to flush).  The
    provider yields ``bytes`` of 16 kHz mono signed-int16 little-endian
    PCM, suitable for the Opus encoder on the outbound RTC track.

    Most providers want full sentences for prosody.  tts_bridge will
    optionally buffer until punctuation before flushing a chunk to the
    provider — the buffering policy lives in the bridge, not here, so a
    "tts.local_streaming" provider that prefers fragments doesn't have
    to fight the bridge.
"""

from __future__ import annotations

from typing import AsyncIterator, Callable, Dict, Protocol

from config import ProviderSpec


class TTSProvider(Protocol):
    """Streaming text-to-speech contract."""

    async def synth(self, text_iter: AsyncIterator[str]) -> AsyncIterator[bytes]:
        """Consume text chunks; yield 16 kHz mono int16 PCM frames."""
        ...

    async def aclose(self) -> None:  # pragma: no cover — providers may no-op
        """Release any upstream sockets / sessions."""
        ...


# ----------------------------------------------------------------------
# Registry — same shape as the STT registry.
# ----------------------------------------------------------------------

_TTS_FACTORIES: Dict[str, Callable[[ProviderSpec], TTSProvider]] = {}


def register_tts_provider(
    name: str, factory: Callable[[ProviderSpec], TTSProvider]
) -> None:
    """Register a TTS provider factory under *name*.  Idempotent."""
    _TTS_FACTORIES[name] = factory


def get_tts_provider(spec: ProviderSpec) -> TTSProvider:
    """Instantiate a TTS provider from its config record."""
    try:
        factory = _TTS_FACTORIES[spec.provider]
    except KeyError as exc:
        registered = sorted(_TTS_FACTORIES.keys()) or ["<none registered>"]
        raise KeyError(
            f"Unknown TTS provider {spec.provider!r}. Registered: {registered}"
        ) from exc
    return factory(spec)


__all__ = [
    "TTSProvider",
    "register_tts_provider",
    "get_tts_provider",
]
