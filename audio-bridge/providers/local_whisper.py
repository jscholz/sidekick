"""
Placeholder: faster-whisper / whisper.cpp STT provider.

NOT YET IMPLEMENTED.  This file exists so the next contributor finds the
contract in the obvious place and so selecting ``provider: local_whisper``
in config.yaml fails with a clear NotImplementedError instead of an
opaque KeyError.

Skeleton (uncomment + fill):

    from faster_whisper import WhisperModel
    from .stt import STTProvider, Transcript, register_stt_provider
    from ..config import ProviderSpec

    class LocalWhisperSTT(STTProvider):
        def __init__(self, spec: ProviderSpec) -> None:
            model_name = str(spec.options.get("model", "base.en"))
            device = str(spec.options.get("device", "cpu"))
            compute_type = str(spec.options.get("compute_type", "int8"))
            self._model = WhisperModel(model_name, device=device,
                                        compute_type=compute_type)

        async def stream(self, pcm_iter):
            # faster-whisper is offline.  Buffer ~2 s of PCM, run
            # transcribe(), yield Transcript(text=..., is_final=True).
            # Use VAD (Silero or webrtcvad) to mark utterance boundaries.
            ...

        async def transcribe(self, audio: bytes, mime: str) -> str:
            # Decode <mime> -> 16 kHz mono PCM (ffmpeg/av), run the
            # offline whisper model, return the joined text.  Keep the
            # whitespace normalization identical to deepgram.py so live
            # + memo paths produce matching bubbles.
            ...

        async def aclose(self):
            pass

    register_stt_provider("local_whisper", LocalWhisperSTT)

When you wire this up, also pull the [voice] extra into the [webrtc]
extra in pyproject.toml so installs that opt into local STT get the
faster-whisper dep automatically.
"""

from .stt import register_stt_provider
from config import ProviderSpec


def _factory(spec: ProviderSpec):
    raise NotImplementedError(
        "local_whisper STT provider is a placeholder; see "
        "audio-bridge/providers/local_whisper.py for the "
        "skeleton."
    )


register_stt_provider("local_whisper", _factory)
