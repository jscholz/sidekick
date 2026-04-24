# Audio pipelines

ClawPortal dispatches the voice loop through one of two "audio pipelines"
— the module cluster that owns mic-in → speaker-out. The shell
(`src/main.mjs`, transcript, attachments, settings, pocket-lock,
ambient, canvas) is pipeline-agnostic.

## The two shapes

### `classic/` — 3-phase

Client owns STT (Deepgram WS or Web Speech fallback), text streams to
the backend, backend returns text deltas, client synthesises TTS
chunk-by-chunk (Deepgram Aura via `/tts`) and plays via AudioBuffer
sequencing. Per-bubble playback UI: scrub bar, pause/resume, replay,
reply cache.

Files:
- `tts.mjs` — chunked synthesis + playback state machine
- `deepgram.mjs` — streaming STT orchestrator (wraps providers)
- `providers/webspeech.mjs` — Web Speech API STT provider
- `bargeIn.mjs` — sliding-window peak VAD for interruption
- `sttBackfill.mjs` — retry queue for audio dropped during WS outages
- `wav.mjs` — WAV header encoder for backfill / memo uploads
- `voice.mjs` — STT result → draft text + commit-word detection
- `replyCache.mjs` — in-memory LRU of synthesised AudioBuffers
- `replyPlayer.mjs` — per-bubble play/pause/scrub UI wiring

### `conversational/` — Live-native (stub)

Client streams raw audio directly to the backend over a bidirectional
WebSocket; backend returns audio. No client-side STT or TTS. Server-side
VAD handles interruption. Currently a stub — see its own README.

## Why two, not one unified pipeline

See `docs/gemini-live-vs-three-phase.md` in the monorepo for the
product-feature comparison. Short version: the two models optimise for
different things (latency, cost, offline, tool-call latency, privacy,
reliability). A single PWA wants to offer both so the user can route
between them without changing apps.

## Picking one

Currently the classic pipeline is the only implementation — it's what
loads unconditionally. When `pipelines/conversational/` gains a real
impl, a small `src/pipeline.mjs` dispatcher (mirroring `src/backend.mjs`)
will read a capability flag from the backend (`conversationalVoice:
true`) and load the right pipeline.

## Shared audio primitives

Not pipeline-specific. Stay in `src/audio/`:
- `unlock.mjs` — iOS AudioContext gesture-unlock
- `session.mjs` — MediaSession integration for lockscreen / BT headset
- `audio-processor.js` — AudioWorklet for mic peak + buffer
- `micMeter.mjs` — pub/sub for mic peak UI feedback
- `feedback.mjs` — click / receive sound effects
- `memo.mjs` — voice-memo MediaRecorder path (its own UX, not a pipeline)
