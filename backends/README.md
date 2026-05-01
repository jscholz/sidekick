# Backends

Each subdirectory is one backend that sidekick can talk to. The
sidekick proxy speaks the abstract agent contract
(`docs/ABSTRACT_AGENT_PROTOCOL.md` — OpenAI-Responses-shaped
HTTP+SSE), and that's the only requirement for being a backend.

What lives in each subdirectory:

- The plugin / adapter / server code (whatever the backend needs
  to expose `/v1/*`).
- A `README.md` describing install, the contract pieces it
  implements, and any backend-specific quirks.
- A `config.example.yaml` (where applicable) showing which
  backend-side config keys sidekick reads or writes (e.g. for
  the model picker that round-trips through `/v1/settings/*`).

The proxy itself is **agent-agnostic** — `proxy/sidekick/` doesn't
contain any per-backend code. It just forwards `/api/sidekick/*`
to whatever HTTP server is at `SIDEKICK_PLATFORM_URL`. So adding
a new backend doesn't require proxy changes; you implement the
`/v1/*` contract on your end and point sidekick at it.

## Bundled backends

| Directory | What |
|---|---|
| `stub/` | In-tree TypeScript reference impl. Echo / Gemini / Ollama LLM adapters. Useful for first-clone demos and CI smoke runs against a hermes-free stack. |
| `hermes/plugin/` | Python plugin that loads into a [hermes-agent](https://github.com/NousResearch/hermes-agent) install and exposes the contract over hermes's existing aiohttp gateway. Adds the optional `/v1/gateway/conversations` (cross-platform drawer) and `/v1/settings/*` (model picker) extensions. |

## Adding a new backend

1. Create `backends/<name>/` with whatever code your backend needs.
2. Implement `POST /v1/responses` (streaming SSE), `GET /v1/conversations`,
   `GET /v1/conversations/{id}/items`, `DELETE /v1/conversations/{id}`,
   and `GET /v1/events` per `docs/ABSTRACT_AGENT_PROTOCOL.md`.
3. Optional: `/v1/gateway/conversations` for cross-platform drawer,
   `/v1/settings/*` for an agent-declared model picker / persona /
   etc.
4. Write a `backends/<name>/README.md` covering install + which
   contract pieces you support.
5. Set `SIDEKICK_PLATFORM_URL=http://your-host:port` in sidekick's
   `.env`. No proxy code changes required.
