# Backends

ClawPortal's shell talks to a single backend adapter chosen at install
time via `SIDEKICK_BACKEND`. The adapter handles all wire-format
parsing + protocol specifics; the shell only sees normalized events.

See `types.mjs` for the full contract.

## Available adapters

| Name | Purpose | Capabilities |
|---|---|---|
| `openclaw` (default) | OpenClaw gateway — full feature set: sessions, model catalog, tool events (canvas cards), attachments, history backfill. | streaming, sessions, models, toolEvents, history, attachments |
| `openai-compat` | Any `/v1/chat/completions`-shaped endpoint — OpenAI, Ollama, LMStudio, Groq, vLLM, Together, Fireworks. Minimal: text streaming only, in-memory conversation, no sessions/models/tools/attachments. | streaming |
| `zeroclaw` | ZeroClaw gateway (Rust-native, low-memory — runs on a Pi 3). Browser talks to SideKick server, which proxies `/ws/zeroclaw` to the loopback-bound zeroclaw gateway at 127.0.0.1:42617. Emits `chunk` / `tool_call` / `tool_result` / `done` events; model is fixed at `onboard` time (no runtime picker yet). | streaming, sessions, toolEvents |

Adapters register in `src/backend.mjs`. The dispatcher dynamically
imports exactly one at startup.

## Configuration

Set in the server's `.env`:

```env
SIDEKICK_BACKEND=openclaw
# or:
SIDEKICK_BACKEND=openai-compat
SIDEKICK_OPENAI_COMPAT_URL=http://localhost:11434/v1/chat/completions  # Ollama default
SIDEKICK_OPENAI_COMPAT_KEY=                                            # empty for Ollama
```

For OpenAI direct:
```env
SIDEKICK_BACKEND=openai-compat
SIDEKICK_OPENAI_COMPAT_URL=https://api.openai.com/v1/chat/completions
SIDEKICK_OPENAI_COMPAT_KEY=sk-...
```

The server keeps the URL + key server-side and exposes `POST /api/chat`
to the client. No secrets reach the browser.

## Adding a new backend

1. Write `src/backends/myprovider.mjs` exporting an object matching the
   `BackendAdapter` shape.
2. Register the case in `src/backend.mjs` `loadAdapter()`.
3. If the backend needs server-side secret proxying (most cloud APIs
   do), add a handler in `server.mjs` behind a path the adapter uses.
4. Add the new paths to `sw.js` `APP_SHELL` so the service worker
   caches them.
5. Document in this README + in `.env.example`.

## Capability flags

Backends advertise what they support. The shell reads them and hides
UI controls whose backing feature isn't there:

- `streaming` — emits `onDelta` events (almost always true)
- `sessions` — has server-side persistent sessions with model overrides
- `models` — exposes `listModels()` (UI renders a picker when true)
- `toolEvents` — emits `onToolEvent` (canvas cards, function results)
- `history` — supports `fetchHistory()` for chat replay on load
- `attachments` — accepts image / media attachments in `sendMessage`

## Why one adapter per deployment

Install-time selection keeps the architecture simple: no runtime state
about "which backend is active now," no mid-session swap edge cases,
no compound UI that has to work for multiple contract surfaces at once.
Need to compare two backends? Run two instances on different ports.
