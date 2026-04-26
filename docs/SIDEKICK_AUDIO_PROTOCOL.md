# Sidekick Audio Bridge Protocol

This is the internal contract between the sidekick PWA and the
sidekick audio bridge. The aiortc service at
`~/code/sidekick/audio-bridge/` is the **reference implementation**;
alternative implementations (e.g. node-webrtc on a Mac) are valid as
long as they satisfy this contract.

The bridge is sidekick-owned. It does not talk to the agent backend
directly; all sidekick→agent traffic flows through the sidekick proxy
at `/api/hermes/responses`.

```
                  ┌──────────────┐
                  │     PWA      │
                  └──────┬───────┘
                         │ http :3001
                         ▼
                sidekick proxy (Node :3001)  ◄── sole gateway to agent
                    │ │
                    │ └──── /api/hermes/* ─────► agent (hermes :8642)
                    │                                  ▲
                    │ /api/rtc/*                       │
                    ▼                                  │
                audio bridge (Python :8643)            │
                    │                                  │
                    └── POST http://127.0.0.1:3001/api/hermes/responses ──┘
                         (bridge dispatches via proxy, NOT direct to agent)
```

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
  "conv_name": "sidekick-tom-2026-04-26"   // optional; conversation key
}
```

`mode`:
- `stream` — mic in, transcripts out via data channel, no TTS audio.
- `talk` — full duplex; bridge adds an outbound TTS track to the answer.

`conv_name` is the stable agent conversation identifier. The bridge
passes it through as `body.conversation` when dispatching to the proxy.

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

### Client → server

#### `dispatch`

```json
{ "type": "dispatch", "text": "<utterance to send to the agent>" }
```

The PWA sends this when its own state machine decides an utterance is
done (silence timeout, commit-phrase match, or any future trigger).
The bridge:

1. POSTs `{input: text, conversation: <conv_name>, stream: true}` to
   `<proxy_url>/api/hermes/responses`.
2. Parses the SSE stream as the agent protocol's Responses API events
   (`response.output_text.delta` → user-visible deltas;
   `response.completed` → terminal).
3. Mirrors text deltas onto the data channel as `role:'assistant'`
   transcripts.
4. (Talk mode only) feeds deltas into the TTS provider; the resulting
   PCM is encoded as Opus on the outbound RTP track.

#### `interrupt` (reserved)

```json
{ "type": "interrupt" }
```

Reserved for future barge-in support. The reference bridge logs and
ignores this in V1.

---

## Bridge dispatch behavior

The bridge MUST POST utterances through the sidekick proxy
(`<proxy_url>/api/hermes/responses`), NOT directly to the agent
backend. The proxy is the sole sidekick→agent gateway; this keeps the
bridge agent-agnostic and centralizes auth / rate-limiting / logging
on a single hop.

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

`~/code/sidekick/audio-bridge/` (Python 3.11, aiortc). Standalone
aiohttp service on port 8643. Run via:

```bash
cd ~/code/sidekick/audio-bridge
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
      `<SIDEKICK_PROXY_URL>/api/hermes/responses` with the body
      shape above; parse the SSE stream; mirror `output_text.delta`
      events as `role:'assistant'` transcripts; emit a terminal
      `{role:'assistant', is_final:true, text:''}` after
      `response.completed`.
- [ ] (Talk mode) Add an outbound audio track in the answer SDP; feed
      it from the TTS provider's PCM stream.
- [ ] Configurable via env: `SIDEKICK_AUDIO_HOST`,
      `SIDEKICK_AUDIO_PORT`, `SIDEKICK_PROXY_URL`, plus any provider
      API keys.
