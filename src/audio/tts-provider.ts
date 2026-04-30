/**
 * @fileoverview TTS (text-to-speech) provider abstraction.
 *
 * Vendor-neutral interface for spoken replies. Sidekick's primary TTS
 * path today is the WebRTC "talk" mode (server adds an outbound TTS
 * track to the peer connection answer SDP, audio plays through a
 * hidden <audio srcObject> element — see
 * `src/pipelines/webrtc/connection.ts`). The legacy chunked-synthesis
 * client path used `POST /tts` (server.ts proxy) but the in-tree
 * playback module that consumed it is gone; the proxy endpoint
 * remains as a future seam.
 *
 * The interface here captures the minimum a future client-side or
 * peer-track-driven TTS implementation needs to expose so callers
 * (composer "speak this" actions, future replay buttons) don't bind
 * directly to a vendor API. Concrete implementations land alongside
 * their transports; e.g. a `WebRTCTTSProvider` would be the talk-mode
 * peer-connection wrapper, and a hypothetical `HTTPTTSProvider` would
 * call `POST /tts` and play the returned audio through Web Audio.
 *
 * Like `STTProvider`, this contract is intentionally narrow: enough to
 * unbind sidekick from any specific vendor at the call site; not a
 * full audio pipeline.
 */

/** Unsubscribe handle returned by listener-registering methods. */
export type Unsubscribe = () => void;

/** State of a TTS playback session. Granularity is deliberately
 *  coarse — finer-grained per-chunk progress is implementation-
 *  specific and not part of the contract. */
export type TTSPlaybackState =
  | 'idle'        // no playback in flight
  | 'synthesizing' // request issued, audio not yet playing
  | 'playing'     // audio is currently audible
  | 'paused'      // user (or barge) paused playback
  | 'error';      // synth or playback failed

/** Lifecycle for a streaming TTS provider.
 *
 *   speak(text, opts) requests synthesis + playback of `text`. If a
 *                     prior speak is still playing, implementations
 *                     MAY queue or interrupt — see provider docs.
 *                     Resolves when the audio has finished playing
 *                     (or rejects on error / cancel).
 *   cancel()          stops any in-flight playback and clears the
 *                     queue. Idempotent — safe to call when idle.
 *   onState(cb)       registers a state listener. Returns an
 *                     unsubscribe function.
 */
export interface TTSProvider {
  speak(text: string, opts?: { voice?: string }): Promise<void>;
  cancel(): Promise<void>;
  onState(cb: (state: TTSPlaybackState) => void): Unsubscribe;
}
