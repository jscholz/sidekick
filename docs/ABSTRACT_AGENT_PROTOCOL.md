# Abstract Agent Protocol

This document defines the contract that any agent backend must satisfy
to plug into sidekick. Sidekick (the PWA + proxy + audio bridge) is
agent-agnostic; it talks to a single endpoint:

    POST /v1/responses

Implementers include:

- **hermes-agent** — the reference implementation
  (`gateway/platforms/api_server.py:_handle_responses`).
- **openclaw** — historic, may return after a stability pass.
- **Tom's backend** — future contributor; reads only this document.

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
| `conversation`           | `string`         | no       | Stable session key. The backend MUST honor this as a chaining identifier — repeated calls with the same `conversation` continue the same logical thread, with prior turns visible to the agent. Sidekick uses `sidekick-<slug>` names (e.g. `sidekick-tom-2026-04-26`). |
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

A `conversation` name (e.g. `sidekick-tom-2026-04-26`) is a stable
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
SSE writer for the exact event shape. Tom and other contributors
should treat this as the canonical reference.
