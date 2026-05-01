// POST /api/sidekick/messages — forward a chat turn to the upstream
// agent. Fire-and-forget: returns 202 immediately; reply envelopes
// (reply_delta, reply_final, image, typing, notification,
// session_changed) flow back through the persistent
// /api/sidekick/stream SSE channel.
//
// Request body (JSON):
//   { chat_id: string, text: string, attachments?: any[] }
//
// Response (202): { ok: true, message_id: string }
//
// Wire path:
//   PWA → POST /api/sidekick/messages
//                ↓ (this handler)
//   upstream.sendMessage → POST /v1/responses (stream:true)
//                ↓ (SSE)
//   reply_delta / reply_final / tool_* envelopes → pushEnvelope
//                ↓
//   stream.ts SSE multiplexer fan-out on /api/sidekick/stream
//
// Why fire-and-forget vs per-POST SSE: agents emit multiple bubbles
// per turn (bootstrap nudges, the actual reply, possibly tool-result-
// as-text). The persistent stream channel decouples turn lifecycle
// from connection lifecycle and matches how telegram/slack/signal
// adapters work today.

import { getUpstream } from './index.ts';
import { pushEnvelope } from './stream.ts';
import type { UpstreamAgent } from './upstream.ts';

const MAX_BODY_BYTES = 1 * 1024 * 1024;

function newMessageId(): string {
  return `sk-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function handleSidekickMessage(req, res) {
  const upstream = getUpstream();
  if (!upstream) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: 'sidekick_platform_unconfigured',
      detail: 'SIDEKICK_PLATFORM_TOKEN not set on the proxy.',
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

  // Forward attachments via the sidekick extension to /v1/responses
  // (additive `attachments` field on the request body — see plugin's
  // `_handle_responses`). The plugin materializes the data:URL
  // payloads to tempfiles and populates MessageEvent.media_urls so
  // hermes' vision tools can read them; raw OAI third-party upstreams
  // ignore the unknown field.
  const messageId = newMessageId();
  void dispatchTurnViaUpstream(upstream, chatId, text, attachments);
  res.writeHead(202, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, message_id: messageId }));
}

async function dispatchTurnViaUpstream(
  upstream: UpstreamAgent,
  chatId: string,
  text: string,
  attachments?: unknown[],
): Promise<void> {
  try {
    for await (const envelope of upstream.sendMessage(chatId, text, {
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    })) {
      pushEnvelope(envelope);
    }
  } catch (e: any) {
    pushEnvelope({
      type: 'error',
      chat_id: chatId,
      message: `upstream dispatch failed: ${e?.message || String(e)}`,
    });
  }
}
