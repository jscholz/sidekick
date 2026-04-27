"""
Sidekick audio bridge — standalone aiohttp service.

This is the reference Python/aiortc implementation of the sidekick
audio bridge contract (see ``docs/SIDEKICK_AUDIO_PROTOCOL.md`` in this
repo for the wire format). It owns:

  - WebRTC peer connection lifecycle (offer / answer / ICE / close)
  - Opus → 16 kHz PCM resampling
  - STT provider stream (Deepgram nova-3 default)
  - DataChannel events (transcripts, future control messages)
  - (Talk mode) TTS provider PCM → outbound RTP track

The bridge does NOT talk to the agent backend directly. All sidekick
→ agent traffic flows through the sidekick proxy, which is the sole
gateway. The bridge POSTs utterances to
``<SIDEKICK_PROXY_URL>/api/<backend>/responses`` (the active backend is
configured on the proxy) and streams the SSE reply back over the data
channel as transcript envelopes.

Environment variables:

    SIDEKICK_AUDIO_HOST   bind host (default 127.0.0.1)
    SIDEKICK_AUDIO_PORT   bind port (default 8643)
    SIDEKICK_PROXY_URL    sidekick proxy base URL (default http://127.0.0.1:3001)
    SIDEKICK_BACKEND      active backend slug for the proxy responses
                          endpoint (default ``hermes``). The bridge POSTs
                          utterances to ``<proxy>/api/<be>/responses``;
                          ``<be>`` is this value. Set to whatever slug
                          the proxy is wired to dispatch.
    SIDEKICK_AUDIO_LOG_FILE  optional path to a log file. Falls back to
                          ``/tmp/sidekick-audio.log`` if the bridge is
                          launched under systemd (so logs are still
                          tailable when journald isn't capturing this
                          unit for whatever reason). Set to empty
                          string to disable file logging.
    DEEPGRAM_API_KEY      required for the default deepgram STT provider
"""

from __future__ import annotations

import logging
import os
import sys

from aiohttp import web

from config import VoiceConfig
from signaling import register_routes


def main() -> None:
    level = os.environ.get("SIDEKICK_AUDIO_LOG_LEVEL", "INFO").upper()
    fmt = "%(asctime)s %(levelname)s %(name)s: %(message)s"
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stderr)]

    # File handler — defaults to /tmp/sidekick-audio.log so logs are
    # tailable even when user-level journald isn't capturing this unit
    # (observed 2026-04-27 — sidekick.service logs fine, sidekick-audio
    # silently doesn't). `tail -f` works regardless of journald state.
    log_file = os.environ.get("SIDEKICK_AUDIO_LOG_FILE", "/tmp/sidekick-audio.log")
    if log_file:
        try:
            handlers.append(logging.FileHandler(log_file))
        except Exception as e:
            print(f"[bridge] couldn't open {log_file}: {e}", file=sys.stderr)

    logging.basicConfig(level=level, format=fmt, handlers=handlers, force=True)

    host = os.environ.get("SIDEKICK_AUDIO_HOST", "127.0.0.1")
    port = int(os.environ.get("SIDEKICK_AUDIO_PORT", "8643"))
    proxy_url = os.environ.get("SIDEKICK_PROXY_URL", "http://127.0.0.1:3001")
    backend = os.environ.get("SIDEKICK_BACKEND", "hermes")

    voice_config = VoiceConfig.defaults()

    # aiohttp's default body limit is 1MB. /v1/transcribe receives raw
    # webm blobs from the PWA via the sidekick proxy — a 3-minute memo
    # is ~6MB, easily exceeding the default. Match the proxy's 25MB
    # ceiling (server.ts handleTranscribe) so the bridge accepts
    # whatever the proxy passes through. WebRTC SDP offers/ICE
    # candidates are tiny so this only affects the transcribe path.
    app = web.Application(client_max_size=25 * 1024 * 1024)
    register_routes(app, voice_config=voice_config, proxy_url=proxy_url, backend=backend)

    logging.getLogger(__name__).info(
        "starting sidekick audio bridge host=%s port=%d proxy=%s backend=%s",
        host, port, proxy_url, backend,
    )
    web.run_app(app, host=host, port=port, access_log=None)


if __name__ == "__main__":
    main()
