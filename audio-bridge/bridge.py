"""
Sidekick audio bridge — standalone aiohttp service.

This is the reference Python/aiortc implementation of the sidekick audio
bridge contract (see SIDEKICK_AUDIO_PROTOCOL.md in hermes-agent-private
for the wire format). It owns:

  - WebRTC peer connection lifecycle (offer / answer / ICE / close)
  - Opus → 16 kHz PCM resampling
  - STT provider stream (Deepgram nova-3 default)
  - DataChannel events (transcripts, future control messages)
  - (Talk mode) TTS provider PCM → outbound RTP track

The bridge does NOT talk to the agent backend directly.  All sidekick
→ agent traffic flows through the sidekick proxy, which is the sole
gateway. The bridge POSTs utterances to ``<SIDEKICK_PROXY_URL>/api/hermes/responses``
and streams the SSE reply back over the data channel as transcript
envelopes.

Environment variables:

    SIDEKICK_AUDIO_HOST   bind host (default 127.0.0.1)
    SIDEKICK_AUDIO_PORT   bind port (default 8643)
    SIDEKICK_PROXY_URL    sidekick proxy base URL (default http://127.0.0.1:3001)
    DEEPGRAM_API_KEY      required for the default deepgram STT provider
"""

from __future__ import annotations

import logging
import os

from aiohttp import web

from config import VoiceConfig
from signaling import register_routes


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("SIDEKICK_AUDIO_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    host = os.environ.get("SIDEKICK_AUDIO_HOST", "127.0.0.1")
    port = int(os.environ.get("SIDEKICK_AUDIO_PORT", "8643"))
    proxy_url = os.environ.get("SIDEKICK_PROXY_URL", "http://127.0.0.1:3001")

    voice_config = VoiceConfig.defaults()

    app = web.Application()
    register_routes(app, voice_config=voice_config, proxy_url=proxy_url)

    logging.getLogger(__name__).info(
        "starting sidekick audio bridge host=%s port=%d proxy=%s",
        host, port, proxy_url,
    )
    web.run_app(app, host=host, port=port, access_log=None)


if __name__ == "__main__":
    main()
