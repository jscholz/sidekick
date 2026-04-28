# Sidekick Audio Bridge Protocol

This is the internal contract between the sidekick PWA and the
sidekick audio bridge. The aiortc service at
`audio-bridge/` is the **reference implementation**; alternative
implementations (e.g. node-webrtc on a Mac) are valid as long as they
satisfy this contract.

## What "audio bridge" bridges

The audio bridge converts between two protocol families:
- **Real-time media** (WebRTC: Opus packets, ICE, peer connection
  lifecycle) on the PWA-facing side.
- **Text** (HTTP/SSE — utterance dispatch, transcript stream) on the
  agent-facing side, routed through the sidekick proxy.

It's a media-↔-text bridge, not a network hop between PWA and proxy.
The PWA still talks to the proxy directly for everything that isn't
audio (chat history, sessions, model picker, settings, etc.).

## Data path

The proxy is the **sole gateway to the agent backend**. Nothing else
in this system has the agent's URL. Both the PWA and the audio bridge
hit the proxy when they need to dispatch to the agent.

```
            ┌─────────────────────┐
            │        PWA          │
            └──┬───────────────┬──┘
               │               │
        HTTP   │               │  WebRTC media
       :3001   │               │  (mic ↔ STT, TTS ↔ speaker)
               │               │
               ▼               ▼
        ┌─────────────┐    ┌──────────────────┐
        │   sidekick  │    │   audio bridge   │
        │   proxy     │◄───┤   (Python :8643) │
        │ (Node :3001)│    │                  │
        │             │    │  user transcripts│
        │             │    │  POSTed back to  │
        │             │    │  proxy via       │
        │             │    │  /api/<be>/      │
        │             │    │   responses      │
        │             │    └──────────────────┘
        │             │
        │ /api/<be>/* │ ──► agent backend (e.g. hermes, openai-compat, …)
        └─────────────┘
                              ◄── only the proxy talks to the agent.
                                  the bridge always re-enters via the
                                  proxy on the same /api/<be>/responses
                                  endpoint the PWA uses.
```

`<be>` is the active backend slug (`hermes`, `openai-compat`, …).
The bridge doesn't know or care which backend is wired up — it always
POSTs to the proxy URL configured at startup and lets the proxy route.

---

## HTTP signaling

All endpoints are JSON-in / JSON-out, mounted under `/v1/rtc/` on the
bridge. The proxy forwards `/api/rtc/*` to `/v1/rtc/*` on the bridge.

### POST `/v1/rtc/offer`

Open a new peer connection.

**Request:**
```json
{
  "sdp": "<offer SDP>",
  "type": "offer",
  "mode": "stream" | "talk",
  "conv_name": "sidekick-example-2026-04-26",   // optional; legacy /v1/responses path
  "chat_id": "uuid-…"                        // optional; hermes-gateway path
}
```

`mode`:
- `stream` — mic in, transcripts out via data channel, no TTS audio.
- `talk` — full duplex; bridge adds an outbound TTS track to the answer.

`conv_name` is the stable agent conversation identifier for the legacy
`/v1/responses` integration. When set, the bridge dispatches user
transcripts to `<proxy>/api/<be>/responses` with
`{input, conversation, stream}`.

`chat_id` is the hermes-gateway path's session-routing primitive (an
opaque UUID minted PWA-side per conversation). When set, the bridge
dispatches to `<proxy>/api/sidekick/messages` with `{chat_id, text}`
instead. The proxy WS-forwards to the hermes sidekick platform adapter.

`conv_name` and `chat_id` are mutually exclusive in practice — the PWA
sets exactly one based on the active backend (`backend.type: hermes` or
`hermes-gateway`). If both are set, `chat_id` wins.

**Response:**
```json
{
  "peer_id": "<32 hex chars>",
  "type": "answer",
  "sdp": "<answer SDP>",
  "mode": "stream" | "talk"
}
```

### POST `/v1/rtc/ice`

Trickle a remote ICE candidate.

**Request:**
```json
{
  "peer_id": "...",
  "candidate": {
    "candidate": "candidate:1 1 UDP 2122252543 ...",
    "sdpMid": "0",
    "sdpMLineIndex": 0
  }
}
```

End-of-candidates: send `{"peer_id": "...", "candidate": null}` or
`{"peer_id": "...", "candidate": {"candidate": ""}}`.

### POST `/v1/rtc/close`

Tear down a peer connection.

**Request:** `{"peer_id": "..."}`
**Response:** `{"ok": true, "closed": true | false}`

### GET `/v1/rtc/health`

Diagnostic endpoint.

**Response:**
```json
{ "ok": true, "peers": 0, "providers": { "stt": "deepgram", "tts": "deepgram_aura" } }
```

---

## Data channel

The PWA opens a single RTCDataChannel labeled `events` inside the
offer SDP. Both directions exchange JSON envelopes (UTF-8 strings; one
envelope per channel message). Unknown `type` values are logged and
ignored.

### Server → client

#### `transcript`

```json
{
  "type": "transcript",
  "role": "user" | "assistant",
  "text": "...",
  "is_final": true | false
}
```

- `role: "user"` — emitted from the STT provider. The bridge sends
  every is_final user transcript as a pass-through; it does NOT
  buffer, gate on commit-phrases, or run silence timers. Interim
  transcripts (partial) come through with `is_final: false`. Empty
  finals (Deepgram's UtteranceEnd marker) are suppressed.
- `role: "assistant"` — emitted during dispatch from the agent's SSE
  reply. Each `response.output_text.delta` event becomes one envelope
  with `is_final: false`. After `response.completed`, the bridge
  sends one final terminal envelope `{role:'assistant', text:'',
  is_final:true}` so the PWA can drop the streaming-cursor.

#### `barge`

```json
{ "type": "barge" }
```

Sent by the bridge when its server-side VAD detects user voice while
TTS is actively playing. The client should cancel local TTS playback
in response (and clear any "drop user transcripts during reply"
suppression). Sent at most once per TTS turn; the bridge resets its
once-per-turn flag when `tts_track.is_active()` flips false.

The decision lives on the bridge because the PWA's mic stream goes
through browser-side AEC before Web Audio sees it, and AEC ducks any
signal correlated with system output (the TTS we're playing). A
client-side mic analyser cannot reliably detect user voice during
TTS for that reason — the bridge sees raw pre-DSP PCM and is the
only place the user's voice is actually visible.

#### `listening`

```json
{ "type": "listening" }
```

Sent by the bridge whenever it transitions from "not accepting mic
frames" to "accepting mic frames into Deepgram" — i.e. on the first
frame of the call AND after every TTS-end transition. The PWA chimes
"your turn" on receipt. This is the single source of truth for the
listening cue; clients should NOT chime on `connectionstatechange`
or any other locally-derived signal, because the WebRTC peer can be
"connected" before the STT pipe is actually hot, and chiming there
would be either too early or doubled with this envelope at call-start.

### Client → server

#### `dispatch`

```json
{ "type": "dispatch", "text": "<utterance to send to the agent>" }
```

The PWA sends this when its own state machine decides an utterance is
done (silence timeout, commit-phrase match, or any future trigger).
The bridge picks one of two routes based on which identifier the
offer payload carried:

**`chat_id` set** (hermes-gateway path):

1. POSTs `{chat_id, text}` to `<proxy_url>/api/sidekick/messages`.
2. Parses the SSE stream as adapter envelopes:
   `event: reply_delta\ndata: {type, chat_id, text}` carries the FULL
   cumulative reply so far (per `BasePlatformAdapter.edit_message`'s
   contract); `event: reply_final` is terminal.
3. Diffs each `reply_delta`'s cumulative `text` against the previous
   one and forwards the per-token delta to the same sinks as the
   responses path (data channel envelope, TTS text queue).

**`chat_id` unset** (legacy responses path):

1. POSTs `{input: text, conversation: <conv_name>, stream: true}` to
   `<proxy_url>/api/<be>/responses` where `<be>` is the active backend
   slug (the proxy routes; the bridge is configured with the proxy URL
   only and doesn't know the backend name in code — it gets it from
   the `SIDEKICK_BACKEND` env var or falls back to the proxy default).
2. Parses the SSE stream as the agent protocol's Responses API events
   (`response.output_text.delta` → user-visible deltas;
   `response.completed` → terminal).

In both cases:

3. Mirrors text deltas onto the data channel as `role:'assistant'`
   transcripts.
4. (Talk mode only) feeds deltas into the TTS provider; the resulting
   PCM is encoded as Opus on the outbound RTP track.

_(removed — barge-in is server-side now; see the `barge` envelope under
"Server → client". An earlier draft of this protocol reserved a
client-initiated `interrupt` envelope here, but the client is no
longer in a position to make that decision because of browser AEC,
so the field has been retired.)_

---

## Bridge dispatch behavior

The bridge MUST POST utterances through the sidekick proxy
(`<proxy_url>/api/<be>/responses`), NOT directly to the agent backend.
The proxy is the sole sidekick→agent gateway; this keeps the bridge
agent-agnostic and centralizes auth / rate-limiting / logging on a
single hop. `<be>` is whichever backend is wired up on the proxy
(e.g. `hermes`, `openai-compat`); the bridge ships the same body shape
regardless.

`<proxy_url>` is supplied via the `SIDEKICK_PROXY_URL` env var
(default `http://127.0.0.1:3001`); bridges that ship behind a non-
default sidekick deployment must accept this configuration.

Body shape:
```json
{
  "input": "<utterance>",
  "conversation": "<conv_name>",   // when provided in the offer
  "stream": true
}
```

Stream parsing follows the abstract agent protocol. See
`ABSTRACT_AGENT_PROTOCOL.md`.

---

## Reference implementation

`audio-bridge/` (Python 3.11, aiortc). Standalone aiohttp service on
port 8643. Run via:

```bash
cd audio-bridge
.venv/bin/python bridge.py
```

systemd unit: `sidekick-audio.service`.

Provider plug-ins under `audio-bridge/providers/`. Default: Deepgram
nova-3 STT + Deepgram Aura TTS. Local Whisper / Piper stubs land in
the same directory.

---

## Implementer checklist

- [ ] HTTP signaling: `POST /v1/rtc/offer`, `POST /v1/rtc/ice`,
      `POST /v1/rtc/close`, `GET /v1/rtc/health` with the body shapes
      above.
- [ ] DataChannel labeled `events`; JSON envelopes UTF-8.
- [ ] On every is_final user transcript: emit
      `{type:'transcript', role:'user', text, is_final:true}` —
      pass-through, no buffering.
- [ ] On `{type:'dispatch', text}` from the client: POST to
      `<SIDEKICK_PROXY_URL>/api/<be>/responses` (where `<be>` is the
      active backend slug) with the body shape above; parse the SSE
      stream; mirror `output_text.delta`
      events as `role:'assistant'` transcripts; emit a terminal
      `{role:'assistant', is_final:true, text:''}` after
      `response.completed`.
- [ ] (Talk mode) Add an outbound audio track in the answer SDP; feed
      it from the TTS provider's PCM stream.
- [ ] Configurable via env: `SIDEKICK_AUDIO_HOST`,
      `SIDEKICK_AUDIO_PORT`, `SIDEKICK_PROXY_URL`, plus any provider
      API keys.

---

## Hermes-Gateway WS contract

Separate protocol from the audio bridge above. This is the wire shape
between the **sidekick proxy** (Node, port 3001) and the **hermes
sidekick platform adapter** (Python, in-process inside hermes-gateway,
port 8645 by default). The adapter is a peer of telegram/slack/signal
in hermes-agent's gateway/platforms/* — not an audio thing.

Reference implementation of the adapter: `hermes-plugin/sidekick_platform.py`.

### Connection

- Transport: persistent WebSocket from proxy → adapter, single
  connection for the lifetime of the proxy.
- URL: `ws://127.0.0.1:<port>/ws`. Default port `8645`. Override via
  the `SIDEKICK_PLATFORM_URL` env var on the proxy or
  `SIDEKICK_PLATFORM_PORT` on the adapter.
- Auth: shared-secret bearer token in the WS upgrade `Authorization`
  header — `Authorization: Bearer <SIDEKICK_PLATFORM_TOKEN>`. Both
  sides read the same env var name; the adapter rejects upgrades
  without it (constant-time compare).
- Reconnect: proxy-side exponential backoff capped at 30s
  (1, 2, 4, 8, 16, 30, 30, …). The adapter accepts new connections
  and closes any stale predecessor on its side.
- Heartbeat: 30s WS ping (set by the adapter via aiohttp's
  `WebSocketResponse(heartbeat=30)`). Optional application-level
  `{type:'ping', chat_id}` / `{type:'pong', chat_id}` envelopes for
  RTT measurement.

### Inbound (proxy → adapter)

JSON text frames, all keyed on `chat_id` for per-conversation
multiplexing.

```json
{ "type": "message",        "chat_id": "<uuid>", "text": "...", "attachments": [] }
{ "type": "command",        "chat_id": "<uuid>", "command": "new", "args": "" }
{ "type": "voice_dispatch", "chat_id": "<uuid>", "text": "..." }
{ "type": "ping",           "chat_id": "<uuid>" }
```

`message` / `command` / `voice_dispatch` all dispatch to the gateway's
standard `handle_message(MessageEvent)` path. The gateway resolves
`(Platform.SIDEKICK, chat_id)` to a session_id internally and persists
history per chat_id — there is no `previous_response_id` plumbing
because the gateway owns conversation state.

### Outbound (adapter → proxy)

```json
{ "type": "hello",          "protocol_version": 1 }
{ "type": "reply_delta",    "chat_id": "...", "text": "<full so far>", "message_id": "...", "edit"?: true }
{ "type": "reply_final",    "chat_id": "...", "message_id": "..." }
{ "type": "image",          "chat_id": "...", "url": "...", "caption": "..." }
{ "type": "typing",         "chat_id": "..." }
{ "type": "notification",   "chat_id": "...", "kind": "cron", "content": "..." }
{ "type": "session_changed","chat_id": "...", "session_id": "...", "title": "..." }
{ "type": "pong",           "chat_id": "..." }
```

`reply_delta` carries the FULL text-so-far (not a per-token
diff) — this matches `BasePlatformAdapter.edit_message`'s contract.
Callers replace the bubble's text on each delta. `reply_final` marks
the end of a turn.

`session_changed` is emitted when the gateway compresses an active
chat_id's session, which mints a new `session_id` and (often) a new
title. The proxy fans this to the PWA so the drawer can re-key the
row + refresh title without requiring a manual reload. See the
"session_changed sourcing" section below for how the adapter detects
the event.

### Proxy → PWA mapping

The proxy exposes the WS surface to the PWA over plain HTTP/SSE so
the existing fetch+EventSource code path applies unchanged:

- `POST /api/sidekick/messages` body `{chat_id, text, attachments?}`
  forwards as `{type:'message', chat_id, text}` over the WS, then
  streams every per-chat_id outbound envelope back as one SSE event
  (`event:` = envelope `type`; `data:` = JSON envelope verbatim).
  Connection ends on `reply_final`.
- `GET /api/sidekick/sessions[?limit=N]` returns drawer enrichment
  rows from state.db (`{chat_id, session_id, title, message_count,
  last_active_at, created_at}`). PWA-side IDB owns the canonical chat
  list; this endpoint adds gateway metadata.
- `DELETE /api/sidekick/sessions/<chat_id>` drops the matching state.db
  row + messages (best-effort; a fresh chat_id reuse mints a new
  session automatically).

### session_changed sourcing

The adapter detects compression by polling `state.db.sessions` for
known chat_ids — see the `session_changed envelope` section in
`hermes-plugin/sidekick_platform.py` for cadence + envelope shape.
Trade-off: ~1s lag on title refresh after compression, no hermes-core
patch required.
