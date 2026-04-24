/**
 * @fileoverview OpenClaw BackendAdapter. Wraps the low-level gateway WS
 * (src/gateway.ts) + model-catalog queries (src/models.ts) into the
 * normalized BackendAdapter interface so the shell doesn't need to know
 * about openclaw's wire format.
 *
 * What this module hides from the shell:
 *   - The `connect.challenge` → authenticated-connect handshake
 *   - openclaw's chat delta/final payload shape (p.state === 'delta'
 *     inside p.message.content[0].text, etc.)
 *   - The `tool.canvas.show` and `tool-event` envelope variants
 *   - Session-keyed calls (hardcoded sessionKey: 'agent:main:main')
 *   - The model-override slash-command mechanism
 *
 * @typedef {import('./types.ts').BackendAdapter} BackendAdapter
 * @typedef {import('./types.ts').ConnectOpts} ConnectOpts
 * @typedef {import('./types.ts').SendOpts} SendOpts
 */

import * as gateway from '../gateway.ts';
import * as models from '../models.ts';
import { log, diag } from '../util/log.ts';
import { setDebugStatus } from '../status.ts';
import { gwWsUrl } from '../config.ts';

/** Reply-ID state. OpenClaw's wire doesn't tag deltas with a stable reply
 *  id — the agent streams until a `final` event closes it. We mint an id
 *  on first delta after each final, and use the same id for all
 *  subsequent deltas + the final event. */
let currentReplyId = null;
function newReplyId() {
  return `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── OpenClaw in-band prefix conventions ────────────────────────────────────
// OpenClaw uses bracket-prefix strings inside message text to hint the
// channel / modality. The webchat is one of many channels; in history we
// see messages that came in through WhatsApp ('[WhatsApp]'), Telegram,
// Slack threads, voice dictation ('[voice]'), etc. The shell shouldn't
// need to know about these — we strip them on the way up and apply them
// on the way down.

/** True if `text` starts with a user-origin prefix (voice / live-transcript).
 *  Used to filter agent deltas that occasionally re-echo the user's own
 *  message back (post-/reset flows, some tool interactions). */
function isUserEchoPrefix(text) {
  return text.startsWith('[voice]') || text.startsWith('[Live transcript');
}

/** Strip in-band prefixes from a user-history message so the shell gets
 *  clean display text. Order matters: strip channel marker first, then
 *  nested voice/speaker prefixes that may be wrapped inside. */
function stripUserPrefixes(text) {
  return text
    .replace(/^\[voice\]\s*/i, '')
    .replace(/^\[Voice (?:mode|transcript)[^\]]*\]\s*/gi, '')
    .replace(/^\[Live transcript\]\s*/i, '')
    .replace(/^\[Speaker \d+\]\s*/g, '')
    .trim();
}

/** True for internal openclaw chatter the user shouldn't see in history:
 *  "System:" status lines, "__openclaw_..." synthetic events, etc. */
function isInternalSystemMessage(text) {
  return text.startsWith('System:') || text.startsWith('__openclaw');
}

let subs: {
  onStatus?: (c: boolean) => void,
  onDelta?: (d: any) => void,
  onFinal?: (f: any) => void,
  onToolEvent?: (e: any) => void,
  onActivity?: (a: { working: boolean, detail?: string }) => void,
} = {};

// ── Canvas side-channel WS ──────────────────────────────────────────────────
// OpenClaw's server exposes /ws/canvas — a secondary WebSocket where the
// openclaw-canvas CLI tool pushes structured cards (links, images, youtube,
// spotify, etc.) that the agent emits out-of-band. They're delivered as
// normalized onToolEvent({ kind: 'canvas.show', payload }) — same shape
// as canvas.show events that arrive through the main chat WS, so the
// shell's handleToolEvent handles both paths uniformly.
//
// This lives here (not in the shell) because the /ws/canvas endpoint is
// openclaw-server-specific; other backends don't need it.
let canvasWs = null;

function connectCanvasWs() {
  if (typeof WebSocket === 'undefined') return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  canvasWs = new WebSocket(`${proto}//${location.host}/ws/canvas`);
  canvasWs.onmessage = (ev) => {
    try {
      const card = JSON.parse(ev.data);
      if (card.kind === '_dismiss') return;  // legacy; no longer meaningful
      log('canvas ws: received', card.kind, card.meta?.title || '');
      subs.onToolEvent?.({ kind: 'canvas.show', payload: card });
    } catch (e) {
      log('canvas ws: bad message', e.message);
    }
  };
  canvasWs.onclose = () => { canvasWs = null; setTimeout(connectCanvasWs, 3000); };
  canvasWs.onerror = () => {};
}

function disconnectCanvasWs() {
  if (canvasWs) {
    // Clear handlers to prevent auto-reconnect, then close.
    canvasWs.onclose = null;
    canvasWs.onerror = null;
    canvasWs.onmessage = null;
    try { canvasWs.close(); } catch {}
    canvasWs = null;
  }
}

/** Our session key. Agent events for other sessions (heartbeat crons,
 *  isolated subagent runs) fire through the same WS and would cause
 *  spurious activity signals in our UI if we didn't filter. */
const OUR_SESSION_KEY = 'agent:main:main';

/** Interpret a raw gateway event and fan it out to normalized handlers. */
function dispatch(d) {
  // Agent-run events — this is where openclaw actually surfaces tool
  // activity. Earlier code looked for `event: 'tool-event'` / `'tool.canvas.show'`
  // but the gateway emits `event: 'agent'` with a `stream` field:
  //   stream='tool'            — agent is invoking a tool (data.tool has the name)
  //   stream='item'            — agent emitted a message/content item
  //   stream='plan'            — plan update
  //   stream='command_output'  — stdout/stderr from an exec tool
  //   stream='approval'        — permission prompt
  //   stream='patch'           — file diff applied
  //   stream='assistant'       — assistant text (redundant with chat deltas, skip)
  //   stream='lifecycle'       — {phase: start|end|error}
  //   stream='error'           — gateway-emitted error (e.g. seq gap)
  //
  // Filtering to OUR_SESSION_KEY is critical — heartbeats run every 30m
  // and their agent events arrive on the same WS. Without this filter,
  // a heartbeat tool call would flip the thinking indicator in the UI
  // even when the user isn't in a conversation.
  if (d.type === 'event' && d.event === 'agent') {
    const p = d.payload || {};
    if (p.sessionKey && p.sessionKey !== OUR_SESSION_KEY) return;
    const stream = p.stream;
    if (stream === 'assistant' || stream === 'error') return;  // redundant/noise
    if (stream === 'lifecycle') {
      // lifecycle phases: start → the run is active; end → done.
      // chat.final handles "done" for text replies; lifecycle.end fires
      // even when no text reply was emitted (tool-only turns), so map
      // it to onActivity working=false as a safety net.
      if (p.data?.phase === 'end' || p.data?.phase === 'error') {
        subs.onActivity?.({ working: false });
      } else if (p.data?.phase === 'start') {
        subs.onActivity?.({ working: true, detail: 'starting' });
      }
      return;
    }
    // Tool / item / plan / command_output / approval / patch — all count
    // as "agent is working." Friendly detail for tool calls names the tool.
    let detail = stream || 'working';
    if (stream === 'tool') {
      const toolName = p.data?.tool || p.data?.name;
      if (toolName) detail = toolName;
      // If it's a canvas.show tool call, also route to onToolEvent so
      // the card renders inline — same shape handleToolEvent expects.
      if (p.data?.tool === 'canvas.show' && p.data?.data) {
        subs.onToolEvent?.({ kind: 'canvas.show', payload: p.data.data });
      }
    }
    subs.onActivity?.({ working: true, detail });
    return;
  }
  if (d.type === 'event' && d.event === 'chat') {
    const p = d.payload || {};
    // Trace every chat event — source channel, state, text head — to
    // diagnose the "[Clawdian] Model set…" vs "Model set…" double-render.
    // Silent unless ?debug=1 or localStorage.sidekick_debug=1.
    {
      const t = p.message?.content?.find?.((c) => c?.type === 'text')?.text || '';
      diag(`chat evt: state=${p.state} session=${p.sessionKey || '-'} text="${t.slice(0, 80)}"`);
      // Mirror to the header debug line for at-a-glance inspection.
      setDebugStatus(`chat.${p.state}: ${t.slice(0, 50)}`);
    }
    if (p.state === 'delta') {
      const content = p.message?.content || [];
      const textBlock = content.find(c => c.type === 'text');
      const partialText = textBlock?.text || '';
      if (!partialText) return;
      // Drop echoes of the user's own message — openclaw occasionally
      // replays the user message back as an agent delta after /reset or
      // during certain tool flows. The user-prefix convention lets us
      // identify them without context-window tracking.
      if (isUserEchoPrefix(partialText)) return;
      if (!currentReplyId) currentReplyId = newReplyId();
      subs.onActivity?.({ working: true, detail: 'streaming' });
      subs.onDelta?.({ replyId: currentReplyId, cumulativeText: partialText });
      return;
    }
    if (p.state === 'final') {
      const content = p.message?.content || [];
      const textBlock = content.find(c => c.type === 'text');
      const text = textBlock?.text || '';
      if (isUserEchoPrefix(text)) return;
      const replyId = currentReplyId || newReplyId();
      currentReplyId = null;
      subs.onActivity?.({ working: false });
      subs.onFinal?.({ replyId, text, content });
      return;
    }
  }
  // Unknown event types — heartbeat echoes, agent.start/end variants,
  // model_fallback_decision, etc. Logged behind the debug flag so a
  // future session can observe what openclaw actually pushes and wire
  // additional activity signals (e.g. "retrying after fallback…"). Not
  // surfaced to the shell otherwise — silence is better than noise.
  if (d.type === 'event') {
    diag(`openclaw event (unhandled): ${d.event}`);
  }
}

/** @type {BackendAdapter} */
export const openclawAdapter = {
  name: 'openclaw',

  capabilities: {
    streaming: true,
    sessions: true,
    models: true,
    toolEvents: true,
    history: true,
    attachments: true,
  },

  async connect(opts) {
    subs = opts;
    const { getConfig } = await import('../config.ts');
    const cfg = getConfig();
    gateway.connect({
      wsUrl: gwWsUrl(),
      token: cfg.gwToken,
      onStatus: (c) => opts.onStatus?.(c),
      onEvent: dispatch,
    });
    // Secondary side-channel for agent-emitted cards. Auto-reconnects on
    // close so it survives gateway hiccups too.
    connectCanvasWs();
  },

  disconnect() {
    gateway.disconnect();
    disconnectCanvasWs();
  },

  reconnect() {
    gateway.reconnect();
  },

  isConnected() {
    return gateway.isConnected();
  },

  sendMessage(text, opts: { voice?: boolean; attachments?: any[] } = {}) {
    // Apply openclaw's voice convention — agent reads "[voice]" as a hint
    // to be lenient about transcription errors. Shell passes voice:true
    // from dictation / memo paths; we prefix here so the shell doesn't
    // need to know the convention.
    const finalText = opts?.voice ? `[voice] ${text}` : text;
    gateway.sendChat(finalText, opts);
  },

  /** Start a new agent session. OpenClaw convention: the "/new" slash
   *  command sent over the chat channel tells the agent to rotate the
   *  session. Local UI cleanup (chat.clear, draft.dismiss, etc.) is the
   *  caller's responsibility. */
  newSession() {
    gateway.sendChat('/new');
  },

  async fetchHistory(limit = 50) {
    const raw = await gateway.fetchHistory('agent:main:main', limit);
    if (!Array.isArray(raw)) return [];
    // Apply openclaw-convention post-processing so the shell sees clean
    // display text. User messages that were internal-system or came in
    // through other channels are filtered out; prefixes are stripped.
    return raw
      .map((msg) => {
        const content = Array.isArray(msg.content) ? msg.content : [];
        const textBlock = content.find((c) => c?.type === 'text');
        const rawText = textBlock?.text || msg.text || '';
        if (msg.role === 'user') {
          if (isInternalSystemMessage(rawText)) return null;
          const cleaned = stripUserPrefixes(rawText);
          if (!cleaned) return null;
          return { ...msg, text: cleaned };
        }
        if (msg.role === 'assistant') {
          // Strip leading '[AnyLabel] ' wrappers the agent sometimes
          // receives in its own history from other-channel replies.
          const cleaned = rawText.replace(/^\[[A-Za-z0-9_\- ]+\]\s*/, '');
          if (cleaned.startsWith('System:')) return null;
          return { ...msg, text: cleaned };
        }
        return msg;
      })
      .filter((m) => m !== null);
  },

  async listModels() {
    try { return await models.listModels(); }
    catch { return []; }
  },

  async getCurrentModel() {
    try { return await models.getCurrentModel(); }
    catch { return null; }
  },

  setModel(ref) {
    return models.setSessionModel(ref);
  },
};
