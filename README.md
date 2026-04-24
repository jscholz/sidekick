# ClawPortal

Voice-first PWA frontend for [OpenClaw](https://github.com/openclaw/openclaw). Designed to run on a Raspberry Pi or any Linux host, installed as a standalone home-screen app on iOS / Android / desktop Chrome.

**Features**
- Streaming speech-to-text with Deepgram + automatic Web Speech API fallback
- Deepgram Aura TTS with barge-in (the user interrupts by speaking)
- Local TTS fallback (on-device voices) as a privacy/offline option
- Inline card renderers: link previews, YouTube/Spotify embeds, images, markdown tables, loading states
- Offline outbox — queue messages and voice memos when the gateway is unreachable; auto-flush on reconnect
- Pocket-lock overlay for bike / in-pocket use (mic/TTS stay live, touches absorbed)
- Ambient clock + weather widget in the corner; tap to expand into a HUD
- Attachments: camera + image picker, with model-capability gating

## Run it

```bash
npm install
DEEPGRAM_API_KEY=xxx  GW_TOKEN=xxx  npm start
```

Then open `http://localhost:3001` (install as a PWA from the browser menu for full lockscreen / background-audio support).

ClawPortal expects an [OpenClaw](https://github.com/openclaw/openclaw) gateway reachable at `wss://<same-host>:18789/ws`. See OpenClaw's own quickstart for how to stand one up.

### Environment

| Variable | Required | What |
|---|---|---|
| `DEEPGRAM_API_KEY` | yes | Deepgram key — powers both streaming (`/ws/deepgram`) and batch (`/transcribe`) STT and Aura TTS (`/tts`) |
| `GW_TOKEN` | no | Bearer token for the OpenClaw gateway. Leave empty if your gateway has auth disabled |
| `GOOGLE_API_KEY` | no | Enables `/gen-image` (Gemini image gen) — the app runs fine without it |
| `MAPS_EMBED_KEY` | no | Google Maps Embed API key for map cards |
| `PORT` | no | Defaults to 3001 |
| `SIDEKICK_APP_NAME` | no | Display name in the toolbar + browser tab (default `ClawPortal`) |
| `SIDEKICK_AGENT_LABEL` | no | Speaker label for agent bubbles / lockscreen (default `Clawdian`, i.e. the default `messages.responsePrefix` in openclaw.json) |
| `SIDEKICK_STT_KEYTERMS` | no | Comma-separated proper nouns for Deepgram keyterm biasing. Additive to `keyterms.txt` (file is the normal home — see below). |
| `SIDEKICK_WEATHER_LAT` | no | Default latitude for the ambient weather widget (fallback: London, 51.5074) |
| `SIDEKICK_WEATHER_LON` | no | Default longitude (fallback: -0.1278) |

The app assumes an OpenClaw gateway is reachable at `wss://<same-host>:18789/ws`. See [openclaw](https://github.com/openclaw/openclaw) for how to stand that up.

### Deepgram keyterm biasing

Custom vocabulary — names, project codes, product terms — live in
`apps/sidekick/keyterms.txt`. One term per line, `#` starts a comment.

```bash
cp keyterms.example.txt keyterms.txt
$EDITOR keyterms.txt   # add your terms
# refresh the browser — no service restart needed
```

The file is gitignored so your personal vocabulary stays local. The
committed `keyterms.example.txt` is the template. Server re-reads the
file on every `/config` request, so edits take effect on the next
browser refresh.

Users can also add browser-session-specific terms via **Settings → STT
keyterms** (stored in localStorage, additive to the file). Edit the
file for durable / cross-device terms; use the UI field for one-offs.

## Architecture

```
browser (PWA)  ──WS──▶  sidekick server  ──WS──▶  deepgram
     │                        │
     │         ┌──────────────┤
     │         │              │
     │    /tts /transcribe   /gen-image /weather /link-preview
     │
     └──WS──▶  openclaw gateway (port 18789)
```

`server.mjs` is the only Node process. It serves the static app shell, proxies Deepgram (keeping keys server-side), and exposes a few small utility endpoints (weather, link previews, screenshots). The browser talks to the OpenClaw gateway directly over WebSocket for chat.

No bundler, no build step. `src/` is plain ES modules loaded by the browser.

## Modules

```
src/
├── main.mjs          entry — boots modules, wires cross-module callbacks
├── gateway.mjs       OpenClaw gateway WebSocket (chat.send, events)
├── chat.mjs          transcript rendering + sessionStorage persistence
├── settings.mjs      persistent settings (localStorage), models.list, /model
├── draft.mjs         unsent-voice-transcript block (live interim + commit)
├── voice.mjs         Deepgram result handler (commit-word, barge-in cooldown)
├── attachments.mjs   composer image picker + chips + model-capability gate
├── fakeLock.mjs      pocket-lock overlay (swipe-to-unlock, mic meter)
├── queue.mjs         IndexedDB outbox (audio blobs + text messages)
├── voiceMemos.mjs    memo persistence (IndexedDB) + waveform extraction
├── memoCard.mjs      memo card rendering (play, waveform, transcript)
├── audio/
│   ├── unlock.mjs        AudioContext + gesture-unlock for iOS
│   ├── session.mjs       Media Session + audioSession.type + silent keepalive
│   ├── deepgram.mjs      streaming STT (server WS + local webkitSpeechRecognition)
│   ├── bargeIn.mjs       mic-peak evaluator + AudioWorklet setup
│   ├── tts.mjs           sentence-chunked TTS (Aura server + SpeechSynthesis local)
│   ├── feedback.mjs      UI feedback blips (send / receive)
│   └── memo.mjs          MediaRecorder-based dictation bar
└── canvas/
    ├── attach.mjs        inline attach helper — validate + render into agent bubbles
    ├── registry.mjs      card-kind registry
    ├── validate.mjs      envelope + kind-specific validation
    ├── validators.mjs    per-kind payload schemas
    ├── fallback.mjs      text → card extraction (when agent didn't use CLI)
    └── cards/            image, youtube, spotify, links, markdown, loading
```

## Caveats

- **iOS PWA background audio**: installed PWAs get some lockscreen / headset-tap latitude via Media Session; they do **not** get microphone access while backgrounded. Pocket-lock is the workaround — keeps the tab foreground so mic/TTS/barge-in keep working under a fake lockscreen.
- **Chrome desktop local TTS**: SpeechSynthesis has long-standing bugs around cancel+speak (crbug/521818) and 15s idle auto-pause. Works on iOS / macOS Safari; on Chrome use the server Deepgram Aura path.
- **iOS premium voices**: Web Speech only exposes the built-in voice bank. Evan / Alison / other premium voices are reserved for native apps via AVSpeechSynthesizer.

## Development

```bash
npm test           # node:test suite (commit-word, fallback, markdown, pipeline, validate)
npm run typecheck  # tsc --noEmit over JSDoc annotations
```

Enable diagnostic logs: `?debug=1` in the URL, or `localStorage.sidekick_debug = '1'` in devtools. High-frequency logs (mic peaks, audio route dumps, draft appends, lifecycle events) are silent by default.

Keyboard shortcuts:
- `Ctrl+Shift+D` — toggle the debug panel
- triple-tap the header — same, on mobile
- `Ctrl/Cmd+Enter` — send from the draft block
- `Esc` — blur the draft (resume voice append) / cancel memo recording

## License

TBD — the intent is to open-source alongside OpenClaw. Until a `LICENSE` file is added here, treat this as "all rights reserved" for upstream redistribution.
