# Abstract Agent Protocol

This document defines the contract that any agent backend must satisfy
to plug into sidekick. Sidekick (the PWA + proxy + audio bridge) is
agent-agnostic; it talks to a single endpoint:

    POST /v1/responses

Implementers include:

- **hermes-agent** — the reference implementation
  (`gateway/platforms/api_server.py:_handle_responses`).
- **openclaw** — historic, may return after a stability pass.
- **Third-party backends** — implementers reading only this document.

The protocol is OpenAI-compatible (a strict subset of the OpenAI
Responses API) so existing tooling slots in without translation. There
is **no mention** of WebRTC, Deepgram, sidekick UX behavior, or
microphone audio in this contract. Agents are pure text-in / text-out.

---

## Endpoint

```
POST /v1/responses
Content-Type: application/json
Authorization: Bearer <token>     (optional)
```

### Request body

| Field                    | Type             | Required | Description |
| ------------------------ | ---------------- | -------- | ----------- |
| `input`                  | `string \| array` | yes     | The user message. String for one-shot; array of `{role, content}` objects for explicit prompting. Sidekick sends a string. |
| `conversation`           | `string`         | no       | Stable session key. The backend MUST honor this as a chaining identifier — repeated calls with the same `conversation` continue the same logical thread, with prior turns visible to the agent. Sidekick uses `sidekick-<slug>` names (e.g. `sidekick-example-2026-04-26`). |
| `stream`                 | `boolean`        | no       | Default `false`. When `true`, the response is an SSE stream (see below). When `false`, the response is a single JSON object. Sidekick sends `true` for live conversation. |
| `previous_response_id`   | `string`         | no       | Alternative chaining mechanism — pass the `id` of the previous response. **Mutually exclusive with `conversation`.** |
| `instructions`           | `string`         | no       | System-prompt override for this turn. Sidekick does not currently send this. |
| `attachments`            | `array`          | no       | Optional inline attachments. **Backends that don't support attachments MUST return a 400 with a clear error message rather than silently dropping them.** Sidekick sends image / file attachments here when present. |
| `store`                  | `boolean`        | no       | Default `true`. When `true`, the backend persists the response for later GET / chaining. Backends that don't persist responses can ignore this. |

### Response — non-streaming (`stream: false`)

```json
{
  "id": "resp_<24 hex chars>",
  "object": "response",
  "status": "completed",
  "created_at": 1777203774,
  "model": "<implementation-defined>",
  "output": [
    {
      "type": "message",
      "role": "assistant",
      "content": [
        { "type": "output_text", "text": "Hello, world!" }
      ]
    }
  ],
  "usage": {
    "input_tokens": 14587,
    "output_tokens": 5,
    "total_tokens": 14592
  }
}
```

The shape is OpenAI Responses API compatible. Tool-call items
(`{type: "function_call", ...}`) MAY appear in `output` for backends
that support tool use; sidekick renders them but does not require them.

### Response — streaming (`stream: true`)

`Content-Type: text/event-stream`. Frames follow the SSE convention:

```
event: <event-name>
data: <single-line JSON>

event: <event-name>
data: <single-line JSON>
```

#### Required events

| Event                        | When                        | Notes |
| ---------------------------- | --------------------------- | ----- |
| `response.output_text.delta` | Each text chunk             | `{type, item_id, output_index, content_index, delta, logprobs?}` — sidekick concatenates `delta`s into the visible reply. |
| `response.completed`         | Terminal event              | `{type, response: <full envelope as in non-streaming response>}`. **Backends MUST emit this exactly once at end-of-stream.** Sidekick / the audio bridge use it to end the assistant streaming bubble; absence yields a permanent thinking-cursor. |

#### Optional events

OpenAI-compatible backends may also emit `response.created`,
`response.in_progress`, `response.output_item.added`,
`response.output_text.done`, `response.output_item.done`, and the
function-call equivalents. Sidekick is tolerant of additional event
types and ignores any it doesn't render.

---

## Conversation chaining

A `conversation` name (e.g. `sidekick-example-2026-04-26`) is a stable
identifier for a multi-turn thread. The backend SHOULD:

1. On the first POST with a given `conversation`, treat it as a fresh
   thread.
2. Persist the response under that conversation.
3. On subsequent POSTs with the same `conversation`, prepend the prior
   thread's history to the LLM context.

`previous_response_id` is an alternative for stateless callers; pass
the `id` returned by the previous turn. The two mechanisms are
mutually exclusive — backends MUST return a 400 if both are supplied.

---

## Auth

A `Bearer <token>` header is optional; backends MAY require it.
Sidekick injects the configured token from its proxy when one is set.
The bridge does not authenticate to the agent directly — it goes
through the proxy and the proxy adds the token.

---

## Conversation lifecycle endpoints

The following endpoints exist alongside `POST /v1/responses` so a
sidekick deployment can populate its drawer (chat list), replay
transcripts on resume, and delete chats. Backends that don't
implement them MUST return `404` consistently — sidekick degrades
gracefully (drawer becomes IDB-cached only, deletes become local-
only). Backends that implement them MUST cascade through any
ancillary stores they own (hindsight memory, transcript jsonl,
search index) so a delete is durable across the whole agent.

The shape mirrors a subset of the OpenAI Conversations API. Field
names are normative; sidekick parses them by name.

### `GET /v1/conversations`

Returns the agent's list of conversations sorted most-recent-first.

**Query parameters:**

| Field   | Type    | Required | Description |
| ------- | ------- | -------- | ----------- |
| `limit` | integer | no       | 1..200, default 50. |

**Response (200):**

```json
{
  "object": "list",
  "data": [
    {
      "id": "<opaque conversation id>",
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

**Field semantics in `metadata`:**

- `title` — human-readable label. Empty string is allowed; sidekick
  falls back to `first_user_message` for display.
- `message_count` — visible message count (excluding internal context-
  compaction rows). Zero for empty conversations.
- `last_active_at` — UNIX seconds of the most recent message. Drives
  the drawer sort order.
- `first_user_message` — first user-role message text, truncated to
  ≤ 80 chars. Optional. Sidekick uses this when `title` is empty.

`id` is opaque to sidekick; the backend MAY use the same value as the
`conversation` parameter passed to `POST /v1/responses`, or it MAY
mint distinct ids. Sidekick stores this verbatim for use on
subsequent `/v1/conversations/{id}/items` and `DELETE` calls.

`object: "conversation"` is informational; sidekick doesn't validate
the field but it SHOULD be present for OpenAI compatibility.

### `GET /v1/conversations/{id}/items`

Returns the message transcript for a conversation, oldest-first. Used
on resume to repaint the chat surface from server state.

**Path parameter:**

- `id` — the conversation id (URL-encoded if it contains special chars).

**Query parameters:**

| Field      | Type    | Required | Description |
| ---------- | ------- | -------- | ----------- |
| `limit`    | integer | no       | 1..500, default 200. |
| `before`   | string  | no       | Cursor for pagination — return items strictly before this id. Used by load-earlier on long transcripts. |

**Response (200):**

```json
{
  "object": "list",
  "data": [
    {
      "id": "msg_<opaque>",
      "object": "message",
      "role": "user" | "assistant" | "system",
      "content": "...",
      "created_at": 1777203774
    }
  ],
  "first_id": "msg_<opaque>",
  "has_more": false
}
```

`first_id` is the id of the oldest item in `data` (used for the next
`?before=` cursor). `has_more` is true when older items exist.

`content` is plain string for the simple case. The OpenAI Responses
API also supports a structured `content: [{type, text}]` shape; sidekick
accepts both — backends MAY emit either. For tool-call items the
content shape follows the same structure as the `output` array in
`response.completed` (see `POST /v1/responses` above).

Backends that compress or fork conversations (e.g. context-window
rotation) MUST traverse the fork chain server-side and return the
flattened, replayable transcript here. Sidekick does not walk forks.

**404** — unknown conversation id.

### `DELETE /v1/conversations/{id}`

Hard-delete a conversation and all data the agent stores against it.

**Required cascade:** the backend MUST delete:

1. The conversation row + transcript items.
2. Any external memory the agent has retained from this conversation
   (e.g. embeddings in a vector store, summarization caches).
3. Any filesystem artifacts (jsonl transcripts, etc.) keyed by this
   conversation id.

This is non-negotiable for privacy: sidekick exposes "Delete chat"
as a user-facing affordance and the user reasonably expects the
agent to forget. A delete that leaves memory traces is a privacy bug.

**Response (200):**

```json
{ "ok": true }
```

**Error responses:**

- `404` — unknown conversation id.
- `500` — partial failure (some cascade steps succeeded, some didn't).
  The response body SHOULD include an `error.message` describing
  which steps failed. Sidekick treats 500 as "do not remove the
  drawer entry" so the user can retry.

---

## Optional gateway extension — `/v1/gateway/*`

A second contract layered on top of the channel contract above.
Implementing it makes an agent a "gateway" — its state spans
multiple platforms and sidekick should surface them in a single
drawer with per-row source badges.

The extension is **strictly optional**. Single-channel agents leave
it unimplemented; sidekick probes, gets 404, and falls back to
`GET /v1/conversations` with `source: "sidekick"` stamped on each
row. Other failure codes propagate (transient outages must not
silently degrade the drawer to channel-only).

The namespace prefix `/v1/gateway/*` is reserved for this contract
so future gateway-shaped capabilities (e.g. `GET /v1/gateway/sources`,
cross-source delete) have a documented home and don't scatter as
optional flags on the channel endpoints. Sidekick squats on the
prefix; OAI doesn't use it.

### `GET /v1/gateway/conversations`

Cross-platform drawer list. Same OAI row shape as
`GET /v1/conversations`, plus `metadata.source` and
`metadata.chat_type`:

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

**Required `metadata` fields:** `source` (lowercase string —
`sidekick`, `telegram`, `slack`, `whatsapp`, etc.), `chat_type`
(`dm`, `group`, agent-defined). All other fields match
`/v1/conversations`.

**Query params:** `limit` (1..200, default 50). Most-recent-first
ordering required.

**Cross-platform send is NOT part of this extension.** Sidekick's
composer goes read-only when `source !== 'sidekick'`. Agents that
want bidirectional cross-platform messaging would extend further
(future: `POST /v1/gateway/responses?source=...`).

---

## Optional settings extension — `/v1/settings/*`

Lets the agent declare its own user-facing knobs and have sidekick
render them generically in the Settings panel. Replaces the
pre-refactor pattern of hardcoding agent-owned options (e.g. the
model picker) into the PWA — which made every cross-agent setting
a frontend change.

The extension is **strictly optional**. Agents that don't expose
settings return 404 on the schema endpoint; the PWA hides the
"Agent" settings group. Single-purpose agents (the in-tree stub)
typically leave it unimplemented or return an empty list.

Settings owned by the PWA itself (theme, hotkeys, mic device, TTS
voice) stay in the local UI and are NOT part of this contract —
the schema is for **agent-owned** settings only.

### `GET /v1/settings/schema`

Lists the settings the agent supports. The PWA fetches this when
the Settings panel opens (and on close, to surface drift caused
by other clients changing the same agent state).

**Response (200):**

```json
{
  "object": "list",
  "data": [
    {
      "id": "model",
      "label": "Model",
      "description": "LLM used for replies",
      "category": "Agent",
      "type": "enum",
      "value": "anthropic/claude-opus-4-6",
      "options": [
        { "value": "anthropic/claude-opus-4-6", "label": "Claude Opus 4.6" },
        { "value": "google/gemini-3-flash-preview", "label": "Gemini 3 Flash" }
      ]
    }
  ]
}
```

**Setting fields:**

- `id` (string, required) — opaque identifier, also the URL fragment
  on the write endpoint. `[a-z0-9_]+` recommended.
- `label` (string, required) — short user-facing label (`"Model"`).
- `description` (string, optional) — hint text rendered next to /
  beneath the input.
- `category` (string, optional) — group key for the UI. Defaults to
  `"Agent"`. Same string across multiple settings groups them.
- `type` (string, required) — one of:
  - `enum` — dropdown. `options[]` required.
  - `slider` — numeric range. `min`, `max`, `step` required.
  - `toggle` — boolean.
  - `text` — free-form string.
  - `string-list` — list of free-form strings (chip UI). The PWA
    POSTs the entire updated list on each add/remove.
- `value` — current value. Type matches `type`: string for
  `enum`/`text`, number for `slider`, boolean for `toggle`,
  `string[]` for `string-list`.
- `options[]` (enum only, required) — `{value, label, description?}`.
- `min`, `max`, `step` (slider only, required).
- `placeholder` (text/string-list only, optional) — hint text in
  the input box.

**Response (404):** Agent doesn't implement the extension. Sidekick
hides the "Agent" settings group entirely.

### `POST /v1/settings/{id}`

Update one setting. Body is `{"value": <new>}` matching the
declared `type`.

**Request:**

```json
{ "value": "anthropic/claude-opus-4-6" }
```

**Response (200):** the updated `SettingDef` (same shape as one
entry in `GET /v1/settings/schema`'s `data[]`). Returning the full
def lets the agent surface side-effects — e.g. setting a model that
caps `max_tokens` lower than its current value can return a
secondary `max_tokens` setting in a follow-up panel refresh.

```json
{
  "id": "model",
  "label": "Model",
  "type": "enum",
  "value": "anthropic/claude-opus-4-6",
  "options": [...]
}
```

**Error responses:**

- `400` — value doesn't match the declared `type` (e.g. string sent
  to a slider, value not in `options[]` for an enum).
- `404` — unknown setting id.
- `500` — server-side failure applying the change. The PWA reverts
  the optimistic UI state and surfaces the error.

**Idempotency:** same value re-submitted is a no-op (still 200).

**Validation is the agent's job.** The proxy forwards verbatim; if
the agent doesn't validate, malformed values land in agent state.

---

## Errors

Errors use the OpenAI shape:

```json
{
  "error": {
    "message": "...",
    "type": "invalid_request_error" | "authentication_error" | ...,
    "code": "..."     // optional
  }
}
```

HTTP status codes:

- 400 — validation
- 401 — auth
- 404 — unknown endpoint or response id
- 500 — unhandled server error

---

## Reference implementation

Hermes-agent's [`gateway/platforms/api_server.py`](https://github.com/NousResearch/hermes-agent/blob/main/gateway/platforms/api_server.py)
implements this contract. Search for `_handle_responses` (the
non-streaming + streaming entrypoint) and the `response.completed`
SSE writer for the exact event shape. Implementers should treat this
as the canonical reference.
