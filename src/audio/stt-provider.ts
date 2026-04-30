/**
 * @fileoverview STT (speech-to-text) provider abstraction.
 *
 * Vendor-neutral interface for streaming transcription. Today the only
 * implementation is `WebRTCSTTProvider` (in
 * `src/pipelines/webrtc/connection.ts`) which routes mic frames through
 * the audio-bridge to a server-managed STT service. Tests can ship a
 * `MockSTTProvider` that fires synthetic transcript events directly,
 * without WebRTC or any real STT backend.
 *
 * The interface is intentionally small — just enough to drive the
 * dictation state machines (`dictate.ts` for cursor-aware injection,
 * `dictation.ts` for silence/commit-phrase auto-dispatch). It is NOT
 * a full audio pipeline contract; mic acquisition, TTS playback, data-
 * channel dispatch etc. remain implementation concerns of the concrete
 * provider.
 *
 * Event shape matches the current data-channel envelope from
 * `connection.ts` so existing handlers work unchanged when an
 * STTProvider is dropped in.
 */

/** A single transcript event from the STT pipeline. Both interim
 *  (in-flight, may be revised) and final segments use this shape; the
 *  `is_final` flag distinguishes them. `role` distinguishes user
 *  speech (mic) from any side-channel transcripts the provider may
 *  surface (e.g. assistant TTS captions in talk mode). */
export interface TranscriptEvent {
  type: 'transcript';
  text: string;
  is_final: boolean;
  role: 'user' | 'assistant';
}

/** Unsubscribe handle returned by `onTranscript`. Calling it removes
 *  the listener; safe to call multiple times. */
export type Unsubscribe = () => void;

/** Lifecycle + transcript surface for a streaming STT provider.
 *
 *   start(opts) opens the upstream session (mic capture, peer
 *               connection, etc. depending on impl) and begins
 *               feeding audio. Resolves once the pipe is hot.
 *   stop()      closes the session. Idempotent — safe to call when
 *               not started.
 *   onTranscript(cb)
 *               registers a transcript listener. Returns an
 *               unsubscribe function. Multiple listeners are NOT
 *               required by the contract — implementations may
 *               support a single listener and replace on each call.
 *               Callers that need fan-out should multiplex above this
 *               layer.
 */
export interface STTProvider {
  start(opts?: { sessionId?: string | null; chatId?: string | null }): Promise<void>;
  stop(): Promise<void>;
  onTranscript(cb: (ev: TranscriptEvent) => void): Unsubscribe;
}
