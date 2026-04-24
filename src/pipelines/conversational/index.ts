/**
 * @fileoverview Conversational pipeline — stub.
 *
 * This file intentionally does nothing today. It reserves the shape for
 * the Live-native pipeline (Gemini Live / OpenAI Realtime / similar).
 * See this directory's README.md for the design sketch.
 *
 * When implemented, this module will export the same kind of entry
 * points the classic pipeline does (start/stop mic, handle backend
 * reply events as no-ops, playback event surface), and a small
 * `src/pipeline.ts` dispatcher will pick between classic and
 * conversational based on the backend's `conversationalVoice` capability.
 */

export const placeholder = null;
