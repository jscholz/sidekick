# Classic pipeline (3-phase)

Mic → STT (client) → text → backend → text deltas → TTS (client,
chunked) → speaker. Per-reply playback controls with scrubbing, pause/
resume, and an in-memory reply cache so each reply can be replayed
instantly.

## Entry points from the shell

The shell imports these directly (no facade — see the parent `README.md`
for why). Adding a facade is a future refactor if the surface grows.

| What the shell needs | Module |
|---|---|
| Begin / push / end a streaming reply for TTS | `tts.mjs` |
| Pause / resume / seek / replay current reply | `tts.mjs` |
| Start / stop mic streaming | `deepgram.mjs` |
| Subscribe to playback events (play-start, progress, ended) | `tts.mjs` `.on/.off` |
| STT result → draft integration | `voice.mjs` |
| Per-bubble playback UI | `replyPlayer.mjs` |
| Reply cache hit/miss (for the sage-play-icon badge) | `replyCache.mjs` |

## Internal architecture

- `deepgram.mjs` dispatches to one of:
  - Deepgram WS (this module's own logic — reconnect, wedge detection,
    server-side VAD keyterm biasing)
  - `providers/webspeech.mjs` — browser's Web Speech API
- `bargeIn.mjs` runs a shared sliding-window peak VAD against mic frames
  from the AudioWorklet. Used by both DG mode and the webspeech provider
  (since SR's mic is opaque).
- `sttBackfill.mjs` ring-buffers raw audio so DG drops can be retried
  after reconnect — extends the effective reliability of the WS STT.
- `tts.mjs` chunks the reply text at sentence boundaries, kicks off
  synthesis for each chunk in parallel, plays them in order via
  AudioBufferSourceNodes. State machine handles pause/seek/replay.
- `replyCache.mjs` LRU-caches the synthesised AudioBuffers keyed on
  `replyId` so a user clicking play again is instant.
- `replyPlayer.mjs` subscribes to tts events to drive the bubble UI.

## Removing this pipeline

For a Live-native fork that never needs 3-phase: delete this entire
directory, delete the imports in `src/main.mjs` and `src/fakeLock.mjs`,
and the shell will still build (after stubbing the call sites — see the
comment markers in main.mjs around `handleReplyDelta` / `handleReplyFinal`
/ the mic button handler). The shared `src/audio/*` primitives stay.
