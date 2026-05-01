# Stub agent

In-tree TypeScript reference implementation of the abstract agent
contract. No external dependencies (other than node 22+); useful
for first-clone demos, hermes-free dev, and CI smoke runs.

## Run it

```bash
cd backends/stub
npm install
npm start
# listens on http://127.0.0.1:4001 with the echo LLM
```

Or boot the proxy + stub together via the project root's
`scripts/start-all.mjs` (which `npm start` at the repo root invokes
automatically):

```bash
cd ../..      # repo root
npm start     # proxy on :3001, stub on :4001
```

## Env vars

| Var | Default | What |
|---|---|---|
| `AGENT_PORT` | `4001` | listen port |
| `AGENT_LLM` | `echo` | `echo` / `gemini` / `ollama` |
| `GEMINI_API_KEY` | — | required when `AGENT_LLM=gemini` |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | when `AGENT_LLM=ollama` |
| `BEARER_TOKEN` | — | optional auth gate; matches sidekick's `SIDEKICK_PLATFORM_TOKEN` |

## Contract pieces implemented

- ✅ `POST /v1/responses` (streaming + non-streaming)
- ✅ `GET /v1/conversations` + `GET /v1/conversations/{id}/items` + `DELETE /v1/conversations/{id}`
- ✅ `GET /v1/events` (SSE; emits no envelopes — the stub has no
  proactive notifications, but the endpoint exists for proxies that
  expect to subscribe + reconnect)
- ✅ `GET /v1/settings/schema` + `POST /v1/settings/{id}` —
  declares `model` as a 1-option enum reflecting the configured
  LLM. Reference impl for forks adding more knobs (persona,
  temperature, ...).
- ❌ `/v1/gateway/conversations` — single-channel agent; no gateway
  surface to expose.
- ❌ Attachments — the stub 400s if any are sent.

## Persistence

Conversations + transcripts persist to `data/conversations.json`
(jsonl-style) in this directory. Delete it to start fresh.

## Adding an LLM adapter

`src/llm/index.mjs` picks one of `echo` / `gemini` / `ollama` based
on `AGENT_LLM`. Adding `claude` / `openai` etc. is ~30 lines per
adapter — see `src/llm/echo.mjs` for the minimal interface.
