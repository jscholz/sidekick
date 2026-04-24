# Audio providers

Sidekick's speech-to-text and text-to-speech paths both dispatch through
provider modules in this directory. The goal is: adding a new STT/TTS
backend is a drop-in module, not a surgical edit of the orchestrator.

## Contracts

See `types.mjs` for the full JSDoc definitions. Summary:

### STT provider

```js
{
  name: 'myprovider',
  isAvailable: () => boolean,            // fast runtime feature check
  async start({
    stream,            // MediaStream from shared mic
    audioCtx,          // optional — use if you need an AudioWorklet
    onResult(r),       // fire with { transcript, isFinal, words? }
    onError(err),      // optional
    isTtsActive(),     // optional — gate mic-touching starts during TTS
  }) => STTSession | null
}
```

The returned session has `stop()` and optional `pauseForTts()` /
`resumeAfterTts()` hooks. The orchestrator (`audio/deepgram.mjs`) calls
these when TTS starts/ends so providers with their own internal mic
capture (like Web Speech) can avoid a feedback loop.

### TTS provider

```js
{
  name: 'myprovider',
  isAvailable: () => boolean,
  synthesize({ text, voice, signal }) => Promise<Blob>,
}
```

The orchestrator chunks reply text at sentence boundaries for low
first-byte latency, then calls `synthesize` per chunk. Audio bytes go
through `AudioContext.decodeAudioData`; playback sequencing is the
orchestrator's job, not the provider's.

## Available providers

| File | Type | Role |
|---|---|---|
| `webspeech.mjs` | STT | Browser's Web Speech API. Works offline, no word-level timings, iOS-great / Chrome-decent / Firefox-unsupported. Reference implementation. |
| (Deepgram STT lives in `../deepgram.mjs`) | STT | Server-proxied Deepgram WS. Has its own reconnect/wedge/backfill machinery too intertwined to extract cleanly. Treat as "the complex provider." |
| (Aura TTS lives in `../tts.mjs` + `server.mjs /tts`) | TTS | Server-proxied Deepgram Aura. See `handleTts` in `../../server.mjs`. |

The orchestrators (`audio/deepgram.mjs` for STT dispatch, `audio/tts.mjs`
for TTS dispatch) are the only things that know which providers exist.
To add one, drop a file here, export a module matching the contract, and
register it in the orchestrator's provider map.

## Why this shape

- **One factory per provider, session object per call.** Keeps module-
  level state out of the provider — tests and parallel instances work.
- **Optional methods on the session.** Providers that don't need TTS
  coordination just omit `pauseForTts`/`resumeAfterTts`; the orchestrator
  uses `?.()`.
- **Normalized result shape.** `STTResult` is provider-agnostic.
  Providers translate from their wire format (DG's `channel.alternatives`,
  Web Speech's `SpeechRecognitionEvent`, etc.) at the edge.
- **No UI touching.** Providers only log + emit results; status strings
  and DOM are the orchestrator's job.

## Adding a new provider — checklist

1. New module in this directory. Implement the contract.
2. Wire it into `apps/sidekick/src/audio/deepgram.mjs` (STT) or
   `audio/tts.mjs` (TTS) as a new branch of the provider selector.
3. Add its id to the settings picker in `index.html` + `settings.mjs`.
4. Add it to `sw.js` `APP_SHELL` so the service worker caches it.
5. Tests — a unit test of `isAvailable` + a mocked `start` contract
   check is usually enough.
