"""
Placeholder: piper TTS provider.

NOT YET IMPLEMENTED.  See local_whisper.py for the analogous skeleton.

Outline:

    import piper  # or shell out to a piper binary
    from .tts import TTSProvider, register_tts_provider
    from ..config import ProviderSpec

    class LocalPiperTTS(TTSProvider):
        def __init__(self, spec: ProviderSpec) -> None:
            self._model_path = spec.options["model_path"]
            self._voice = piper.PiperVoice.load(self._model_path)
            self._sample_rate = int(spec.options.get("sample_rate", 16000))

        async def synth(self, text_iter):
            buf = ""
            async for piece in text_iter:
                buf += piece
                # flush on sentence boundaries (see deepgram_aura.py for
                # the sentence-split helper); call self._voice.synthesize
                # in a thread executor to avoid blocking the event loop;
                # yield raw int16 PCM bytes
                ...

        async def aclose(self):
            pass

    register_tts_provider("local_piper", LocalPiperTTS)

You'll likely also want to expose a simple sample-rate-conversion path
since piper's models are 22.05 kHz natively but the bridge expects 16 kHz.
"""

from .tts import register_tts_provider
from config import ProviderSpec


def _factory(spec: ProviderSpec):
    raise NotImplementedError(
        "local_piper TTS provider is a placeholder; see "
        "audio-bridge/providers/local_piper.py for the "
        "skeleton."
    )


register_tts_provider("local_piper", _factory)
