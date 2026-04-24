# Sidekick

Voice-first chat UI — a PWA for talking to any AI agent over HTTP/SSE.

Install, point it at your agent (Hermes, an OpenAI-compatible endpoint,
or one you wrote an adapter for), and get a phone-friendly voice + text
interface with session management, streaming mic, and a Gemini-style
sidebar.

Sidekick is agent-agnostic by design: the shell speaks a normalized
event stream (`onDelta` / `onFinal` / `onToolEvent` / ...). A small
`BackendAdapter` module bridges the shell to whichever backend you pick.

## Quick start

```bash
git clone https://github.com/jscholz/sidekick.git
cd sidekick
npm install
DEEPGRAM_API_KEY=<your-key> npm start
# open http://localhost:3001
```

That boots the default backend (`openclaw`). Swap to an OpenAI-compatible
endpoint:

```bash
SIDEKICK_BACKEND=openai-compat \
  SIDEKICK_OPENAI_COMPAT_URL=http://localhost:11434/v1/chat/completions \
  DEEPGRAM_API_KEY=<your-key> \
  npm start
```

Install it as a PWA from the browser menu for full lockscreen /
background-audio support on iOS and Android.

## What's in the box

- Voice capture — `MediaRecorder` voice memos + streaming Deepgram STT
  for live dictation, with a Web Speech API fallback.
- Voice playback — Deepgram Aura TTS with barge-in (user interrupts by
  speaking); falls back to on-device `SpeechSynthesis`.
- Session browser — list, rename, delete, replay past conversations
  (when the backend supports it).
- iOS PWA install — standalone display, wake-lock, Media Session
  lockscreen controls, pocket-lock overlay for bike / in-pocket use.
- Inline card renderers — link previews, YouTube / Spotify embeds,
  images, markdown, loading placeholders; the agent can push these via
  a simple `canvas.show` protocol.
- Offline outbox — queue messages + voice memos when the server or
  backend is unreachable; auto-flush on reconnect.
- Skinning — app name, subtitle, theme color, agent label all driven
  by env vars, no code changes needed to rebrand.
- Settings panel — model picker, voice picker, keyterm biasing.

## The BackendAdapter contract

All agent integration happens through a `BackendAdapter` — a small
interface defined in [`src/backends/types.ts`](src/backends/types.ts).
Write one to plug in your agent. Four are bundled:

| Adapter | Purpose |
|---|---|
| `hermes` | Hermes Agent via its OpenAI-compatible `/v1/responses` + SSE endpoint. Full session browser. |
| `openclaw` | Legacy OpenClaw gateway (WebSocket-based). Full feature set. |
| `openai-compat` | Any OpenAI-compatible `/v1/chat/completions` — OpenAI, Ollama, LMStudio, Groq, vLLM, Together, Fireworks. Streaming only. |
| `zeroclaw` | ZeroClaw gateway (low-memory Rust agent). |

See [`src/backends/README.md`](src/backends/README.md) for the full
adapter contract — method semantics, capability flags, event shapes,
and a `my-agent` stub you can copy.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│ browser (PWA)                                            │
│                                                          │
│  ┌─ shell (chat, voice, canvas, sessions, settings) ─┐   │
│  │                                                   │   │
│  │     subscribes to normalized events ▼             │   │
│  └────────── BackendAdapter ─────────────────────────┘   │
│                  │                                       │
└──────────────────┼───────────────────────────────────────┘
                   │  HTTP / SSE / WS
                   ▼
┌──────────────────────────────────────────────────────────┐
│ sidekick server (Node)                                   │
│                                                          │
│  /config  /tts  /transcribe  /ws/deepgram                │
│  /link-preview  /screenshot  /render  /weather           │
│                                                          │
│  server/plugins/hermes.ts ◀── opt-in backend plugin      │
│  (delete if targeting a different backend)               │
└──────────────────┬───────────────────────────────────────┘
                   │
                   ▼
         ┌─────────────────────┐
         │ your agent backend  │  (Hermes, OpenAI-compat,
         │                     │   your own, ...)
         └─────────────────────┘
```

The Node server proxies secrets (Deepgram key, Hermes token,
OpenAI-compat key) so the browser never holds them. The shell is
plain ES modules compiled 1:1 from `src/` into `build/` — no bundler.

## Skinning

Fork the repo, set env vars, done:

| Env var | What |
|---|---|
| `SIDEKICK_APP_NAME` | Title bar + browser tab + install name |
| `SIDEKICK_APP_SUBTITLE` | Tagline under the title |
| `SIDEKICK_AGENT_LABEL` | Speaker label for agent bubbles / lockscreen metadata |
| `SIDEKICK_THEME_PRIMARY` | Primary CSS color (hex / rgb / hsl) |

All four are reapplied to the DOM at boot — `src/config.ts`
`applySkinning()`.

## Deployment

Run under `systemd` or any process supervisor. Minimum env for the
default backend:

```env
DEEPGRAM_API_KEY=...        # required for voice
GW_TOKEN=                   # openclaw gateway token (empty if disabled)
SIDEKICK_BACKEND=openclaw   # or hermes, openai-compat, zeroclaw
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for dev setup + test commands.

Reverse-proxy notes: sidekick listens on HTTP by default; terminate
TLS upstream (Caddy, nginx, Tailscale Funnel, Cloudflare Tunnel,
etc.). The PWA install path requires a trusted HTTPS origin.

## Status

Early. API surfaces (adapter contract, canvas protocol, server routes)
may still shift. Pin a commit for production. See `git log` for the
running changelog.

## License

Apache-2.0. See [`LICENSE`](LICENSE).
