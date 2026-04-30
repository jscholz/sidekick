# Sidekick

Voice-first PWA frontend for agent backends. Designed to run on a Raspberry Pi or any Linux host, installed as a standalone home-screen app on iOS / Android / desktop Chrome.

Talks to any agent that speaks the abstract agent contract
(OpenAI-Responses-shaped HTTP+SSE — see
`docs/ABSTRACT_AGENT_PROTOCOL.md`). Ships with:

- **Hermes plugin** (`backends/hermes/plugin/`) — turns a hermes-agent install
  into a sidekick-compatible upstream. Supports cross-platform
  drawer (telegram, slack, whatsapp sessions surface alongside
  sidekick) via the `/v1/gateway/conversations` extension.
- **Stub agent** (`backends/stub/`) — standalone TypeScript reference
  implementation with echo / Gemini / Ollama LLM adapters. Run it
  on `localhost:4001` with `cd backends/stub && npm start` for
  hermes-free demos and tests.

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

### Configuration

Sidekick configuration spans **two surfaces**:

**1. Static on-disk** (set at deploy time, requires service restart to change)

- **`.env`** (gitignored) — secrets only: API keys, bearer tokens.
- **`sidekick.config.yaml`** (optional, gitignored) — non-secret deployment tuning: app name, theme, backend choice, preferred-models filter defaults, server port, etc. Every key here can be overridden by an env var of the matching name — handy for Docker/CI. Point sidekick at it via `SIDEKICK_CONFIG=/path/to/sidekick.config.yaml`.

Precedence: env vars > yaml > built-in default. See `.env.example` for the full annotated env var list and `sidekick.config.example.yaml` for the YAML schema.

**2. Tunable from the frontend** (live, no restart)

The Settings panel (gear icon, bottom-left of the sidebar) edits three categories of state, each stored in a different place:

| Category | Examples | Stored where |
|---|---|---|
| **Sidekick-owned, per-user** | theme, hotkeys, text size, mic device, TTS voice, audio feedback level, barge-in | browser `localStorage` (`sidekick.settings.v2`) — per-tab, syncs across tabs in the same browser |
| **Sidekick-owned, server-side** | preferred-models filter (chip input), STT keyterms | `sidekick.config.yaml` — chip UIs write back to `models.preferred` and `stt.keyterms` via the proxy. Keyterm chips also persist per-user in IDB (the yaml is just the first-launch seed). |
| **Agent-owned** | model picker, anything else the agent declares via `/v1/settings/schema` | upstream agent's persistence (e.g. backends/hermes/plugin writes the model setting back to `~/.hermes/config.yaml`). See [Agent settings](#agent-settings-v1settings) below. |

The split mirrors the architecture: settings the agent doesn't care about (theme, mic device) stay client-side; settings the agent owns (model, persona) round-trip through the agent contract; settings sidekick-the-deployment cares about (preferred-models filter, keyterms) live on the proxy.

The essentials:

| Variable | Required | What |
|---|---|---|
| `DEEPGRAM_API_KEY` | yes | Deepgram key — powers STT (audio-bridge: live + batch via `/transcribe`) and Aura TTS (`/tts`) |
| `SIDEKICK_PLATFORM_URL` | yes | Upstream agent URL (default `http://127.0.0.1:8645`). Hermes-plugin's HTTP server, the stub agent, or any `/v1/responses`-speaking server. |
| `SIDEKICK_PLATFORM_TOKEN` | yes | Bearer token shared with the upstream — matches `SIDEKICK_PLATFORM_TOKEN` in your `~/.hermes/.env` (hermes path) or your stub-agent invocation. |
| `GOOGLE_API_KEY` | no | Enables `/gen-image` (Gemini image gen) |
| `MAPS_EMBED_KEY` | no | Google Maps Embed API key for map cards |
| `OPENROUTER_API_KEY` | no | Populates the model picker (hermes) |
| `SIDEKICK_APP_NAME` | no | Display name (default `SideKick`) |
| `SIDEKICK_AGENT_LABEL` | no | Speaker label for agent bubbles / lockscreen |
| `SIDEKICK_THEME_PRIMARY` | no | Override the sage `--primary` CSS variable with any color |
| `PORT` | no | Defaults to 3001 |

## Backend setup

### Hermes (recommended)

Install Hermes via its [official guide](https://github.com/NousResearch/hermes-agent), then drop the bundled plugin in:

```bash
ln -s "$(pwd)/backends/hermes/plugin" ~/.hermes/plugins/sidekick
echo "SIDEKICK_PLATFORM_TOKEN=$(openssl rand -hex 32)" >> ~/.hermes/.env
```

Apply the one-time hermes-core patch (registers `Platform.SIDEKICK`):
```bash
cd <your hermes-agent install>
patch -p1 < <sidekick-repo>/backends/hermes/plugin/0001-add-sidekick-platform.patch
```

Restart hermes-gateway. Sidekick's drawer, replay, delete, attachments, and cross-platform views (telegram/slack/whatsapp sessions surface alongside sidekick) all work out of the box.

See `backends/hermes/README.md` for full install instructions, hermes-side config keys (`backends/hermes/config.example.yaml`), and a description of which contract pieces this backend implements.

### Stub agent (no hermes required)

Useful for development and demos. Full install + LLM-adapter docs in
`backends/stub/README.md`. tl;dr:

```bash
cd backends/stub && npm start
# port 4001, echo LLM by default
# Set AGENT_LLM=gemini + GEMINI_API_KEY (or AGENT_LLM=ollama) to swap
```

Then point sidekick at it:

```bash
export SIDEKICK_PLATFORM_URL=http://127.0.0.1:4001
export SIDEKICK_PLATFORM_TOKEN=     # stub runs open-mode by default
npm start
```

### Any `/v1/responses`-speaking server

Sidekick consumes the abstract agent contract (`docs/ABSTRACT_AGENT_PROTOCOL.md`). Any server that implements `POST /v1/responses` (streaming SSE), `GET /v1/conversations*`, `DELETE /v1/conversations/{id}`, and `GET /v1/events` drops in. Two optional extensions add features without changing the core contract:

- `/v1/gateway/conversations` — cross-platform drawer (sessions from telegram/slack/whatsapp surface alongside sidekick).
- `/v1/settings/*` — agent-declared user-facing knobs (model picker, persona, temperature, etc.). See below.

### Agent settings (`/v1/settings/*`)

Agents can declare their own user-facing settings and have sidekick render them generically in the **Settings → Agent** group. The agent owns both the catalog of options and the validation logic; the PWA just renders.

Two endpoints, both optional:

| Endpoint | Purpose |
|---|---|
| `GET /v1/settings/schema` | List of `SettingDef` the agent supports. 404 = "doesn't implement extension" — sidekick hides the agent group. |
| `POST /v1/settings/{id}` | Update one setting (`{value: <new>}`). Returns the updated def. 400 propagates to a UI revert + error message. |

`SettingDef` shape (full spec in `docs/ABSTRACT_AGENT_PROTOCOL.md`):

```json
{
  "id": "model",
  "label": "Model",
  "description": "LLM used for replies",
  "category": "Agent",
  "type": "enum",          // | "slider" | "toggle" | "text"
  "value": "anthropic/claude-opus-4-6",
  "options": [             // enum only
    { "value": "anthropic/claude-opus-4-6", "label": "Claude Opus 4.6" }
  ]
}
```

The backends/hermes/plugin upstream declares the model picker as one entry that wraps `~/.hermes/config.yaml` + the openrouter catalog (filtered by `SIDEKICK_PREFERRED_MODELS` env). Adding more knobs (persona, default provider, max-tokens) is purely additive in `backends/hermes/plugin/__init__.py:_build_settings_schema`.

The in-tree stub agent (`backends/stub/src/server.mjs`) declares one `model` enum reflecting the configured LLM — a minimal reference impl for forks. Settings the PWA owns (theme, hotkeys, mic, TTS voice) stay in their original groups; the schema is for **agent-owned** settings only.

The settings panel re-fetches the schema on **open and close** so changes from parallel clients (CLI, sibling tab) surface without an explicit refresh.

## Deepgram keyterm biasing

Custom vocabulary — names, project codes, product terms — is stored **per user** in the browser's IndexedDB. Manage via **Settings → STT keyterms** in the UI (type-Enter chips). Changes take effect on the next mic-stream start.

For multi-user / fork deployments, the seed list lives in `sidekick.config.yaml` under `stt.keyterms` (a YAML list). The PWA fetches it on first boot to seed each user's IDB; edits to the yaml affect future first-launches only — existing users keep whatever they've curated.

## Architecture

Sidekick is a **four-process system**: a browser PWA, a Node proxy,
a Python audio bridge, and a separate agent upstream. The PWA, proxy,
and bridge are sidekick code. The agent is whatever you point
upstream at (backends/hermes/plugin, the in-tree stub, or any third-party
`/v1/*`-speaking server).

The PWA only ever talks to the proxy and the audio bridge — never to
the agent directly. The bridge only ever talks to the proxy.

```
                    ┌─────────────────────────────────────────┐
                    │ Browser (PWA)                            │
                    │   src/                                   │
                    │   - chat surface, drawer, composer       │
                    │   - chat_id minted in IDB                │
                    │   - one persistent SSE channel inbound   │
                    └────────────┬────────────────────┬────────┘
                                 │                    │
                          HTTP+SSE                  WebRTC
                          /api/sidekick/*           (audio bytes only)
                                 │                    │
                                 ▼                    ▼
              ┌──────────────────────────┐    ┌────────────────────────┐
              │ Sidekick proxy           │    │ Audio bridge            │
              │   (Node, server.ts)      │◀───│   (Python, aiortc)      │
              │                          │    │                         │
              │ - serves static assets   │    │ - terminates WebRTC     │
              │ - serves /api/sidekick/* │    │   from PWA              │
              │ - translates             │    │ - STT: Deepgram (etc.)  │
              │   /api/sidekick/* ↔      │    │ - TTS: Deepgram Aura    │
              │   /v1/*                  │    │   (etc.)                │
              │ - SSE multiplexer (mem)  │    │                         │
              │ - utility endpoints      │    │ Posts recognized text   │
              │   (/gen-image, /weather, │    │ to proxy at             │
              │   /link-preview)         │    │ /api/sidekick/messages, │
              │ - injects auth tokens    │    │ subscribes to           │
              │   for upstream calls     │    │ /api/sidekick/stream,   │
              │                          │    │ converts reply_delta to │
              │ Owns no durable state.   │    │ TTS audio over WebRTC.  │
              └────────────┬─────────────┘    └────────────────────────┘
                           │
                    HTTP+SSE
                    /v1/responses
                    /v1/conversations*
                    /v1/events
                           │
                           ▼
              ┌──────────────────────────┐
              │ Upstream agent            │
              │   any /v1/*-speaking      │
              │   server, e.g. one of:    │
              │   - backends/hermes/      │
              │     (Python plugin into   │
              │     hermes-agent)         │
              │   - backends/stub/        │
              │     (in-tree TS, echo /   │
              │     gemini / ollama)      │
              │   - any 3rd-party         │
              │     OpenAI-compat         │
              │                           │
              │ Owns ALL agent state      │
              │ (sessions, transcripts,   │
              │ memory).                  │
              └───────────────────────────┘
```

**Two transport lanes from the PWA**, both terminating in the user's
browser: text via SSE on `/api/sidekick/stream`, audio via WebRTC.
Different transport for different content type. Both originate from
the proxy — text directly, audio after the bridge's TTS pipeline
transforms `reply_delta` envelopes into Aura chunks.

**Wire contracts**:
- `/api/sidekick/*` — the PWA-and-bridge-facing surface served by the
  proxy. Fully agent-agnostic. POST messages, GET drawer rows, GET a
  persistent SSE multiplexer, DELETE chats.
- `/v1/*` — the upstream-facing surface the proxy speaks to whichever
  agent it's wired to. OAI Responses-shaped, plus a sidekick-defined
  `/v1/gateway/conversations` extension for cross-platform drawer.
  See [`docs/ABSTRACT_AGENT_PROTOCOL.md`](docs/ABSTRACT_AGENT_PROTOCOL.md).

**Information flow for a typed turn:**

1. PWA sends `POST /api/sidekick/messages` to proxy.
2. Proxy forwards `POST /v1/responses` (with `stream: true`) to upstream.
3. Upstream streams `response.output_text.delta` events.
4. Proxy fans those into the persistent `/api/sidekick/stream` SSE
   channel as `reply_delta` envelopes.
5. PWA renders the streaming reply bubble.
6. Upstream emits `response.completed`; proxy emits `reply_final`.

**Information flow for a voice turn:**

1. PWA opens a WebRTC peer connection to the audio bridge.
2. Bridge streams mic audio to STT, gets transcripts.
3. On end-of-utterance (silence-detect or commit-phrase), bridge POSTs
   the recognized text to the proxy's `/api/sidekick/messages`.
4. Bridge subscribes to `/api/sidekick/stream` (scoped to the same
   `chat_id`) for the agent's reply.
5. As `reply_delta` envelopes arrive, bridge synthesizes TTS audio
   chunks and streams them back over the WebRTC connection.

**Drawer state**:

- The PWA's drawer cache lives in IDB and is the immediate-render path.
- The proxy queries the upstream's `GET /v1/conversations` to populate
  the server-authoritative list. Reconciles into the IDB cache.
- Deletes cascade end-to-end: PWA → proxy → upstream → upstream's
  ancillary stores (transcript files, vector-store memory, etc.).

**Why the audio bridge is a separate process:** WebRTC audio
processing (aiortc + STT/TTS pipelines) lives on a long-lived Python
process so it survives PWA reloads and isolates audio failure modes
from the proxy. The bridge talks to the proxy via the same
`/api/sidekick/*` HTTP surface the PWA uses — no special channel.

**Why the proxy exists at all (vs. PWA → upstream direct):**

- **Reusable contract.** Any `/v1/*`-speaking server fits the same
  shape (hermes plugin, stub, future openclaw plugin, raw OAI
  third-parties). A new backend just speaks the contract from
  whatever language it's in.
- **Decouples app server from agent runtime.** Hermes restarts (or
  GIL stalls) don't take down the chat UI; static asset serving
  keeps working. The proxy is single-purpose Node, fast to restart.
- **Centralized auth.** The browser never holds the upstream bearer
  token; the proxy injects it on every outbound call.
- **Multiplexing.** PWA sees one persistent `/api/sidekick/stream`
  even when there are N concurrent chats with reply streams in
  flight. The proxy translates that to per-turn `/v1/responses`
  streams against the upstream and fans envelopes back tagged with
  `chat_id`. The PWA doesn't model per-request streams.
- **Utility endpoints.** `/gen-image`, `/weather`, `/link-preview`,
  `/transcribe` — none of these belong in an agent backend, but they
  belong somewhere. The proxy is that somewhere.

The proxy owns no durable state. That stays in the upstream.

For the agent contract (what an upstream MUST implement to be a
sidekick backend), see [`docs/ABSTRACT_AGENT_PROTOCOL.md`](docs/ABSTRACT_AGENT_PROTOCOL.md).
For the refactor history that landed the current architecture, see
[`docs/SIDEKICK_BACKEND_REFACTOR.md`](docs/SIDEKICK_BACKEND_REFACTOR.md).

## Build + test

Authoring is **TypeScript-only**, both for the PWA (`src/**/*.ts`)
and for the proxy (`server.ts`, `proxy/**/*.ts`). There's no
separate transpile step at runtime — the proxy runs under Node 22's
`--experimental-strip-types` flag, which strips type annotations on
the fly with zero overhead. The PWA needs a real bundle (browsers
don't run TS), so `node scripts/build.mjs` runs esbuild over
`src/**/*.ts` and emits `build/**/*.mjs`. `npm start` runs the build
then starts the proxy.

Tests come in two flavors:

- **Unit (`npm test`)** — node:test against TS files, ~120 tests
  across the proxy + small parsers + voice state machines. Mocked
  external boundaries.
- **Smoke (`npm run smoke`)** — Playwright against a real Chromium
  pointed at the running proxy on `localhost:3001`. A `mock-backend`
  layer sits between the proxy and an imaginary upstream so smoke
  scenarios don't depend on hermes being up. About 25 scenarios
  covering UX-level invariants (drawer rendering, chat-switch races,
  empty-chat cleanup, SSE envelope routing, etc.).

Playwright pulls double duty: smoke tests run on top of it, AND the
proxy uses it for the `/screenshot` endpoint that powers link-preview
cards. One headless Chromium binary, two consumers.

## Modules

Top-level layout:

```
sidekick/
├── server.ts                 proxy entry point
├── proxy/                    proxy-side TS (handlers, upstream client)
│   ├── sidekick/                /api/sidekick/* PWA-facing routes
│   ├── preferred-models.ts       chip-list filter (yaml-backed)
│   └── generic/                  shared utilities
├── src/                      PWA (browser) code; see breakdown below
├── audio-bridge/             Python WebRTC bridge (STT + TTS + barge-in)
├── backends/                 each subdirectory = one /v1/*-speaking agent
│   ├── README.md                "what's here, how to add a backend"
│   ├── stub/                    in-tree TS reference impl (echo / gemini / ollama)
│   └── hermes/
│       ├── plugin/                Python plugin loaded into hermes-agent
│       ├── README.md              install + which contract pieces it implements
│       └── config.example.yaml    annotated subset of ~/.hermes/config.yaml
├── scripts/                  build + smoke runner + start-all
├── docs/                     ABSTRACT_AGENT_PROTOCOL, FRONTEND_ARCHITECTURE, ...
├── styles/                   app.css + manifest
├── sw.js                     service worker (PWA app-shell cache)
├── install.sh                one-command Mac/Linux installer (curl-pipe-bash)
└── sidekick.config.example.yaml   copy to sidekick.config.yaml + fill in
```

PWA breakdown:

```
src/
├── main.ts              entry — boots modules, wires cross-module callbacks
├── config.ts            runtime config loaded from /config, applies skinning
├── backend.ts           adapter loader — single proxy-client path
├── proxyClient.ts       calls /api/sidekick/* on the local Node proxy.
│                        Fully agent-agnostic; the proxy translates to
│                        /v1/* on its end.
├── proxyClientTypes.ts  BackendAdapter contract types
├── agentSettings.ts     generic SettingDef[] renderer for the agent's
│                        /v1/settings/* contract (model picker etc.)
├── chat.ts              transcript rendering + sessionStorage persistence
├── sessionDrawer.ts     past-conversations list, rename/delete, IDB cache
├── sessionCache.ts      IndexedDB cache for instant tap-to-resume
├── settings.ts          persistent settings (localStorage), model picker
├── draft.ts             unsent-voice-transcript block (live interim + commit)
├── attachments.ts       composer image picker + chips + model-capability gate
├── wakeLock.ts          ref-counted Screen Wake Lock (shared across owners)
├── queue.ts             IndexedDB outbox (audio blobs + text messages)
├── voiceMemos.ts        memo persistence (IndexedDB) + waveform extraction
├── memoCard.ts          memo card rendering (play, waveform, transcript)
├── ios/
│   ├── fakeLock.ts          pocket-lock overlay (swipe-to-unlock, mic meter)
│   └── audio-unlock.ts      AudioContext + gesture-unlock for iOS
├── audio/
│   ├── capture.ts           shared MediaStream owner (memo + streaming)
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
└── cards/                   inline cards — validates structured envelopes
    │                         from the agent (link previews, YouTube/Spotify
    │                         embeds, image grids, markdown tables, loading
    │                         placeholders) and renders them as rich blocks
    │                         inside agent bubbles. NOT a shared editing
    │                         surface — that's the conventional "canvas" in
    │                         other chat apps. The wire protocol still uses
    │                         `canvas.show` event names (matching hermes
    │                         core's existing tool naming); the dir name
    │                         here is the more accurate one.
    ├── attach.ts            inline attach helper — validate + render into agent bubbles
    ├── registry.ts          card-kind registry
    ├── validate.ts          envelope + kind-specific validation
    ├── validators.ts        per-kind validator table the proxy reuses for
    │                        the /canvas/show POST endpoint
    └── kinds/               image, youtube, spotify, links, markdown, loading
```

## Caveats

- **iOS PWA background audio**: installed PWAs get some lockscreen / headset-tap latitude via Media Session; they do **not** get microphone access while backgrounded. Pocket-lock is the workaround — keeps the tab foreground so mic/TTS/barge-in keep working under a fake lockscreen.
- **Chrome desktop local TTS**: SpeechSynthesis has long-standing bugs around cancel+speak (crbug/521818) and 15s idle auto-pause. Works on iOS / macOS Safari; on Chrome use the server Deepgram Aura path.
- **iOS premium voices**: Web Speech only exposes the built-in voice bank. Evan / Alison / other premium voices are reserved for native apps via AVSpeechSynthesizer.

## Development

```bash
npm test           # node:test suite (~120 unit tests)
npm run typecheck  # tsc --noEmit
npm run build      # esbuild src/**/*.ts → build/**/*.mjs
npm run smoke      # Playwright UX smoke (~25 scenarios; needs proxy running)
```

See **Build + test** above for what each step does and why.

Enable diagnostic logs: `?debug=1` in the URL, or `localStorage.sidekick_debug = '1'` in devtools. High-frequency logs (mic peaks, audio route dumps, draft appends, lifecycle events) are silent by default.

Keyboard shortcuts:
- `Ctrl+Shift+D` — toggle the debug panel
- triple-tap the header — same, on mobile
- `Ctrl/Cmd+Enter` — send from the draft block
- `Esc` — blur the draft (resume voice append) / cancel memo recording

## License

Apache License 2.0 — see [`LICENSE`](LICENSE).
