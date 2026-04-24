/**
 * @fileoverview Audio pipeline contract.
 *
 * The pipeline is "what happens between the microphone and the speaker"
 * — it owns the voice loop and the reply-playback UX, and it consumes
 * backend reply events (chat.delta/final from BackendAdapter).
 *
 * Two shapes are meaningful for Sidekick:
 *
 *  1. Classic (3-phase): client-side STT → backend chat → client-side
 *     chunked TTS + per-bubble playback controls. Physical location:
 *     `src/pipelines/classic/`.
 *
 *  2. Conversational (Live-native): client forwards raw audio to the
 *     backend over a bidirectional audio WS; backend streams audio
 *     back. No separate client STT or TTS stages. Physical location:
 *     `src/pipelines/conversational/` (stub today).
 *
 * The two pipelines do NOT share runtime code — a Live-only deploy can
 * delete `pipelines/classic/` and rebuild; a classic-only deploy can
 * delete `pipelines/conversational/`. Shared audio primitives (mic
 * capture, AudioContext unlock, MediaSession, mic-peak notifier, audio
 * feedback sounds) live in `src/audio/` and both pipelines depend on them.
 *
 * This file is JSDoc only — the interface is currently aspirational
 * rather than enforced as a single facade, because the classic pipeline
 * is spread across multiple modules (tts/stt/replyCache/replyPlayer/
 * voice/bargeIn/sttBackfill) and a unified-facade refactor would be
 * large for marginal benefit. The shell imports what it needs directly
 * from whichever pipeline directory is active.
 *
 * When the conversational pipeline gets a real implementation, this file
 * will likely grow an explicit facade typedef + a `loadPipeline()`
 * dispatcher in `src/pipeline.ts` mirroring `src/backend.ts`.
 */

// ─── Pipeline contract ──────────────────────────────────────────────────────

/**
 * What every pipeline must be able to do. (Not all entry points are called
 * by the shell in every mode — e.g. a conversational pipeline ignores the
 * backend-reply hooks because the backend's audio stream IS the reply.)
 *
 * @typedef {Object} AudioPipeline
 *
 * @property {() => Promise<void>} init
 *   Called once at boot. Pipeline wires up DOM listeners, loads worklets,
 *   subscribes to settings, etc.
 *
 * @property {(stream: MediaStream) => Promise<void>} startListening
 *   Mic button pressed. Classic: start STT session. Conversational: open
 *   audio WS to backend.
 *
 * @property {() => Promise<void>} stopListening
 *
 * @property {(ev: import('../backends/types.js').DeltaEvent) => void} [onBackendDelta]
 *   Classic: feed cumulative text to chunked TTS. Conversational: no-op.
 *
 * @property {(ev: import('../backends/types.js').FinalEvent) => void} [onBackendFinal]
 *   Classic: finalize TTS synthesis + cache. Conversational: no-op (the
 *   audio stream IS the reply).
 *
 * @property {(reason: string) => void} [stopPlayback]
 *   Stop whatever the pipeline is currently playing / synthesising.
 *
 * @property {() => 'idle' | 'playing' | 'paused' | 'ended' | 'stopped'} [getPlaybackState]
 *
 * @property {(event: string, fn: Function) => void} [on]
 * @property {(event: string, fn: Function) => void} [off]
 */

// ─── Capability flags ──────────────────────────────────────────────────────

/**
 * Advertised at pipeline-load time so the shell can hide UI that doesn't
 * apply to the active pipeline (e.g. per-bubble scrub bars make no sense
 * for conversational).
 *
 * @typedef {Object} PipelineCapabilities
 * @property {boolean} clientSideStt   - Runs STT locally + produces text deltas the shell displays as a draft.
 * @property {boolean} clientSideTts   - Synthesises reply audio client-side per chunk.
 * @property {boolean} replayableReplies - Each reply has a retrievable audio blob (scrub bar, cache hits).
 * @property {boolean} interruptsLocally - Client-side barge-in detector (vs. server-side VAD).
 */

export {};
