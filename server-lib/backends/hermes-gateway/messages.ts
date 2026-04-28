// POST /api/sidekick/messages — forward a chat turn to the hermes
// sidekick adapter. Fire-and-forget: returns 202 immediately once the
// WS frame is queued. All reply envelopes (reply_delta, reply_final,
// image, typing, notification, session_changed) flow back through the
// persistent /api/sidekick/stream SSE channel, NOT this response.
//
// Request body (JSON):
//   { chat_id: string, text: string, attachments?: any[] }
//
// Response (202): { ok: true, message_id: string }
//
// Wire path:
//   PWA → POST /api/sidekick/messages
//                ↓ (this handler)
//   client.send({type:'message', chat_id, text})
//                ↓ ws frame
//   hermes adapter.handle_message → agent run
//                ↓ (streaming)
//   adapter sends reply_* / image / typing / notification /
//          session_changed envelopes back over the WS
//                ↓
//   stream.ts wildcard subscription fans them out as SSE events on
//   /api/sidekick/stream — the PWA's persistent EventSource, opened
//   once on connect, keyed by chat_id.
//
// Why fire-and-forget vs the old per-POST SSE: hermes platform
// adapters emit multiple `send()` calls per turn (bootstrap nudges,
// the actual reply, possibly tool-result-as-text). The old design
// closed the SSE on the first `reply_final` envelope and dropped
// every subsequent bubble — a category error: `reply_final` means
// "this BUBBLE is complete," not "the turn is over." There are no
// turn boundaries on the wire. Telegram/Slack/Signal adapters work
// the same way.

import { client } from './client.ts';

const MAX_BODY_BYTES = 1 * 1024 * 1024;

function newMessageId(): string {
  return `sk-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function handleSidekickMessage(req, res) {
  if (!client.isConfigured()) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: 'sidekick_platform_unconfigured',
      detail: 'SIDEKICK_PLATFORM_TOKEN not set on the proxy.',
    }));
    return;
  }
  if (!client.isConnected()) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: 'sidekick_platform_disconnected',
      detail: 'Hermes sidekick adapter not reachable. Is hermes running with the plugin loaded?',
    }));
    return;
  }

  // Read + parse body. Cap to avoid pathological clients.
  let raw = '';
  let aborted = false;
  req.on('data', (c) => {
    raw += c;
    if (raw.length > MAX_BODY_BYTES) {
      aborted = true;
      req.destroy();
    }
  });
  req.on('error', () => { aborted = true; });

  await new Promise<void>((resolve) => {
    req.on('end', () => resolve());
    req.on('close', () => resolve());
  });

  if (aborted) {
    if (!res.headersSent) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'request body too large' }));
    }
    return;
  }

  let body: any;
  try { body = JSON.parse(raw); }
  catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid json' }));
    return;
  }
  const chatId = typeof body?.chat_id === 'string' ? body.chat_id.trim() : '';
  const text = typeof body?.text === 'string' ? body.text : '';
  const attachments = Array.isArray(body?.attachments) ? body.attachments : undefined;
  if (!chatId) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'chat_id required' }));
    return;
  }
  if (!text && !attachments?.length) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'text or attachments required' }));
    return;
  }

  const messageId = newMessageId();
  const ok = client.send({
    type: 'message',
    chat_id: chatId,
    text,
    ...(attachments ? { attachments } : {}),
  });
  if (!ok) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: 'sidekick_platform_send_failed',
      detail: 'Failed to forward message to adapter (connection dropped).',
    }));
    return;
  }

  // 202 Accepted — the agent run is now the adapter's problem; reply
  // envelopes will arrive on /api/sidekick/stream when they arrive.
  res.writeHead(202, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, message_id: messageId }));
}
