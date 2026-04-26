"""
Provider registry for the WebRTC voice transport.

This package defines the narrow STT / TTS Protocol classes plus a tiny
in-process registry.  The point of the abstraction is single-axis: when a
new provider lands you implement the protocol once and register a factory
function — no surgery on peer.py, stt_bridge.py, or tts_bridge.py.

Two providers ship in V1:

    stt.deepgram        — Deepgram nova-3 streaming WS
    tts.deepgram_aura   — Deepgram Aura HTTP (chunked PCM)

Two more are intentionally stubbed (commented stub modules) so the next
contributor sees the contract:

    stt.local_whisper   — faster-whisper or whisper.cpp on the Pi
    tts.local_piper     — piper TTS

Importing this package never instantiates a provider; resolution happens
on demand inside peer.py at peer-connection setup time.
"""

from .stt import STTProvider, Transcript, get_stt_provider, register_stt_provider
from .tts import TTSProvider, get_tts_provider, register_tts_provider

# Pull built-in adapters in for their side-effect of self-registering.
# Do NOT import the local_* placeholders — they raise at import-time on
# purpose so that selecting them in config makes the cause obvious.
from . import deepgram as _deepgram_stt  # noqa: F401
from . import deepgram_aura as _deepgram_tts  # noqa: F401

__all__ = [
    "STTProvider",
    "TTSProvider",
    "Transcript",
    "get_stt_provider",
    "get_tts_provider",
    "register_stt_provider",
    "register_tts_provider",
]
