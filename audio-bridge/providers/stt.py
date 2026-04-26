"""
STT provider Protocol + registry.

Contract (kept narrow on purpose):

    pcm_iter yields ``bytes`` of 16 kHz mono signed-int16 little-endian
    PCM frames.  Frame size is provider-flexible — most providers buffer
    upstream — but stt_bridge will deliver in 20 ms chunks (640 bytes).

    The provider yields :class:`Transcript` records.  ``is_final=True``
    marks an utterance boundary.  ``confidence`` is optional.

Providers are awaitable async generators so the caller can iterate them
with ``async for`` and abort by cancelling the consuming task.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import AsyncIterator, Awaitable, Callable, Dict, Optional, Protocol

from config import ProviderSpec


@dataclass
class Transcript:
    """One STT result (interim or final)."""

    text: str
    is_final: bool
    confidence: Optional[float] = None
    # Optional speaker diarization label; Deepgram populates this when
    # ``diarize=true``.  Absent in providers that don't support it.
    speaker: Optional[str] = None


class STTProvider(Protocol):
    """Speech-to-text contract — streaming + batch.

    Both modes are obligatory on the Protocol so the bridge can serve
    live mic (``stream``) and one-shot voice memos (``transcribe``)
    through the same provider config.  Providers that genuinely cannot
    do batch should raise :class:`NotImplementedError` from
    ``transcribe`` with a helpful message; the signaling handler
    surfaces that as HTTP 501 to the caller.
    """

    async def stream(
        self, pcm_iter: AsyncIterator[bytes]
    ) -> AsyncIterator[Transcript]:
        """Consume PCM frames; yield Transcripts."""
        ...

    async def transcribe(self, audio: bytes, mime: str) -> str:
        """Batch-transcribe a complete audio blob; return the final text.

        ``mime`` is the Content-Type of the blob (e.g. ``audio/webm``,
        ``audio/wav``); providers that need a specific container format
        should validate or transcode upstream.  Returns whitespace-
        normalized text matching the streaming path's formatting so
        live + memo paths produce identical bubbles.
        """
        ...

    async def aclose(self) -> None:  # pragma: no cover — providers may no-op
        """Release any upstream sockets / threads."""
        ...


# ----------------------------------------------------------------------
# Registry — provider name -> factory(spec) -> STTProvider instance.
# Factories are sync; constructing a provider should be cheap (open the
# upstream socket lazily inside ``stream``).
# ----------------------------------------------------------------------

_STT_FACTORIES: Dict[str, Callable[[ProviderSpec], STTProvider]] = {}


def register_stt_provider(
    name: str, factory: Callable[[ProviderSpec], STTProvider]
) -> None:
    """Register an STT provider factory under *name*.

    Idempotent: re-registering the same name silently overwrites — useful
    for tests and for hot-reload during development.
    """
    _STT_FACTORIES[name] = factory


def get_stt_provider(spec: ProviderSpec) -> STTProvider:
    """Instantiate an STT provider from its config record.

    Raises ``KeyError`` with a helpful message listing the registered
    providers if *spec.provider* is unknown.
    """
    try:
        factory = _STT_FACTORIES[spec.provider]
    except KeyError as exc:
        registered = sorted(_STT_FACTORIES.keys()) or ["<none registered>"]
        raise KeyError(
            f"Unknown STT provider {spec.provider!r}. Registered: {registered}"
        ) from exc
    return factory(spec)


__all__ = [
    "STTProvider",
    "Transcript",
    "register_stt_provider",
    "get_stt_provider",
]
