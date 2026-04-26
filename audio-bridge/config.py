"""
WebRTC voice configuration.

Reads the ``voice:`` block from ``~/.hermes/config.yaml``::

    voice:
      stt:
        provider: deepgram          # or local_whisper (stub), openai (future)
        api_key_env: DEEPGRAM_API_KEY
        # provider-specific options under model/extras keys
        model: nova-3
        language: en-US
      tts:
        provider: deepgram_aura
        api_key_env: DEEPGRAM_API_KEY
        voice: aura-2-thalia-en

If the section is absent we default to Deepgram nova-3 + Aura — the same
defaults used by the classic sidekick pipeline today, so the WebRTC mode
behaves identically out of the box.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

DEFAULT_STT_PROVIDER = "deepgram"
DEFAULT_TTS_PROVIDER = "deepgram_aura"

DEFAULT_STT_MODEL = "nova-3"
DEFAULT_STT_LANGUAGE = "en-US"
DEFAULT_TTS_VOICE = "aura-2-thalia-en"


@dataclass
class ProviderSpec:
    """Selection record for one STT/TTS provider."""

    provider: str
    api_key_env: Optional[str] = None
    options: Dict[str, Any] = field(default_factory=dict)

    def get_api_key(self) -> Optional[str]:
        """Resolve the API key from the configured env var, if any."""
        if not self.api_key_env:
            return None
        return os.environ.get(self.api_key_env) or None


@dataclass
class VoiceConfig:
    """Resolved WebRTC voice settings."""

    stt: ProviderSpec
    tts: ProviderSpec
    bind_host: str = "0.0.0.0"
    # Whether the gateway should advertise the rtc routes at all.  Disabling
    # this lets you take the routes off the API surface without uninstalling
    # aiortc.
    enabled: bool = True

    @classmethod
    def defaults(cls) -> "VoiceConfig":
        return cls(
            stt=ProviderSpec(
                provider=DEFAULT_STT_PROVIDER,
                api_key_env="DEEPGRAM_API_KEY",
                options={"model": DEFAULT_STT_MODEL, "language": DEFAULT_STT_LANGUAGE},
            ),
            tts=ProviderSpec(
                provider=DEFAULT_TTS_PROVIDER,
                api_key_env="DEEPGRAM_API_KEY",
                options={"voice": DEFAULT_TTS_VOICE},
            ),
        )


def _build_provider_spec(
    raw: Dict[str, Any] | None,
    *,
    default_provider: str,
    default_api_key_env: Optional[str],
    default_options: Dict[str, Any],
) -> ProviderSpec:
    raw = dict(raw or {})
    provider = str(raw.pop("provider", default_provider) or default_provider)
    api_key_env = raw.pop("api_key_env", default_api_key_env)
    if api_key_env is not None:
        api_key_env = str(api_key_env) or None

    # Whatever's left is provider-specific options, merged on top of defaults.
    options = dict(default_options)
    options.update(raw)

    return ProviderSpec(
        provider=provider,
        api_key_env=api_key_env,
        options=options,
    )


def load_voice_config(raw: Dict[str, Any] | None) -> VoiceConfig:
    """Build a VoiceConfig from the ``voice:`` slice of config.yaml.

    Tolerates a missing or partial section by falling back to defaults.
    Pass the parsed YAML dict directly (the value of the ``voice`` key, or
    ``None`` if absent).
    """
    base = VoiceConfig.defaults()
    if not raw:
        return base

    if not isinstance(raw, dict):
        logger.warning("voice config not a mapping: %r — using defaults", type(raw))
        return base

    bind_host = str(raw.get("bind_host", base.bind_host) or base.bind_host)
    enabled = bool(raw.get("enabled", True))

    stt = _build_provider_spec(
        raw.get("stt"),
        default_provider=base.stt.provider,
        default_api_key_env=base.stt.api_key_env,
        default_options=base.stt.options,
    )
    tts = _build_provider_spec(
        raw.get("tts"),
        default_provider=base.tts.provider,
        default_api_key_env=base.tts.api_key_env,
        default_options=base.tts.options,
    )

    return VoiceConfig(stt=stt, tts=tts, bind_host=bind_host, enabled=enabled)
