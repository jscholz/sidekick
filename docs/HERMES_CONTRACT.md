# Hermes-Gateway Contract

**Audience**: anyone modifying the sidekick proxy, the hermes-plugin
adapter, or the PWA's `hermes-gateway` backend client. Read this
before touching session-list, SSE routing, or the WS bridge.

**Why this doc exists**: in 2026-04 we burned an evening reverse-
engineering session-list and SSE-routing semantics that were already
documented in hermes-agent's source. Don't make that mistake again —
canon is upstream, this file points to where.

---

## TL;DR

Sidekick is a hermes platform adapter, peer of telegram/slack/signal/
discord. The hermes-plugin Python module at `hermes-plugin/__init__.py`
is the real adapter (registers `Platform.SIDEKICK`, owns session
lifecycle). The Node proxy at `server.ts` translates between the
plugin's WebSocket envelopes and the PWA's HTTP+SSE.

Wire protocol is per-message envelopes with explicit `chat_id` tags
on every inbound and outbound frame. There is no "session create"
RPC: a session is created server-side on the first inbound message
for a chat_id.

Authoritative storage: **state.db** (sessions/messages tables).
Cache: **sessions.json** (chat_id → session_id map for the latest
fork). The PWA drawer should derive from state.db, with sessions.json
as the lookup map only.

---

## 1. Layers

```
┌─────────────────────────┐
│  PWA  (browser, IDB)    │   src/*.ts — chat_id minted here
└────────────┬────────────┘
             │ HTTP + SSE
             │ /api/sidekick/messages       (POST text)
             │ /api/sidekick/stream         (SSE, every event tagged chat_id)
             │ /api/sidekick/sessions       (GET drawer list)
             │ /api/sidekick/sessions/<id>/messages (GET history)
             │ /api/sidekick/sessions/<id>  (DELETE)
┌────────────▼────────────┐
│  Sidekick proxy         │   server.ts + server-lib/backends/hermes-gateway/*
│  (Node, single-process) │
└────────────┬────────────┘
             │ WebSocket (loopback, port 8645 default)
             │ Bearer token auth
             │ Per-message JSON envelopes, every one chat_id-tagged
┌────────────▼────────────┐
│  hermes-plugin adapter  │   hermes-plugin/__init__.py
│  (in-process Python)    │   peer of telegram/slack/...
└────────────┬────────────┘
             │ in-process Python calls
             │ gateway.handle_message(MessageEvent)
┌────────────▼────────────┐
│  hermes-agent gateway   │   ~/.hermes/hermes-agent/gateway/*
└─────────────────────────┘
```

---

## 2. WebSocket envelope contract (proxy ↔ plugin)

Wire spec is canonical at `hermes-plugin/__init__.py:10-46`. Summary:

### Inbound (proxy → plugin)
```json
{ "type": "message",  "chat_id": "<opaque>", "text": "hi", "attachments": [] }
{ "type": "command",  "chat_id": "<opaque>", "command": "new" }
```

### Outbound (plugin → proxy)
| type              | required fields                                  | meaning                             |
|-------------------|--------------------------------------------------|-------------------------------------|
| `reply_delta`     | `chat_id`, `text`, `message_id`                  | streaming bubble chunk              |
| `reply_final`     | `chat_id`, `message_id`                          | this BUBBLE is done (NOT the turn)  |
| `image`           | `chat_id`, `url`                                 | image to render                     |
| `typing`          | `chat_id`                                        | "agent is composing"                |
| `notification`    | `chat_id`, `kind`, `content`                     | cron / scheduled / out-of-turn     |
| `session_changed` | `chat_id`, `session_id`, `title`                 | new session_id (on first msg or compression rotation) |
| `error`           | `chat_id`, `message`                             | turn-level error                    |
| `tool_call`       | `chat_id`, `name`, `args`                        | (Phase 3) observational             |
| `tool_result`     | `chat_id`, `result`                              | (Phase 3) observational             |

**Critical contract: every outbound envelope MUST carry `chat_id`.**
The proxy enforces this at `stream.ts:broadcast()` — envelopes
without chat_id are dropped with a warn rather than fanned out
untargeted. If you add a new envelope type to the plugin, propagate
chat_id explicitly; do not rely on conn-level state.

**`reply_final` is per-bubble, not per-turn.** A single user message
can produce multiple bubbles (system bootstrap nudge, the actual
reply, possibly a tool-result-as-text). The PWA must not close its
SSE on the first `reply_final`; the persistent stream stays open
across turns. Telegram/Slack/Signal adapters work the same way.

---

## 3. Session lifecycle

**Sessions are created on first inbound message, never preemptively.**
This is the canonical pattern — telegram/signal/discord all do it.
Anything that creates a session before a message has landed (e.g.
"reserve a chat_id" RPCs, prefetch endpoints that call
`get_or_create_session()` for lookup) is a bug.

### Where state lives

| Layer | What | When written | Source-of-truth for |
|-------|------|--------------|---------------------|
| `state.db sessions` | id, source, title, message_count, started_at, parent_session_id | first message via `db.create_session()` (gateway/session.py:833) | EXISTENCE of a session |
| `state.db messages` | role, content, tool_name, timestamp | each transcript append | Message history |
| `sessions/sessions.json` | session_key → session_id, updated_at | `_save()` synchronously inside `get_or_create_session()` (gateway/session.py:817) | chat_id ↔ session_id MAP (incl. compression-fork rotation) |
| `sessions/<session_id>.jsonl` | append-only transcript | each turn | Replayable transcript (FS-level backup) |

### The orphan-write race (gateway/session.py:738-837)

`get_or_create_session()` writes sessions.json **synchronously inside
the lock** at line 817 via `_save()`. The state.db `create_session()`
call at line 833 happens **outside the lock** in a try/except that
catches all exceptions and prints a warning. If create_session() ever
fails (or, more commonly, no message is ever appended after
get_or_create_session returns), sessions.json has an entry with no
state.db row.

**Result: sessions.json is a superset of state.db**. The drawer must
treat sessions.json as the chat_id ↔ session_id map AND require each
session_id to exist in state.db. The proxy enforces this at
`server-lib/backends/hermes-gateway/sessions.ts` — orphans are
silently dropped.

A future hermes-agent PR should make sessions.json's write lazy (only
on first transcript append) to plug this at the source.

### Compression-fork rotation

A long chat can have its session compressed: the gateway creates a
NEW session_id with `parent_session_id` pointing at the prior one,
copies recent context into it, and marks the prior session ended. The
chat_id keeps mapping to the LATEST session_id in sessions.json
(prior forks remain in state.db with parent_session_id set).

For history reads, the proxy walks `parent_session_id` recursively
via `chainCteFromSession` in `server-lib/backends/hermes/cte.ts`. For
the drawer list, just use sessions.json's "latest fork" mapping.

---

## 4. PWA-facing HTTP + SSE

All routes mounted in `server.ts` and implemented under
`server-lib/backends/hermes-gateway/`.

### `POST /api/sidekick/messages`
Body: `{ chat_id, text, attachments? }`. Returns 202 + `{ ok, message_id }`.
Forwards to plugin as a `message` envelope.

503 cases:
- `sidekick_platform_unconfigured` — no SIDEKICK_PLATFORM_TOKEN env
- `sidekick_platform_disconnected` — WS to plugin not connected
- `sidekick_platform_send_failed` — WS write threw

### `GET /api/sidekick/stream`

SSE. Persistent — open once on app boot, don't open per turn.
Every event has `id:`, `event:` (envelope type), `data:` (full JSON
envelope including chat_id).

**Query params**:
- `?chat_id=<id>` — when set, both live broadcast and replay are
  scoped to this chat. PWA tabs always pass this. Without it, the
  client gets the firehose (used by `curl` for diagnostics).

**Reconnect**:
- `Last-Event-ID` header sent automatically by EventSource on retry.
  The proxy replays only ring entries with id > cursor, scoped to
  `?chat_id=` if set. No duplicates.
- Replay ring is bounded (RECENT_CAP=128). When the missed window
  exceeds the ring, the client falls back to a full transcript
  reconcile via `GET /api/sidekick/sessions/<chat_id>/messages`.

**Events fanned out** (FANOUT_TYPES at stream.ts:54):
`reply_delta`, `reply_final`, `image`, `typing`, `notification`,
`session_changed`, `error`, `tool_call`, `tool_result`.

### `GET /api/sidekick/sessions`

Returns `{ sessions: [...] }` for the drawer. Each row:
`{ chat_id, session_id, title, message_count, last_active_at, created_at }`.
Sorted most-recent-first. `?limit=N` (1..200, default 50).

Source: walks sessions.json for the sidekick prefix
(`agent:main:sidekick:dm:`), filters to chat_ids whose session_id has
a state.db row with `source='sidekick'`. Orphans dropped.

### `GET /api/sidekick/sessions/<chat_id>/messages`

Returns `{ messages, firstId, hasMore }`. Walks compression-fork
parent chain via recursive CTE. `[CONTEXT COMPACTION ...]` rows
filtered out so visible transcript stays clean.

### `DELETE /api/sidekick/sessions/<chat_id>`

Deletes state.db sessions + messages rows, removes the
`agent:main:sidekick:dm:<chat_id>` key from sessions.json (atomic
.tmp + rename), and unlinks `sessions/<session_id>.jsonl`. Each step
is best-effort and logs on failure.

---

## 5. Diagnostic recipes

When a UX bug reproduces, START HERE before clicking buttons in the
PWA.

### Watch the live envelope stream
```bash
curl -N http://127.0.0.1:3001/api/sidekick/stream?chat_id=$CHAT
```

### Verify drawer list matches state.db
```bash
curl http://127.0.0.1:3001/api/sidekick/sessions | jq
sqlite3 ~/.hermes/state.db "SELECT id, title, message_count FROM sessions WHERE source='sidekick' ORDER BY started_at DESC LIMIT 20"
```

### Drive a turn from CLI
```bash
curl -X POST http://127.0.0.1:3001/api/sidekick/messages \
  -H 'content-type: application/json' \
  -d '{"chat_id":"test-cli","text":"hi"}'
```

### Run the proxy contract suite
```bash
cd ~/code/sidekick && npm test -- test/proxy.test.ts
```

### When sessions.json drifts from state.db
```bash
python3 ~/code/sidekick/scripts/purge-test-sessions.py
# (or for a full reset:)
systemctl --user stop hermes-gateway
# (purge sessions.json sidekick keys + matching jsonl + state.db sidekick rows)
systemctl --user start hermes-gateway
```

If a UX bug reproduces with `curl` (the PWA isn't even running), it's
on the proxy or downstream. If only the PWA repro, it's the PWA.
That's the diagnostic separation the test suite + this doc enforce.

---

## 6. Canonical references in hermes-agent source

Path: `~/.hermes/hermes-agent/`.

| File | What |
|------|------|
| `gateway/platforms/ADDING_A_PLATFORM.md` | 314-line checklist for adding a platform adapter |
| `gateway/platforms/base.py` | `BasePlatformAdapter` interface — `handle_message` is the entry point at line 1905 |
| `gateway/platforms/telegram.py` | Most mature reference adapter; canonical pattern |
| `gateway/platforms/signal.py` | Cleaner async HTTP pattern |
| `gateway/session.py:65-138` | `SessionSource` dataclass — identity per platform |
| `gateway/session.py:738-837` | `get_or_create_session()` — the orphan-write race lives here |
| `gateway/session.py:603-624` | `_save()` — atomic sessions.json write |
| `gateway/run.py:4089` | Where `handle_message` flow calls `get_or_create_session` |

Sidekick-specific:
| File | What |
|------|------|
| `~/code/sidekick/hermes-plugin/__init__.py` | Sidekick platform adapter — registers `Platform.SIDEKICK`, runs WS server, multiplexes per-chat_id |
| `~/code/sidekick/hermes-plugin/__init__.py:10-46` | Wire-protocol spec (the canonical envelope schema) |
| `~/code/sidekick/server-lib/backends/hermes-gateway/*.ts` | The Node proxy half |
| `~/code/sidekick/test/proxy.test.ts` + `test/proxy-harness.ts` | Contract tests; run before changing any of the above |

---

## 7. What's NOT in this contract

The following are explicitly out of scope for the gateway — handle
them at higher layers:

- **Multi-tab / multi-PWA-tab routing**: single-user, single-process.
  If you want multi-device sync, build it on top of the SSE channel,
  not into it.
- **Authentication beyond the WS bearer token**: the proxy is loopback-
  only by default. Public deployments add auth at the reverse proxy
  layer (nginx/caddy), not here.
- **Message ordering across reconnects**: the SSE replay ring is
  best-effort. Long disconnects → full reconcile via the messages
  endpoint, not durable replay.
- **State for ephemeral / unsent chats**: those live in PWA IDB until
  first message. The gateway doesn't know they exist.
- **Session compression policy**: the gateway decides when to
  compress; the proxy/PWA just observes `session_changed` and adapts.

---

*Last updated 2026-04-28 after the proxy contract test suite landed
(commits scaffolding-tests through delete-cleanup).*
