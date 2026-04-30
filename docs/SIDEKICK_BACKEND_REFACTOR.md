# Sidekick Backend Refactor — Plan

**Status**: draft for approval. Replaces `STUB_AGENT_ARCHITECTURE.md`
once Jonathan signs off.

**Goal**: clean separation of concerns across PWA, proxy, and agent.
Ship a stub agent in the same change so the layered design is proven
end-to-end with a non-hermes upstream.

**Non-goals**:

- No changes to hermes-agent core.
- No new persistent state in the proxy (no SQLite, no sessions.json
  duplicate). Proxy stays "thin protocol translator + in-memory SSE
  multiplexer."
- No data migration. Hermes already owns the data.
- No collapse of `local/hermes-agent-patches` into upstream hermes —
  that's separate work tracked elsewhere.

**Estimate**: ~6-8h on a `refactor/sidekick-backend` branch. Single
squash-commit when tests + manual verification pass.

---

## 1. End-state architecture

```
┌─────────────────────────┐
│  PWA (browser, IDB)     │
│  src/                   │
│  Chat IDs minted in IDB; │
│  IDB = source of truth  │
│  for frontend state     │
└────────────┬────────────┘
             │ HTTP + SSE  (5 endpoints under /api/sidekick/*)
             │ unchanged from today's PWA contract
┌────────────▼────────────┐
│  Sidekick proxy (Node)  │
│  server.ts              │
│  proxy/agents/     │
│  ──────────────────     │
│  Owns:                  │
│   - protocol translation│
│   - in-memory SSE       │
│     multiplexer         │
│  Owns NO durable state. │
└────────────┬────────────┘
             │ HTTP + SSE  (the agent contract; v1/* surface)
             │   POST   /v1/responses
             │   GET    /v1/conversations
             │   GET    /v1/conversations/{id}/items
             │   DELETE /v1/conversations/{id}
┌────────────▼─────────────────────────────┐
│  Upstream agent — any of:                 │
│   • backends/hermes/plugin (in-process w/ hermes,  │
│     accesses session_manager via Python   │
│     imports)                              │
│   • stub agent (echo / gemini / ollama)   │
│   • OpenAI / Groq / Together / etc.       │
│  Owns ALL agent state (sessions, transcripts, LLM context). │
└──────────────────────────────────────────┘
```

State ownership:

| Layer | Owns |
|---|---|
| PWA | All UI state. IDB-cached chat list, drafts, pending bubbles, settings. |
| Proxy | Protocol translation only. In-memory SSE multiplexer (the persistent `/api/sidekick/stream` channel). No DB. |
| Upstream agent | Sessions, transcripts, LLM context, retention policy. |

This matches Jonathan's stated mental model: "PWA handles all frontend
state, proxy handles all sidekick server state (if any), backend
handles/relays all agent state."

**Openclaw compatibility bet**: the same `UpstreamAgent` contract is
implementable as an openclaw plugin via `definePluginEntry` +
`api.registerHttpRoute(...)` (NOT the channel-plugin idiom — see
[`OPENCLAW_COMPATIBILITY.md`](OPENCLAW_COMPATIBILITY.md) for the data-
flow mismatch). When that work gets prioritized, the proxy doesn't
change at all — only the `UPSTREAM_URL` flips. `proxy/agents/`
stays single-impl; per-agent code lives in each agent's plugin
codebase. Three open questions on openclaw internals (streaming-SSE
support, in-process session enumeration API, plugin auth) are tracked
in that doc.

---

## 2. Agent contract — extension to ABSTRACT_AGENT_PROTOCOL.md

`docs/ABSTRACT_AGENT_PROTOCOL.md` already defines `POST /v1/responses`.
The refactor adds three endpoints. The contract stays
OpenAI-Responses-compatible so any third-party server speaking it can
drop in.

### `GET /v1/conversations`

Returns the agent's list of conversations (sidekick's "drawer"). Query
params: `limit` (1..200, default 50). Response:

```json
{
  "conversations": [
    {
      "id": "conv_<opaque>",
      "object": "conversation",
      "created_at": 1777203774,
      "metadata": {
        "title": "Trip planning",
        "message_count": 14,
        "last_active_at": 1777290174,
        "first_user_message": "let's plan the trip..."
      }
    }
  ]
}
```

`metadata` is OpenAI-compat free-form; sidekick reads `title`,
`message_count`, `last_active_at`, `first_user_message`.

### `GET /v1/conversations/{id}/items`

Transcript replay. Same shape as the existing
`GET /api/sidekick/sessions/{id}/messages` returns today, just
relocated to the agent contract:

```json
{
  "items": [{ "id": 1, "role": "user", "content": "...", "timestamp": 1777203774 }, ...],
  "first_id": 1,
  "has_more": false
}
```

### `DELETE /v1/conversations/{id}`

Hard delete. Returns `{ "ok": true }` on success. Best-effort; may
fail with 404 (unknown id) or 500 (storage error).

### Gateway extension namespace — `/v1/gateway/*`

A second, *optional* contract layered on top of the channel contract
above. Implementing it is what makes a plugin a "gateway" in
sidekick's eyes — agents whose state.db spans multiple platforms
(hermes today, future openclaw plugin) implement it; single-channel
agents (stub, raw OAI third-parties) leave it unimplemented.

**Namespace, not scattered optional flags.** A namespace prefix
gives every future "gateway-shaped" capability a home and keeps the
endpoint surface grep-able. We squat on `/v1/gateway/*` knowing
OpenAI doesn't use it; sidekick is defining its own extension
contract that happens to coexist with OAI compat. The OAI surface
under `/v1` proper stays pristine, so a third-party `/v1/responses`-
speaking server still drops in.

#### `GET /v1/gateway/conversations`

Cross-platform variant of `/v1/conversations`. Same OAI row shape,
plus `source` (telegram / slack / whatsapp / sidekick / …) and
`chat_type` (dm / group) in `metadata`. Sidekick's drawer renders
per-row source badges and disables the composer when
`source !== 'sidekick'`.

```json
{
  "object": "list",
  "data": [
    {
      "id": "<chat_id>",
      "object": "conversation",
      "created_at": 1777290174,
      "metadata": {
        "title": "Trip planning",
        "message_count": 14,
        "last_active_at": 1777290174,
        "first_user_message": "let's plan the trip...",
        "source": "telegram",
        "chat_type": "dm"
      }
    }
  ]
}
```

**Probe-and-fall-back semantics.** The proxy GETs
`/v1/gateway/conversations`; on `404` (single-channel agent) it
falls back to `/v1/conversations` and stamps `source: "sidekick"`
on each row so the composer stays editable. Other failure codes
throw — transient outages must NOT silently degrade the drawer to
channel-only.

**Why a namespace and not a flag on `/v1/conversations`.** Putting
gateway rows under the same OAI endpoint would force third-party
agents to either return a degenerate `source: "sidekick"` field or
break the OAI contract. The namespace keeps the OAI surface clean
and gives gateways a clear, documented place to expose multi-source
views.

---

## 3. Hermes-plugin migration (sidekick repo, our code)

`backends/hermes/plugin/__init__.py` currently runs an aiohttp WebSocket server
on `127.0.0.1:8645`. Migrate to aiohttp HTTP+SSE on the same port.

### Endpoints the plugin exposes

- `POST /v1/responses` — turn dispatch. Streaming SSE (per
  `ABSTRACT_AGENT_PROTOCOL.md`'s `response.output_text.delta` +
  `response.completed` events).
- `GET /v1/conversations`, `GET /v1/conversations/{id}/items`,
  `DELETE /v1/conversations/{id}` — drawer.
- `GET /health` — readiness.
- (no more `/ws`)

### Data access — in-process via Python imports

The plugin runs IN hermes-agent's Python process (it's loaded via
`gateway.config.Platform`). It can import and call hermes's internal
APIs directly:

- `session_manager.list_for_source('sidekick', limit=N)` → returns
  session metadata.
- `session_manager.get_messages(session_id, limit, before_id)` →
  returns transcript rows (already used by the existing API server
  for /v1/responses replay).
- `session_manager.delete_session(session_id)` → cascades transcript
  + sessions.json + state.db cleanup.

If any of these methods don't exist as cleanly as listed (likely —
hermes's session_manager API is internal and may not have a
list-by-source method), the plugin falls back to walking
`sessions.json` + `state.db` IT ALREADY DOES TODAY (see plugin
lines 245, 911-967, where `_resolve_state_db_path` and the
sessions.json walk are already implemented for chat_id resolution).

**Net new direct-state-access code in the plugin: zero. The reads
were already there.** What's new is exposing them via HTTP routes
instead of keeping them as internal helpers.

### Patch surface

The existing `local/hermes-agent-patches/feat/webrtc-voice` already
patches hermes to register `Platform.SIDEKICK`. This refactor doesn't
change the patch — `Platform.SIDEKICK` registration stays as-is.
What changes is what the plugin DOES with that registration (HTTP
server instead of WS server).

If the hermes-internal session_manager API turns out to need an
extension to list-by-source, that lives in the existing patch — not
in upstream hermes.

---

## 4. Proxy migration

`proxy/backends/hermes-gateway/` becomes `proxy/agents/` and
gains a single `UpstreamAgent` interface with one impl that talks
HTTP+SSE.

### `UpstreamAgent` interface (TypeScript, Node)

```typescript
interface UpstreamAgent {
  /** Send a turn. Returns a stream of envelopes (cumulative deltas
   *  + final). Caller fans out to the persistent SSE channel. */
  sendMessage(chatId: string, text: string): AsyncIterable<UpstreamEnvelope>;

  /** Drawer list. */
  listConversations(limit?: number): Promise<ConversationSummary[]>;

  /** Transcript replay. */
  getMessages(chatId: string, opts?: { limit?: number; beforeId?: number }):
    Promise<{ messages: Message[]; firstId: number | null; hasMore: boolean }>;

  /** Drawer delete. */
  deleteConversation(chatId: string): Promise<void>;

  /** Health check. */
  healthcheck(): Promise<{ ok: boolean }>;
}
```

### Implementation: `HTTPAgentUpstream`

Single implementation. Reads `UPSTREAM_URL` from config (default
`http://127.0.0.1:8645`). Talks `/v1/*` HTTP+SSE. Auth via existing
bearer token mechanism (`SIDEKICK_PLATFORM_TOKEN`).

### Files reorganized

- `proxy/backends/hermes-gateway/` → `proxy/agents/`
- `proxy/agents/{messages,sessions,history,stream,session-index,client}.ts`
  collapse into `proxy/agents/upstream.ts` (the
  `HTTPAgentUpstream` class) + `proxy/agents/sse-multiplexer.ts`
  (the persistent `/api/sidekick/stream` channel logic).
- `proxy/agents/CONTRACT.md` updated to reflect the new layering.
- `proxy/agents/__tests__/` retained, tests rewritten to drive
  `HTTPAgentUpstream` with a mock HTTP server.

The `/api/sidekick/*` HTTP route definitions (`server.ts`'s
`mountHermesGatewayRoutes` or equivalent) stay. They just call into
`HTTPAgentUpstream` instead of reading filesystem.

### Direct filesystem reads — deleted

These go away:

- `proxy/backends/hermes-gateway/sessions.ts:107-119` (state.db
  query)
- `proxy/backends/hermes-gateway/history.ts` (state.db CTE walk
  for compression-fork chains)
- All `sqlQuery(HERMES_STATE_DB, ...)` call sites
- All `~/.hermes/sessions/sessions.json` reads from the proxy

---

## 5. Stub agent

Already half-written under `agent/` (uncommitted). Lives at the
top-level of the repo as a sibling runnable. Refactor finishes it:

- `agent/src/server.mjs` — adds `/v1/conversations*` endpoints
  alongside the existing `/v1/responses` it already has.
- `agent/src/conversations.mjs` — already in-memory + JSON-file. The
  drawer list comes from `Conversations.listAll()`.
- `agent/src/llm/{echo,gemini,ollama}.mjs` — already done.
- `agent/bin/start.mjs` — already done.

To run standalone: `cd backends/stub && npm start`. The proxy
sees it identically to backends/hermes/plugin (both speak `/v1/*` on a known
port).

---

## 6. PWA migration

`src/` collapses to `src/proxy-client.ts` (single client for
`/api/sidekick/*`). Mode B deployments (PWA → upstream directly,
bypassing the proxy) are dropped.

Files deleted:

- `src/openai-compat.ts`
- `src/zeroclaw.ts`
- `src/openclaw.ts` (already legacy)
- `src/proxyClientTypes.ts` (consolidates into `src/proxy-client.ts`)
- `src/README.md`

Files added:

- `src/proxy-client.ts` (renamed from `src/hermes-gateway.ts`)

Files modified:

- `src/backend.ts` — single import; the case-switch goes away.
- `server.ts` — `backend.type` config option goes away (always
  hermes-gateway protocol now). `UPSTREAM_URL` replaces it as the
  config knob ("which agent does the proxy talk to").
- `example.config.yaml` — replace `backend.type` section with
  `upstream.url` + `upstream.token`.

OpenAI-compat support survives via the proxy: any user who wants to
point sidekick at an OpenAI-compat server sets
`UPSTREAM_URL=https://api.openai.com/v1` (or wherever) and the proxy
relays.

---

## 7. Audio bridge

`audio-bridge/stt_bridge.py` dispatches via `/api/sidekick/messages`
(the proxy-side surface). No changes — it talks to the proxy, not
the upstream. The legacy `/v1/responses` dispatch path can stay as
a future fallback or be removed in a follow-up.

---

## 8. Execution order on the branch

Single branch `refactor/sidekick-backend`. Work in this order so any
mid-refactor smoke run is meaningful:

1. **Plugin: add HTTP+SSE endpoints alongside WS.** Three new aiohttp
   routes (`/v1/responses`, `/v1/conversations*`). Plugin runs both
   transports. ~1.5h.
2. **Plugin: switch turn dispatch to `/v1/responses` SSE shape** —
   add the OpenAI-compat envelope emitter alongside the existing WS
   envelope emitter. ~1h.
3. **Proxy: extract `UpstreamAgent` interface; add `HTTPAgentUpstream`
   impl.** Implement it in parallel with the existing WS-based code
   path, gated by env. Smoke tests retargeted. ~2h.
4. **Proxy: flip default to HTTP path; verify drawer + chat work
   end-to-end.** Run full smoke + manual verification. ~30min.
5. **Plugin: drop WS server.** Clean up the `/ws` route + the WS
   message dispatch handlers. ~30min.
6. **Proxy: delete WS code path.** Single `UpstreamAgent` impl
   remains. Delete `sqlQuery(HERMES_STATE_DB, ...)` everywhere. ~1h.
7. **PWA: collapse `src/` → `src/proxy-client.ts`. Delete
   Mode B adapters. Update config + tests.** ~45min.
8. **Rename `proxy/backends/` → `proxy/agents/`. Update
   imports.** ~15min.
9. **Stub agent: add `/v1/conversations*` endpoints. Wire into
   smoke runner as an alt upstream.** ~1h.

Smoke runs on every step except the rename (which is mechanical).
Manual verification on step 4 (the live flip) and step 9 (stub
end-to-end).

Single squash-commit at the end with a descriptive subject + body
listing the structural changes. Branch pushed but not merged until
Jonathan tests live.

---

## 9. Test plan

### Smoke suite — must stay green

All 23 existing scenarios. Particular attention to:

- `drawer-rapid-switch`, `drawer-no-flicker`, `drawer-switch` —
  drawer correctness + flicker.
- `text-turn`, `tool-turn`, `tool-turn-web-search` — real-backend
  turn dispatch through the new HTTP path.
- `cross-platform-visibility`, `cross-platform-revisit` — telegram
  sessions still appear in the drawer (they live in hermes's
  state.db; the plugin's list-conversations enumerates them).
- `persistence-reload`, `boot-active-row-matches-content` —
  transcript replay through the new endpoint.

### New smoke scenario

`stub-agent-end-to-end.mjs` — boot the stub agent on an ephemeral
port, point the proxy at it via `UPSTREAM_URL`, send a turn, verify
the echo reply lands. Adds the proof that the layered design works
with a non-hermes upstream.

### Unit tests

`proxy/agents/__tests__/` rewritten to drive `HTTPAgentUpstream`
against a mock HTTP server (the existing test harness pattern at
`proxy-harness.ts` extends to this).

---

## 10. Rollback

Branch-based rollback is the primary mechanism. If something breaks:

1. `git checkout master` — back to today.
2. Restart `sidekick.service` — picks up the master build.
3. Deploy is fully reverted.

No data migration means no rollback risk on persistence. Hermes's
state.db is untouched throughout; rolling back is just a code change.

If the live flip (step 4) fails, the WS code path is still in the
branch — flip the env back, smoke runs against WS again. Diagnose,
re-attempt.

---

## 11. Risks + open questions

### Known risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Hermes's internal `session_manager` doesn't have a `list_for_source` method, requires a small patch to add one. | The plugin's existing direct sessions.json + state.db read is the fallback. Encapsulated inside the plugin; no proxy filesystem reads. |
| R2 | Plugin's aiohttp HTTP server has subtle differences from its WS server (e.g. how heartbeats / disconnects are handled) that surface as transcript-loss bugs. | Smoke tests on every step. Manual session-changed + reply-final round-trips on step 4. |
| R3 | `UPSTREAM_URL` config rename breaks existing private-config files (`hermes-agent-private/sidekick.config.yaml`). | Doc the migration: `backend.type: hermes-gateway` + `backend.hermes_gateway.*` → `upstream.url` + `upstream.token`. Single hermes-agent-private commit. |
| R4 | OpenAI-compat upstreams may not implement `/v1/conversations` — drawer goes empty when pointed at vanilla OpenAI. | Documented as expected — Mode A with vanilla OpenAI = no drawer (acceptable; same as today's mode B with openai-compat). Stub agent + backends/hermes/plugin both implement the full surface. |
| R6 | Cross-platform drawer (telegram + slack rows alongside sidekick) silently disappears under the new HTTP path. | **Resolved**: gateway extension namespace `/v1/gateway/conversations` (section 2). Hermes implements it; proxy probes-and-falls-back. Single-channel agents leave it off → drawer correctly degrades to channel-only. |
| R5 | Audio-bridge legacy `/v1/responses` dispatch path becomes ambiguous (which `/v1/responses` — proxy's or upstream's?). | Bridge talks only to proxy via `/api/sidekick/messages` (already the post-bridge-fix behavior, commit 79a3407). Legacy dispatch path can be deleted in a follow-up. |

### Open questions for Jonathan to answer pre-execution

1. **Single squash-commit, or 2-3 logical commits within the branch?**
   Squash is cleanest history; 2-3 commits (plugin / proxy / PWA)
   gives easier `git log -p` review. I lean squash; happy to do
   logical-split if you prefer.
2. **Mode B deletion confirmed?** This plan deletes
   `src/{openai-compat,zeroclaw,openclaw}.ts`. OpenAI-compat
   support survives via Mode A (proxy → OpenAI as upstream), but
   zero-config "PWA standalone against an OpenAI-compat server with
   no proxy" goes away. Confirm acceptable.
3. **`UPSTREAM_URL` config name OK?** Alternatives: `AGENT_URL`,
   `BACKEND_URL`. I picked `UPSTREAM_URL` for symmetry with the
   `UpstreamAgent` interface name in the proxy. Easy to change if
   you have a different preference.

---

## 12. What this refactor does NOT do

Explicitly out of scope (pursue separately if desired):

- **Authentication beyond the existing bearer token.** The proxy is
  loopback-only; if you want public deployment auth, add it at the
  reverse-proxy layer.
- **Multi-tenant session ownership.** Single user, single agent.
- **Plugin model unification with upstream hermes.** The
  `local/hermes-agent-patches` patch surface stays as it is; this
  refactor doesn't try to upstream the `Platform.SIDEKICK`
  registration.
- **Tool-call relay.** Today's WS protocol carries `tool_call` /
  `tool_result` envelopes for the activity-row UI. The new HTTP
  contract needs to carry the same — folded into the
  `response.output_item.added` SSE events. Will be exercised by
  `tool-turn.mjs` smoke.
- **Compression-fork transcript chains** at the agent boundary.
  Today's history.ts walks `parent_session_id` recursively. The new
  `/v1/conversations/{id}/items` endpoint does the same walk on the
  agent side; the proxy doesn't see forks.

---

*This plan, dated 2026-04-29, replaces `STUB_AGENT_ARCHITECTURE.md`
once Jonathan approves. The earlier doc had a fundamentally different
architecture (proxy owns SQLite session store) — abandon it.*
