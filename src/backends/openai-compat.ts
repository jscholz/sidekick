/**
 * @fileoverview OpenAI-compatible BackendAdapter. Minimal streaming chat
 * against any endpoint speaking `POST /v1/chat/completions` SSE — OpenAI,
 * Ollama, LMStudio, Groq, vLLM, Together, Fireworks, etc.
 *
 * The actual upstream call is proxied through sidekick's server.ts at
 * `/api/chat`, which keeps `SIDEKICK_OPENAI_COMPAT_URL` + the API key
 * server-side. Client never sees secrets and never needs CORS.
 *
 * Reference implementation of the BackendAdapter contract alongside the
 * complex openclaw adapter — validates that the interface isn't
 * singleton-shaped.
 *
 * Limitations (intentional, v1):
 *   - No server-side sessions. Conversation history kept in-memory; lost
 *     on page reload. Users who need durable threads should pair with a
 *     backend that has them (openclaw).
 *   - No model catalog endpoint. The model string is set once via
 *     SIDEKICK_OPENAI_COMPAT_MODEL on the server; UI picker stays hidden.
 *   - No attachments, no tool events, no history fetch.
 *   - Capability flags reflect all of the above as `false`. The shell UI
 *     (settings, model picker, session rows) hides those controls
 *     automatically.
 *
 * @typedef {import('./types.js').BackendAdapter} BackendAdapter
 * @typedef {import('./types.js').ConnectOpts} ConnectOpts
 */

import { log } from '../util/log.ts';
import { getConfig } from '../config.ts';

const history: Array<{role: string, content: string}> = [];
let connected = false;
type Subs = {
  onStatus?: (connected: boolean) => void;
  onDelta?: (d: any) => void;
  onFinal?: (f: any) => void;
  onToolEvent?: (e: any) => void;
  onActivity?: (a: any) => void;
};
let subs: Subs = {};

function newReplyId() {
  return `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Parse one line of SSE. Returns null if not a usable event, 'DONE' on
 *  stream terminator, or the parsed JSON chunk object. */
function parseSSELine(line) {
  if (!line.startsWith('data: ')) return null;
  const data = line.slice(6).trim();
  if (data === '[DONE]') return 'DONE';
  try { return JSON.parse(data); } catch { return null; }
}

async function streamReply(text) {
  history.push({ role: 'user', content: text });
  const replyId = newReplyId();
  const cfg = getConfig();
  const model = cfg.openaiCompatModel || 'auto';

  let r;
  try {
    const { fetchWithTimeout } = await import('../util/fetchWithTimeout.ts');
    // 60s — this is the stream HEADER timeout; body can take much
    // longer to finish streaming tokens. Covers the case where the
    // upstream LLM is unreachable and the server hangs on the
    // provider-side fetch before sending us any SSE frames.
    r = await fetchWithTimeout('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: history, stream: true }),
      timeoutMs: 60_000,
    });
  } catch (e) {
    log('openai-compat fetch failed:', e.message);
    subs.onStatus?.(false);
    return;
  }
  if (!r.ok || !r.body) {
    log('openai-compat non-OK response:', r.status);
    return;
  }

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let cumulativeText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line) continue;
      const ev = parseSSELine(line);
      if (ev === null) continue;
      if (ev === 'DONE') {
        history.push({ role: 'assistant', content: cumulativeText });
        subs.onFinal?.({
          replyId,
          text: cumulativeText,
          content: [{ type: 'text', text: cumulativeText }],
        });
        return;
      }
      // OpenAI-compatible delta chunk shape:
      //   ev.choices[0].delta.content = "next incremental text"
      const delta = ev.choices?.[0]?.delta?.content;
      if (delta) {
        cumulativeText += delta;
        subs.onDelta?.({ replyId, cumulativeText });
      }
    }
  }
  // Stream ended without [DONE] — treat last accumulated text as final.
  if (cumulativeText) {
    history.push({ role: 'assistant', content: cumulativeText });
    subs.onFinal?.({
      replyId,
      text: cumulativeText,
      content: [{ type: 'text', text: cumulativeText }],
    });
  }
}

/** @type {BackendAdapter} */
export const openaiCompatAdapter = {
  name: 'openai-compat',

  capabilities: {
    streaming: true,
    sessions: false,
    models: false,
    toolEvents: false,
    history: false,
    attachments: false,
  },

  async connect(opts) {
    subs = opts;
    connected = true;
    opts.onStatus?.(true);
  },

  disconnect() {
    connected = false;
    subs.onStatus?.(false);
  },

  isConnected() { return connected; },

  sendMessage(text) {
    if (!connected) return;
    streamReply(text).catch(e => log('openai-compat streamReply err:', e.message));
  },
};
