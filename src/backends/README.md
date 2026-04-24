# Backends

Sidekick's shell talks to one backend adapter chosen at install time via
`SIDEKICK_BACKEND`. The adapter handles all wire-format parsing + protocol
specifics; the shell only sees normalized events.

This README walks through the adapter contract and the checklist for
writing your own.

## Bundled adapters

| Name | Purpose | Capabilities |
|---|---|---|
| `hermes` | Hermes Agent via OpenAI-compatible `/v1/responses` + SSE. | streaming, sessions, sessionBrowsing, models, toolEvents, history, attachments |
| `openclaw` (default) | OpenClaw gateway (WebSocket). Full feature set. | streaming, sessions, models, toolEvents, history, attachments |
| `openai-compat` | Any `/v1/chat/completions` — OpenAI, Ollama, LMStudio, Groq, vLLM, Together, Fireworks. Minimal. | streaming |
| `zeroclaw` | ZeroClaw gateway (Rust-native, low-memory). Model is fixed at onboard time. | streaming, sessions, toolEvents |

Adapters register in [`src/backend.ts`](../backend.ts). The dispatcher
dynamically imports exactly one at startup.

## Configuration

Set in the server's environment:

```env
SIDEKICK_BACKEND=openclaw
# or one of: hermes, openai-compat, zeroclaw
```

For `openai-compat`:

```env
SIDEKICK_BACKEND=openai-compat
SIDEKICK_OPENAI_COMPAT_URL=http://localhost:11434/v1/chat/completions  # Ollama
SIDEKICK_OPENAI_COMPAT_KEY=                                            # empty for Ollama
SIDEKICK_OPENAI_COMPAT_MODEL=llama3.1:8b
```

For OpenAI directly:

```env
SIDEKICK_BACKEND=openai-compat
SIDEKICK_OPENAI_COMPAT_URL=https://api.openai.com/v1/chat/completions
SIDEKICK_OPENAI_COMPAT_KEY=sk-...
SIDEKICK_OPENAI_COMPAT_MODEL=gpt-4o-mini
```

The server keeps the URL + key server-side and exposes `POST /api/chat`
to the client. No secrets reach the browser.

## The contract

See [`types.ts`](types.ts) for the canonical definitions. Below is a
walkthrough in the order a new adapter typically wires things up.

### `BackendAdapter` — the module interface

```js
{
  name: 'my-agent',
  capabilities: { /* see below */ },

  connect(opts),      // Promise<void>. Called once on page load.
  disconnect(),       // Teardown. Called on unload.
  reconnect(),        // Optional. Drop + re-establish transport.
  isConnected(),      // Boolean. Used by the UI's status pill.
  sendMessage(text, opts),

  // Optional — see capability flags
  fetchHistory(limit),
  listModels(),
  getCurrentModel(),
  setModel(ref),
  newSession(),
  getCurrentSessionId(),
  listSessions(limit),
  resumeSession(id),
  renameSession(id, title),
  deleteSession(id),
}
```

### `ConnectOpts` — what the shell subscribes to

`connect()` receives an options bag with five optional event callbacks.
Your adapter calls them as events arrive on the wire:

| Callback | When to fire |
|---|---|
| `onStatus(connected)` | Transport comes up (true) or drops (false). Drives the UI connection pill. |
| `onDelta({ replyId, cumulativeText })` | Agent is streaming text. `cumulativeText` is the full reply so far (not the delta). Shell recomputes sentence boundaries for chunked TTS. |
| `onFinal({ replyId, text, content? })` | Agent finished a turn. `content` is the raw content-block array if your backend uses them (shell extracts image blocks). |
| `onToolEvent({ kind, payload })` | Side-channel event — canvas cards, function calls, whatever the agent wants the UI to show. `canvas.show` is the canonical use. |
| `onActivity({ working, detail? })` | Positive confirmation the agent is processing. `working: true` flips the UI from "sending…" (optimistic) to "working…" (confirmed). Pair with `working: false` when done. |

### `BackendCapabilities` — what to advertise

| Flag | Meaning |
|---|---|
| `streaming` | Emits `onDelta`. Almost always true. |
| `sessions` | Has session-scoped model overrides + `getCurrentModel` / `setModel`. |
| `models` | Exposes `listModels()` — UI renders a picker when true. |
| `toolEvents` | Emits `onToolEvent`. UI renders canvas cards. |
| `history` | Supports `fetchHistory()` for replaying on load. |
| `attachments` | Accepts image / media attachments in `sendMessage`. |
| `sessionBrowsing` | Supports `listSessions` / `resumeSession`. UI renders the session drawer. Distinct from `sessions`: that flag is about model-override scope; this one is about a browsable list of past conversations. |

The shell reads these at startup to decide which UI controls to
render. Returning `false` for a feature you don't support is the
intended way to hide its UI surface.

### `SessionInfo` and `SessionMessage`

If you advertise `sessionBrowsing`, `listSessions` returns one
`SessionInfo` per past conversation:

```ts
{
  id: string,              // Identifier you accept in resumeSession
  title?: string,          // Optional display label
  lastMessageAt: number,   // Unix-epoch seconds
  messageCount: number,
  snippet?: string,        // Short preview of the last message
}
```

`resumeSession(id)` returns `{ messages: SessionMessage[] }` — the
shell replays them into the chat transcript and wires the next
`sendMessage` to continue that session server-side.

```ts
{
  role: 'user' | 'assistant' | 'system' | 'tool',
  content: string,
  timestamp?: number,
  toolName?: string,  // For role='tool'
}
```

### `DeltaEvent` / `FinalEvent` / `ToolEvent` / `ActivityEvent`

All defined inline in `types.ts`. The important thing about
`DeltaEvent`: `cumulativeText` is the full reply so far, not the
incremental delta. Match this if your backend emits deltas — it keeps
the TTS pipeline simple.

## Writing your adapter

A checklist for adding `my-agent`:

1. **Start from a bundled adapter.** Copy `openai-compat.ts` if your
   backend speaks HTTP + SSE, or `openclaw.ts` / `zeroclaw.ts` if it's
   WebSocket-based. Rename and gut the protocol bits.

2. **Implement the required core:**
   - `connect(opts)` — open your transport, wire up callbacks, set
     `isConnected` true.
   - `disconnect()` — close the transport.
   - `isConnected()` — return your current state.
   - `sendMessage(text, opts)` — serialise + ship.
   - `newSession()` — reset server-side session state (no-op if N/A).

3. **Declare capabilities.** Start with `streaming: true` and flip
   others as you implement them. The shell will adapt.

4. **Wire event emission.** As wire messages arrive, call the
   appropriate `opts.onXxx` you stored on `connect`. Emit `onActivity`
   as soon as you get *any* confirmation the agent is working.

5. **(Optional) Add session browsing.** If your backend exposes a
   conversation list somehow, implement `listSessions`,
   `resumeSession`, optionally `renameSession` / `deleteSession`.
   Return `sessionBrowsing: true` in capabilities.

6. **(Optional) Add model picking.** Implement `listModels`,
   `getCurrentModel`, `setModel`. Return `models: true` (and
   `sessions: true` if the override is session-scoped).

7. **Register the adapter.** In
   [`src/backend.ts`](../backend.ts) `loadAdapter()`, add a `case` for
   your `SIDEKICK_BACKEND` value that dynamic-imports your module.

8. **(If needed) Server-side proxy.** If your backend needs API keys
   or loopback-only endpoints, add a plugin under
   [`server/plugins/`](../../server/plugins/) and mount it in
   `server.ts`. See
   [`server/plugins/hermes.ts`](../../server/plugins/hermes.ts) as a
   reference.

9. **Add your source files to `sw.js` `APP_SHELL`** so the service
   worker caches them.

10. **Document.** Add a row to the table at the top of this README.

## Example stub

```ts
// src/backends/my-agent.ts
const state = {
  opts: /** @type {any} */ ({}),
  connected: false,
};

export const myAgentAdapter = {
  name: 'my-agent',
  capabilities: {
    streaming: true,
    sessions: false,
    models: false,
    toolEvents: false,
    history: false,
    attachments: false,
    sessionBrowsing: false,
  },

  async connect(opts) {
    state.opts = opts;
    // ... open your WS / SSE / whatever, wire callbacks ...
    state.connected = true;
    opts.onStatus?.(true);
  },

  disconnect() {
    state.connected = false;
    // ... close transport ...
    state.opts.onStatus?.(false);
  },

  isConnected() { return state.connected; },

  sendMessage(text, opts) {
    // ... POST to your agent, handle the SSE stream, emit
    // onDelta / onFinal / onActivity as chunks arrive ...
  },

  newSession() {
    // Reset any session state on the server, or no-op.
  },
};
```

Then in `src/backend.ts`:

```ts
case 'my-agent': {
  const m = await import('./backends/my-agent.ts');
  adapter = m.myAgentAdapter;
  break;
}
```

## Why one adapter per deployment

Install-time selection keeps the architecture simple: no runtime state
about "which backend is active now," no mid-session swap edge cases,
no compound UI that has to work for multiple contract surfaces at
once. Need to compare two backends? Run two instances on different
ports.
