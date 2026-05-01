# Conversational pipeline (stub)

**Not implemented yet.** Design notes live in the project tracker; this
README captures the touchpoints a future implementation should hit.

## What this pipeline would do

Route raw audio frames from the mic directly to a backend that speaks
a bidirectional audio protocol (Gemini Live, OpenAI Realtime, etc.),
and render the audio that comes back out of the speaker — no client-
side STT, no client-side TTS.

The backend exposes a WebSocket. Client opens a session, streams 16-bit
PCM frames upward, receives PCM frames + transcript chunks + tool-call
events downward.

## What it wouldn't do

- Synthesize TTS per reply (server does it)
- Run client-side barge-in VAD (server has its own interrupt detection)
- Chunked reply-scrub playback UI (Live's audio is a continuous stream,
  not discrete chunks — skip per decision in the product spike doc)
- Reply replay via cached AudioBuffer (punted per spike doc)

## Contract touchpoints

A future implementation should:

1. Export `startListening(stream)` / `stopListening()` — opens/closes
   the backend's audio session. The shell's mic button calls these.
2. Subscribe to backend transcript events (both input and output
   transcription) and route them into the existing draft / transcript
   UI. Chat bubbles still exist in conversational mode; they just have
   no play button.
3. Ignore `onBackendDelta` / `onBackendFinal` from the BackendAdapter —
   the backend doesn't emit those in conversational mode. It emits
   transcript events as a side-channel.
4. Bridge interruption: server VAD decides when the user has started
   speaking; the client just observes.
5. Handle session limits (Gemini Live = 15 min audio) — mint a new
   session transparently, optionally with a handoff message so the
   user's context carries over.

## Getting started when it's time

Recommended order of operations:

1. Write a 200-line standalone Gemini Live client as a sanity check —
   pure WS, pure audio in/out, no app integration. Validate the
   protocol shape in isolation.
2. Add a `src/geminilive.ts` adapter with `capabilities.
   conversationalVoice: true`. Standard chat methods can no-op or
   throw — the shell never calls them because it'll take the
   conversational dispatch branch.
3. Build this module with the entry points above.
4. Create `src/pipeline.ts` dispatcher that reads the backend's
   `conversationalVoice` flag and lazy-loads `pipelines/classic/` or
   `pipelines/conversational/` as appropriate.
5. Feature flag the whole thing until it's proven on a real commute.
