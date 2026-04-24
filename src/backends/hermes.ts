/**
 * @fileoverview Hermes Agent BackendAdapter. Wraps Hermes's OpenAI-compatible
 * HTTP API (`/v1/responses` with SSE streaming) into our BackendAdapter
 * contract so the shell doesn't need to know about Hermes's wire format.
 *
 * Wire protocol:
 *   C→S: POST /api/hermes/responses {model?, conversation, input, stream:true}
 *        Authorization: Bearer <API_SERVER_KEY>  (injected by sidekick server)
 *   S→C: SSE stream. Event types (from Hermes's OpenAI-compatible Responses API):
 *     response.output_item.added          — new item starting
 *     response.output_text.delta          — cumulative text chunk
 *     response.function_call.added        — tool call begin
 *     response.function_call_arguments.delta  — tool args stream
 *     response.function_call_output.added — tool result
 *     response.completed                  — done (final text + usage)
 *     response.failed / error             — terminal failure
 *
 * Connection: via SideKick server's `/api/hermes/*` proxy, which relays to
 * the loopback-bound Hermes API server (127.0.0.1:8642). Keeps Hermes off
 * the tailnet; browser sees only the same-origin proxy endpoint.
 *
 * Multi-session: Hermes persists conversation state server-side by `name`.
 * `newSession()` rotates `conversationName` → next sendMessage starts fresh.
 * Old conversations remain addressable by name in the Hermes server if we
 * ever want resumption.
 *
 * @typedef {import('./types.ts').BackendAdapter} BackendAdapter
 * @typedef {import('./types.ts').ConnectOpts} ConnectOpts
 * @typedef {import('./types.ts').SendOpts} SendOpts
 */

import { log, diag } from '../util/log.ts';

let subs: any = null;
let conversationName = 'sidekick-main';
let connected = false;
let inflight: AbortController | null = null;
let currentReplyId: string | null = null;
let cumulativeText = '';

/** Monotonic token for conversation-name changes. Any operation that
 *  intends to set `conversationName` (newSession, resumeSession) claims
 *  a fresh token at start. If the operation is async and its token isn't
 *  the latest by the time it settles, another rotation has superseded it
 *  and the late write is dropped. Fixes: slow resumeSession server fetch
 *  resolving AFTER a user-triggered newSession, which was silently
 *  reverting the conversation name back to the old session and sending
 *  subsequent messages to the wrong server-side thread. */
let conversationToken = 0;

function newReplyId(): string {
  return `hm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function apiBase(): string {
  // Same-origin proxy; sidekick server forwards to 127.0.0.1:8642/v1/*
  return `${location.origin}/api/hermes`;
}

async function healthCheck(): Promise<boolean> {
  try {
    const r = await fetch(`${apiBase()}/health`, { method: 'GET' });
    return r.ok;
  } catch {
    return false;
  }
}

/** Parse SSE stream, dispatching each event as it arrives. Returns when the
 *  server closes the stream or the abort signal fires. */
async function parseSSE(response: Response): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    let chunk;
    try { chunk = await reader.read(); }
    catch (e) { diag(`hermes: SSE read error: ${(e as Error).message}`); break; }
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    // SSE event boundary is a blank line (\n\n)
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (rawEvent.trim()) dispatchSSEEvent(rawEvent);
    }
  }
}

function dispatchSSEEvent(raw: string): void {
  // SSE lines: "event: foo" / "data: {...}" / empty line.
  // data may span multiple lines — concatenate before JSON-parsing.
  let eventName = 'message';
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return;
  const data = dataLines.join('\n');
  let payload: any;
  try { payload = JSON.parse(data); }
  catch { diag(`hermes: non-JSON data in event=${eventName}: ${data.slice(0, 80)}`); return; }
  // Server sends `type` in payload which matches (or is canonical vs) the
  // SSE `event:` line — prefer payload.type.
  const type = payload.type || eventName;
  handleEvent(type, payload);
}

/** Strip Gemma-4-style reasoning tag leftovers. Hermes's stream processing
 *  removes the `<thought>...</thought>` XML wrappers but sometimes leaves
 *  the tag-NAME as standalone content ("thought" as the entire message).
 *  Same for `thinking`, `reasoning`, `analysis`, `commentary`.
 *
 *  Applied to both live delta text and restored-history text so the user
 *  never sees these single-word placeholder bubbles. Upstream fix is
 *  tracked in project_harmony_leak_findings.md; this sidekick-scoped
 *  stripper is the pragmatic path until hermes's /v1/responses SSE
 *  output runs through the same tag-strip the CLI path already does. */
const REASONING_TAG_RE = /^(?:thought|thinking|reasoning|analysis|commentary)(?:\s|$)/i;
export function stripReasoningLeak(text: string): string {
  if (!text) return text;
  // Drop entire message if it's JUST a reasoning-tag name
  if (/^(?:thought|thinking|reasoning|analysis|commentary)\s*$/i.test(text.trim())) {
    return '';
  }
  // Strip a leading "thought\n..." preamble that's a tag-name remnant
  const trimmed = text.replace(/^\s*(?:thought|thinking|reasoning|analysis|commentary)\s*\n+/i, '');
  return trimmed;
}

function handleEvent(type: string, d: any): void {
  switch (type) {
    case 'response.created':
    case 'response.in_progress':
    case 'response.output_item.added':
      // Pre-streaming lifecycle. Signal activity so the thinking indicator
      // brightens even before the first text chunk lands.
      subs?.onActivity?.({ working: true, detail: 'pending' });
      return;

    case 'response.output_text.delta': {
      const delta = d.delta || '';
      if (!delta) return;
      if (!currentReplyId) {
        currentReplyId = newReplyId();
        cumulativeText = '';
      }
      cumulativeText += delta;
      const cleaned = stripReasoningLeak(cumulativeText);
      if (!cleaned) return;   // all-reasoning so far; wait for real text
      subs?.onActivity?.({ working: true, detail: 'streaming' });
      subs?.onDelta?.({ replyId: currentReplyId, cumulativeText: cleaned });
      return;
    }

    case 'response.function_call.added':
    case 'response.function_call_arguments.delta': {
      const name = d.name || d.function?.name || 'tool';
      subs?.onActivity?.({ working: true, detail: name });
      subs?.onToolEvent?.({
        kind: 'tool_call',
        payload: { name, args: d.arguments || d.delta },
      });
      return;
    }

    case 'response.function_call_output.added':
      subs?.onToolEvent?.({
        kind: 'tool_result',
        payload: { name: d.name, output: d.output },
      });
      return;

    case 'response.completed': {
      const replyId = currentReplyId || newReplyId();
      // Hermes's completed event carries the final response; various fields
      // may hold the consolidated text depending on server version.
      const finalText =
        d.response?.output_text ??
        d.response?.output?.map?.((o: any) =>
          (o.content || []).map((c: any) => c.text || '').join('')
        ).join('\n') ??
        cumulativeText;
      currentReplyId = null;
      cumulativeText = '';
      subs?.onActivity?.({ working: false });
      subs?.onFinal?.({ replyId, text: stripReasoningLeak(finalText) });
      return;
    }

    case 'response.failed':
    case 'error': {
      const msg = d.error?.message || d.message || 'unknown error';
      log(`hermes error: ${msg}`);
      subs?.onActivity?.({ working: false });
      return;
    }

    default:
      // Not noisy — Hermes emits many lifecycle events we don't need to
      // surface (response.output_text.done, reasoning items, etc.).
      diag(`hermes: ignored event type=${type}`);
  }
}

export const hermesAdapter = {
  name: 'hermes',

  capabilities: {
    streaming: true,
    sessions: true,          // conversation name provides multi-session semantics
    models: true,            // GET /v1/models
    toolEvents: true,        // function_call / function_call_output
    history: false,          // no past-messages fetch API exposed
    attachments: false,      // MVP: skip
    sessionBrowsing: true,   // /api/hermes/sessions{,/<id>/messages} routes
  },

  async connect(opts: any) {
    subs = opts;
    const ok = await healthCheck();
    connected = ok;
    opts.onStatus?.(ok);
    if (ok) log('hermes: connected (health check ok)');
    else log('hermes: health check failed — is the gateway running?');
  },

  disconnect() {
    if (inflight) { try { inflight.abort(); } catch {} inflight = null; }
    connected = false;
  },

  reconnect() {
    healthCheck().then((ok) => {
      connected = ok;
      subs?.onStatus?.(ok);
      if (ok) log('hermes: reconnected');
    });
  },

  isConnected() {
    return connected;
  },

  async sendMessage(text: string, opts: any = {}) {
    if (!connected) {
      diag(`hermes.sendMessage: DROPPED (not connected)`);
      throw new Error('Gateway not connected');
    }
    // One in-flight request at a time; barge-in cancels the current one.
    if (inflight) { try { inflight.abort(); } catch {} }
    inflight = new AbortController();

    const body = {
      // Omit model so server falls back to config.yaml's default.
      conversation: conversationName,
      // Hermes doesn't use the "[voice]" in-band hint (that was an openclaw
      // convention — its agent was trained to be lenient with transcription
      // errors when it saw the prefix). Hermes models aren't, so the prefix
      // just leaks into the transcript without helping interpretation.
      input: text,
      stream: true,
    };

    try {
      const res = await fetch(`${apiBase()}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept': 'text/event-stream' },
        body: JSON.stringify(body),
        signal: inflight.signal,
      });
      if (!res.ok) {
        const err = await res.text().catch(() => '');
        throw new Error(`Hermes HTTP ${res.status}: ${err.slice(0, 160)}`);
      }
      subs?.onActivity?.({ working: true, detail: 'pending' });
      await parseSSE(res);
    } catch (e: any) {
      if (e.name === 'AbortError') {
        diag('hermes: request aborted');
        subs?.onActivity?.({ working: false });
        return;
      }
      diag(`hermes.sendMessage failed: ${e.message}`);
      subs?.onActivity?.({ working: false });
      throw e;
    } finally {
      inflight = null;
    }
  },

  newSession() {
    // Rotate the conversation name so next send starts fresh server-side.
    // Bump the token so any in-flight resumeSession that's still fetching
    // can't write its stale name over ours when it finally resolves.
    conversationName = `sidekick-${Date.now().toString(36)}`;
    conversationToken++;
    currentReplyId = null;
    cumulativeText = '';
    log(`hermes: new session (conversation=${conversationName})`);
  },

  async listModels() {
    // Hermes's own /v1/models just returns the 'hermes-agent' placeholder.
    // The real catalog comes from the configured provider (openrouter here)
    // — sidekick server fetches + caches it behind /api/hermes/models-catalog.
    // When SIDEKICK_PREFERRED_MODELS is set server-side, the route returns
    // {preferred, other, data} so we can tag each entry with a `group` field
    // and the settings UI can render an <optgroup> for the curated list.
    try {
      const r = await fetch(`${location.origin}/api/hermes/models-catalog`);
      if (!r.ok) return [];
      const d = await r.json();
      if (Array.isArray(d.preferred) && Array.isArray(d.other)) {
        // Preserve server ordering (already name-sorted) + prepend preferred.
        return [
          ...d.preferred.map((e: any) => ({ ...e, group: 'preferred' })),
          ...d.other.map((e: any) => ({ ...e, group: 'other' })),
        ];
      }
      return d.data || [];
    } catch {
      return [];
    }
  },

  async getCurrentModel() {
    // Server-side route shells out to `hermes config show` and parses the
    // active model ref. Returns null on any failure so the picker falls
    // back to "unknown" rather than mis-representing the server config.
    try {
      const r = await fetch(`${location.origin}/api/hermes/model`);
      if (!r.ok) return null;
      const d = await r.json();
      return (d && typeof d.model === 'string') ? d.model : null;
    } catch (e: any) {
      diag(`hermes.getCurrentModel failed: ${e.message}`);
      return null;
    }
  },

  async setModel(modelRef: string): Promise<boolean> {
    // Server-side route runs `hermes config set model <ref>` and restarts
    // the hermes-gateway systemd unit. Brief gateway downtime; the shell's
    // health-check loop reconnects via onStatus afterward. settings.ts
    // already handles this as fire-and-forget, so returning a promise is
    // fine (the sync contract in types.ts is advisory — nothing awaits).
    try {
      const r = await fetch(`${location.origin}/api/hermes/model`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: modelRef }),
      });
      if (!r.ok) {
        const err = await r.text().catch(() => '');
        diag(`hermes.setModel HTTP ${r.status}: ${err.slice(0, 160)}`);
        return false;
      }
      log(`hermes: model set to ${modelRef} (gateway restarting)`);
      return true;
    } catch (e: any) {
      diag(`hermes.setModel failed: ${e.message}`);
      return false;
    }
  },

  getCurrentSessionId() {
    return conversationName;
  },

  async listSessions(limit = 50) {
    try {
      // Read the user's session filter from settings (glob pattern like
      // 'sidekick-*'). Server accepts `?prefix=` and converts '*' → SQL
      // LIKE '%'. Imported lazily to avoid a circular init between
      // settings ↔ backend.
      let prefix = '';
      try {
        const settings = await import('../settings.ts');
        prefix = settings.get?.().sessionsFilter || '';
      } catch {}
      const q = new URLSearchParams({ limit: String(limit) });
      if (prefix) q.set('prefix', prefix);
      const r = await fetch(`${location.origin}/api/hermes/sessions?${q}`);
      if (!r.ok) return [];
      const d = await r.json();
      return d.sessions || [];
    } catch (e: any) {
      diag(`hermes.listSessions failed: ${e.message}`);
      return [];
    }
  },

  async resumeSession(id: string) {
    // Abort any in-flight reply on the PREVIOUS conversation — without this,
    // SSE deltas for the old session keep arriving after switch and get
    // rendered into the resumed (new) session's chat UI. Agent's reply
    // is still computed + stored server-side against the old conversation's
    // response chain; user can find it there if they resume that session
    // again. Just the live UI view gets cut off.
    if (inflight) { try { inflight.abort(); } catch {} inflight = null; }
    subs?.onActivity?.({ working: false });

    // Claim a token. If a newer op (newSession, another resumeSession) runs
    // between here and this fetch resolving, conversationToken will have
    // incremented — we'll see that and skip the write below.
    const myToken = ++conversationToken;

    const r = await fetch(`${location.origin}/api/hermes/sessions/${encodeURIComponent(id)}/messages`);
    if (!r.ok) {
      throw new Error(`resumeSession HTTP ${r.status}`);
    }
    const d = await r.json();
    if (myToken !== conversationToken) {
      // Superseded — another rotation happened while we were fetching. Don't
      // overwrite conversationName; return messages so the caller can still
      // use them (e.g., replay into chat if they want), but the adapter's
      // active conversation stays on whatever the latest op set it to.
      log(`hermes: resumeSession(${id}) superseded; not rewriting conversationName`);
      return { messages: d.messages || [] };
    }
    conversationName = id;
    currentReplyId = null;
    cumulativeText = '';
    log(`hermes: resumed session (conversation=${id}, ${d.messages?.length || 0} messages)`);
    return { messages: d.messages || [] };
  },

  async renameSession(id: string, title: string) {
    const r = await fetch(`${location.origin}/api/hermes/sessions/${encodeURIComponent(id)}/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (!r.ok) {
      const err = await r.text().catch(() => '');
      throw new Error(`renameSession HTTP ${r.status}: ${err.slice(0, 120)}`);
    }
    log(`hermes: renamed session ${id} → "${title}"`);
  },

  async deleteSession(id: string) {
    const r = await fetch(`${location.origin}/api/hermes/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!r.ok) {
      const err = await r.text().catch(() => '');
      throw new Error(`deleteSession HTTP ${r.status}: ${err.slice(0, 120)}`);
    }
    log(`hermes: deleted session ${id}`);
    // If the deleted session was the active one, rotate to a fresh
    // conversation name so the next send doesn't try to append to a
    // session hermes has forgotten.
    if (id === conversationName) {
      conversationName = `sidekick-${Date.now().toString(36)}`;
      currentReplyId = null;
      cumulativeText = '';
    }
  },
};
