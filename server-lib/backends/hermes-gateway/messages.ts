// POST /api/sidekick/messages — forward a chat turn to the hermes
// sidekick adapter and stream the reply back to the PWA as SSE.
//
// Request body (JSON):
//   { chat_id: string, text: string, attachments?: any[] }
//
// Wire path:
//   PWA → POST /api/sidekick/messages
//                ↓ (this handler)
//   client.send({type:'message', chat_id, text})
//                ↓ ws frame
//   hermes adapter.handle_message → agent run
//                ↓ (streaming)
//   adapter sends reply_delta / reply_final / image / typing /
//          session_changed / notification envelopes back over the WS
//                ↓
//   We subscribe to those envelopes for `chat_id`, mirror each as
//   one SSE `data:` line back to the PWA. Connection ends when we
//   see reply_final, OR when the PWA disconnects, OR on a timeout.
//
// SSE shape (one event per envelope):
//   event: <envelope.type>
//   data: <json envelope verbatim>
//
// PWA-side handlers can switch on event name. Keeping the entire
// envelope as the payload (rather than only the delta text) means
// future fields land in the PWA without a server change.

import { client } from './client.ts';

const MAX_BODY_BYTES = 1 * 1024 * 1024;
// Generous turn cap. The agent rarely takes more than 60s, but cron
// dispatch + tool chains can run longer. SSE keepalives ride through.
const TURN_TIMEOUT_MS = 5 * 60 * 1000;

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

  // Begin SSE response. Headers identical to the openai-compat path so
  // the PWA's existing SSE plumbing applies unchanged.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // EventSource auto-reconnect hint — short so a dropped connection
  // recovers fast on flaky cellular.
  res.write('retry: 5000\n\n');

  let finished = false;
  let unsubscribe: (() => void) | null = null;
  let timer: NodeJS.Timeout | null = null;

  const finish = () => {
    if (finished) return;
    finished = true;
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (timer) { clearTimeout(timer); timer = null; }
    try { res.end(); } catch { /* noop */ }
  };

  const writeEvent = (env: Record<string, unknown>) => {
    if (finished) return;
    const evtName = typeof env.type === 'string' ? env.type : 'message';
    try {
      res.write(`event: ${evtName}\ndata: ${JSON.stringify(env)}\n\n`);
    } catch {
      finish();
    }
  };

  unsubscribe = client.subscribe(chatId, (env) => {
    writeEvent(env);
    if (env.type === 'reply_final') finish();
  });

  // Turn timeout — keep the SSE channel from leaking forever if the
  // adapter never emits reply_final (process kill, OOM, etc.).
  timer = setTimeout(() => {
    if (finished) return;
    writeEvent({ type: 'error', chat_id: chatId, detail: 'turn timed out' });
    finish();
  }, TURN_TIMEOUT_MS);

  // Hang up tracking — if the PWA closes early, drop our subscription
  // and stop writing. We do NOT cancel the agent run on the adapter
  // side; let the agent finish naturally so its memory writes land
  // (matches the hermes-proxy behavior from proxy.ts).
  res.on('close', finish);
  res.on('error', finish);

  const ok = client.send({
    type: 'message',
    chat_id: chatId,
    text,
    ...(attachments ? { attachments } : {}),
  });
  if (!ok) {
    writeEvent({
      type: 'error',
      chat_id: chatId,
      detail: 'failed to forward message to adapter (connection dropped)',
    });
    finish();
  }
}
