/**
 * @fileoverview Provider contract for speech-to-text and text-to-speech
 * backends. Anything in `providers/` must conform to these shapes; the
 * orchestrator modules (`audio/deepgram.ts` for streaming, `audio/tts.ts`
 * for playback) dispatch to whichever provider is configured.
 *
 * Rationale: the PWA should be usable against different vendors (Deepgram,
 * Whisper, ElevenLabs, the browser's own Web Speech APIs, etc.) without
 * editing the orchestration code. Adding a new provider = drop a module
 * that exports one of the shapes below; register it in the provider map
 * in the orchestrator.
 */

// ─── STT ────────────────────────────────────────────────────────────────────

/**
 * One normalized result event from any STT provider. Providers must emit
 * this shape regardless of their wire protocol. Word-level timing is
 * optional and only populated by providers that return it (Deepgram yes,
 * Web Speech no).
 *
 * @typedef {Object} STTResult
 * @property {string} transcript
 * @property {boolean} isFinal - true once the provider considers the
 *   segment stable; interim results stream before this.
 * @property {Array<{ word: string, start?: number, end?: number, speaker?: number }>} [words]
 */

/**
 * Options passed to `STTProvider.start`. Providers are allowed to ignore
 * any field they don't care about (e.g. Web Speech manages its own mic,
 * so it ignores `stream`; Deepgram uses `stream` to tap the AudioWorklet).
 *
 * @typedef {Object} STTStartOptions
 * @property {MediaStream} stream - Shared mic stream from the orchestrator.
 * @property {AudioContext} [audioCtx] - Shared AudioContext (for providers
 *   that want to attach an AudioWorklet).
 * @property {(result: STTResult) => void} onResult - Fired per interim /
 *   final recognition event.
 * @property {() => void} [onUtteranceEnd] - Fired when the provider
 *   considers an utterance over (e.g. end-of-speech silence, SR session
 *   end). Deepgram's wire protocol emits this natively; Web Speech
 *   synthesizes it on `onend`. Lets voice.ts promote orphaned interims.
 * @property {(err: string) => void} [onError] - Fired on unrecoverable
 *   provider errors. The orchestrator may try a different provider.
 * @property {() => boolean} [isTtsActive] - True while TTS is playing.
 *   Providers that use the same mic (like Web Speech) should defer start
 *   to avoid picking up their own TTS output (feedback-loop bug).
 */

/**
 * Handle to a running STT session. All fields are optional except `stop`;
 * orchestrator calls are no-ops if the provider doesn't implement them.
 *
 * @typedef {Object} STTSession
 * @property {() => void} stop - Tear down the session and release mic.
 * @property {() => void} [pauseForTts] - Called when TTS starts. Provider
 *   should pause its own mic capture if any (e.g. Web Speech aborts the
 *   SpeechRecognition; Deepgram is a no-op, the orchestrator gates frame
 *   sends via isSpeaking()).
 * @property {() => void} [resumeAfterTts] - Complement to `pauseForTts`.
 */

/**
 * STT provider contract. Single factory function; each call to `start`
 * produces a new independent session.
 *
 * @typedef {Object} STTProvider
 * @property {string} name - Short identifier (e.g. "deepgram", "webspeech").
 *   Used in logs and in the `streamingEngine` setting.
 * @property {() => boolean} isAvailable - Fast check for runtime support
 *   (e.g. `'SpeechRecognition' in window`). Orchestrator uses this to
 *   skip providers that wouldn't work in the current browser.
 * @property {(opts: STTStartOptions) => Promise<STTSession | null>} start -
 *   Returns null if provider can't start for non-fatal reasons (unsupported,
 *   transient failure). The orchestrator may try another provider.
 */

// ─── TTS ────────────────────────────────────────────────────────────────────

/**
 * Single chunk to synthesize. The orchestrator chunks agent replies at
 * sentence boundaries for low first-byte latency; providers are called
 * once per chunk.
 *
 * @typedef {Object} TTSSynthOptions
 * @property {string} text
 * @property {string} [voice] - Provider-specific voice ID. Each provider
 *   has its own vocabulary here (e.g. Aura voice slugs, SpeechSynthesis
 *   voice names); the UI picks per-provider.
 * @property {AbortSignal} [signal] - For cancellation if the user stops
 *   TTS mid-synthesis.
 */

/**
 * TTS provider contract.
 *
 * @typedef {Object} TTSProvider
 * @property {string} name
 * @property {() => boolean} isAvailable
 * @property {(opts: TTSSynthOptions) => Promise<Blob>} synthesize -
 *   Returns encoded audio (mp3 / ogg / whatever the provider outputs).
 *   The orchestrator decodes via AudioContext.decodeAudioData and
 *   handles playback sequencing.
 */

// JSDoc-only module — no runtime exports.
export {};
