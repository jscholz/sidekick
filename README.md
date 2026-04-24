# Sidekick

Voice-first PWA frontend for agent backends. Designed to run on a Raspberry Pi or any Linux host, installed as a standalone home-screen app on iOS / Android / desktop Chrome.

Ships with adapters for:
- **[Hermes Agent](https://github.com/NousResearch/hermes-agent)** (default) — OpenAI-compatible Responses API + SSE streaming
- **[OpenClaw](https://github.com/openclaw/openclaw)** — original WebSocket gateway
- **[ZeroClaw](https://github.com/zeroclaw-labs/zeroclaw)** — experimental
- Any **OpenAI-compatible** server (bring your own URL + key)

**Features**
- Streaming speech-to-text with Deepgram + automatic Web Speech API fallback
- Deepgram Aura TTS with barge-in (the user interrupts by speaking)
- Local TTS fallback (on-device voices) as a privacy/offline option
- Session drawer — browse, resume, rename, delete past conversations (backends that support it)
- Cross-channel sessions — when the agent runs multiple messaging platforms (Telegram, WhatsApp, etc.), those conversations surface in the drawer too
- Inline card renderers: link previews, YouTube/Spotify embeds, images, markdown tables, loading states
- Offline outbox — queue messages and voice memos when the backend is unreachable; auto-flush on reconnect
- Pocket-lock overlay for bike / in-pocket use (mic/TTS stay live, touches absorbed)
- Ambient clock + weather widget in the corner; tap to expand into a HUD
- Attachments: camera + image picker, with model-capability gating

## Run it

```bash
cp .env.example .env       # fill in DEEPGRAM_API_KEY at minimum
npm install
npm start
```

Then open `http://localhost:3001` (install as a PWA from the browser menu for full lockscreen / background-audio support).

The default backend is Hermes. See [Backend setup](#backend-setup) below.

### Environment

See `.env.example` for the full annotated list. The essentials:

| Variable | Required | What |
|---|---|---|
| `DEEPGRAM_API_KEY` | yes | Deepgram key — powers both STT (`/ws/deepgram`, `/transcribe`) and Aura TTS (`/tts`) |
| `SIDEKICK_BACKEND` | no | `hermes` (default), `openclaw`, `zeroclaw`, or `openai-compat` |
| `SIDEKICK_HERMES_URL` | no | Hermes API URL (default `http://127.0.0.1:8642`) |
| `SIDEKICK_HERMES_TOKEN` | hermes only | Bearer token matching Hermes's `API_SERVER_KEY` |
| `SIDEKICK_HERMES_STATE_DB` | hermes only | Path to `~/.hermes/state.db` for session reads |
| `SIDEKICK_HERMES_STORE_DB` | hermes only | Path to `~/.hermes/response_store.db` |
| `SIDEKICK_HERMES_CLI` | hermes only | Path to the `hermes` CLI (for rename / delete) |
| `GW_TOKEN` | openclaw only | Bearer token for the OpenClaw WS gateway |
| `GOOGLE_API_KEY` | no | Enables `/gen-image` (Gemini image gen) |
| `MAPS_EMBED_KEY` | no | Google Maps Embed API key for map cards |
| `OPENROUTER_API_KEY` | no | Populates the model picker (hermes) |
| `SIDEKICK_APP_NAME` | no | Display name (default `SideKick`) |
| `SIDEKICK_AGENT_LABEL` | no | Speaker label for agent bubbles / lockscreen |
| `SIDEKICK_THEME_PRIMARY` | no | Override the sage `--primary` CSS variable with any color |
| `PORT` | no | Defaults to 3001 |

## Backend setup

### Hermes (default)

Install Hermes via its [official guide](https://github.com/NousResearch/hermes-agent). Sidekick's default configuration assumes:

- Hermes API on `127.0.0.1:8642` (the `hermes-gateway` systemd unit's default)
- Session/response databases at `~/.hermes/state.db` and `~/.hermes/response_store.db`
- `hermes` CLI on `$PATH` (usually `~/.local/bin/hermes`)

Put the matching paths in `.env`. The session drawer, model picker, and resume flows all work out of the box.

### OpenClaw

Set `SIDEKICK_BACKEND=openclaw` and point `GW_TOKEN` at your gateway token. Sidekick assumes the gateway listens on `wss://<same-host>:18789/ws`. See [openclaw](https://github.com/openclaw/openclaw) for setup.

### OpenAI-compatible

Set `SIDEKICK_BACKEND=openai-compat`, then `SIDEKICK_OPENAI_COMPAT_URL`, `_KEY`, and `_MODEL`. Any server that serves the OpenAI Responses API will work.

### ZeroClaw

Experimental. Set `SIDEKICK_BACKEND=zeroclaw`, `SIDEKICK_ZEROCLAW_WS`, and `SIDEKICK_ZEROCLAW_TOKEN`.

## Deepgram keyterm biasing

Custom vocabulary — names, project codes, product terms — live in `keyterms.txt` (gitignored). One term per line, `#` starts a comment.

```bash
cp keyterms.example.txt keyterms.txt
$EDITOR keyterms.txt   # add your terms
# refresh the browser — no service restart needed
```

Or edit through the UI: **Settings → STT keyterms**. Terms are saved as chips backed by the same file.

## Architecture

```
browser (PWA)  ──HTTP──▶  sidekick server  ──HTTP──▶  agent backend
     │                          │                     (hermes / openclaw / …)
     │          ┌───────────────┤
     │          │               │
     │    /tts /transcribe   /gen-image /weather /link-preview
     │
     └──WS──▶  sidekick server  ──WS──▶  deepgram
```

`server.ts` is the only Node process. It serves the static app shell, proxies Deepgram (keeping keys server-side), relays to whichever agent backend is configured, and exposes a few small utility endpoints.

The build step is `node scripts/build.mjs` — esbuild strips TypeScript/JSDoc annotations and emits `src/**/*.ts` → `build/**/*.mjs` for the browser. `npm start` runs build + serve.

## Modules

```
src/
├── main.ts              entry — boots modules, wires cross-module callbacks
├── config.ts            runtime config loaded from /config, applies skinning
├── backend.ts           adapter loader — picks by SIDEKICK_BACKEND
├── backends/
│   ├── types.ts             BackendAdapter contract
│   ├── hermes.ts            Hermes Agent (OpenAI Responses API + SSE)
│   ├── openclaw.ts          OpenClaw WS gateway
│   ├── openai-compat.ts     any Responses-API-compatible server
│   └── zeroclaw.ts          ZeroClaw
├── chat.ts              transcript rendering + sessionStorage persistence
├── sessionDrawer.ts     past-conversations list, rename/delete, IDB cache
├── sessionCache.ts      IndexedDB cache for instant tap-to-resume
├── settings.ts          persistent settings (localStorage), model picker
├── draft.ts             unsent-voice-transcript block (live interim + commit)
├── attachments.ts       composer image picker + chips + model-capability gate
├── fakeLock.ts          pocket-lock overlay (swipe-to-unlock, mic meter)
├── wakeLock.ts          ref-counted Screen Wake Lock (shared across owners)
├── queue.ts             IndexedDB outbox (audio blobs + text messages)
├── voiceMemos.ts        memo persistence (IndexedDB) + waveform extraction
├── memoCard.ts          memo card rendering (play, waveform, transcript)
├── audio/
│   ├── capture.ts           shared MediaStream owner (memo + streaming)
│   ├── unlock.ts            AudioContext + gesture-unlock for iOS
│   ├── session.ts           Media Session + audioSession.type + silent keepalive
│   ├── memo.ts              MediaRecorder-based dictation bar
│   ├── micMeter.ts          per-frame peak meter for barge-in + UI
│   └── feedback.ts          UI feedback blips (send / receive)
├── pipelines/
│   └── classic/             Deepgram + Aura voice pipeline
│       ├── voice.ts             Deepgram result handler
│       ├── deepgram.ts          streaming STT (WS + local webkitSpeechRecognition)
│       ├── tts.ts               sentence-chunked TTS (Aura + SpeechSynthesis)
│       ├── bargeIn.ts           mic-peak evaluator + AudioWorklet setup
│       ├── sttBackfill.ts       recover from mid-utterance STT drops
│       └── replyPlayer.ts       playback queue, skipTo, playback icons
└── canvas/
    ├── attach.ts            inline attach helper — validate + render into agent bubbles
    ├── registry.ts          card-kind registry
    ├── validate.ts          envelope + kind-specific validation
    └── cards/               image, youtube, spotify, links, markdown, loading
```

## Caveats

- **iOS PWA background audio**: installed PWAs get some lockscreen / headset-tap latitude via Media Session; they do **not** get microphone access while backgrounded. Pocket-lock is the workaround — keeps the tab foreground so mic/TTS/barge-in keep working under a fake lockscreen.
- **Chrome desktop local TTS**: SpeechSynthesis has long-standing bugs around cancel+speak (crbug/521818) and 15s idle auto-pause. Works on iOS / macOS Safari; on Chrome use the server Deepgram Aura path.
- **iOS premium voices**: Web Speech only exposes the built-in voice bank. Evan / Alison / other premium voices are reserved for native apps via AVSpeechSynthesizer.

## Development

```bash
npm test           # node:test suite
npm run typecheck  # tsc --noEmit over TS + JSDoc annotations
npm run build      # esbuild src/**/*.ts → build/**/*.mjs
```

Enable diagnostic logs: `?debug=1` in the URL, or `localStorage.sidekick_debug = '1'` in devtools. High-frequency logs (mic peaks, audio route dumps, draft appends, lifecycle events) are silent by default.

Keyboard shortcuts:
- `Ctrl+Shift+D` — toggle the debug panel
- triple-tap the header — same, on mobile
- `Ctrl/Cmd+Enter` — send from the draft block
- `Esc` — blur the draft (resume voice append) / cancel memo recording

## License

TBD — the intent is to open-source as a public frontend. Until a `LICENSE` file is added here, treat this as "all rights reserved" for upstream redistribution.
