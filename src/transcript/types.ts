/**
 * @fileoverview Canonical types for the projection model.
 *
 * The transcript is a PURE FUNCTION of
 * two non-overlapping sources of truth:
 *
 *   1. `state.db`        — durable rows from hermes / openclaw plugin's
 *                          `/v1/conversations/{id}/items` response.
 *   2. `TurnBuffer`      — in-flight envelopes for the current turn,
 *                          surfaced as the `inflight: [...]` field on
 *                          the same response.
 *
 * No live SSE handler is allowed to mutate the DOM directly. Each
 * envelope updates the per-chat `ChatState`; a reconciler re-derives
 * the bubble list and brings the DOM in line. This collapses the
 * cobble of distributed state stores (renderedMessages.entries,
 * activityRow.rows, pendingStreamingKey, pendingBubblesByChat, chat
 * snapshot DOM-string, sessionCache.messagesCache, …) into one
 * canonical model. Bugs that fall out of races between those stores
 * (out-of-order bubbles on switch-back, residual activity rows on a
 * "New chat" rotation, clumps after pagination) become impossible by
 * construction — there is one source, one derivation, one render.
 */

/**
 * Per-chat canonical state. The reconciler's only input.
 *
 * Lifecycle:
 *   - Populated by `/v1/conversations/{id}/items` responses (resume,
 *     refresh, post-turn).
 *   - Mutated incrementally by SSE envelopes (user_message, tool_call,
 *     tool_result, reply_delta, reply_final, etc.) — the handlers ONLY
 *     touch ChatState. DOM is downstream.
 *   - Snapshot-able to IDB so a cold-load can hydrate before the first
 *     fetch lands (replacing chat.persist()'s DOM-string snapshot).
 */
export interface ChatState {
  /** Durable rows from state.db. Time-ordered (oldest → newest). The
   *  shape comes straight from the plugin's items handler; consumers
   *  shouldn't assume any specific field set beyond what `BubbleSpec`
   *  inputs need. */
  durable: ConversationItem[];
  /** In-flight envelopes from TurnBuffer. Plugin emits these in the
   *  canonical order user_message → tool_call/result → reply_delta;
   *  this array preserves that order. */
  inflight: ParleyEnvelope[];
  /** Optimistic sends not yet acknowledged. The shell pre-mints a
   *  message_id, drops the row here, and waits for the matching
   *  `user_message` envelope to land in `inflight` (which dedups by
   *  message_id). On reply_final or timeout, the row clears. */
  pendingSends: PendingSend[];
  /** Latest `status` envelope for the chat (heartbeat text + arrival
   *  time). Cleared by a turn-ending reply_final. Optional so partial
   *  states in tests/fixtures stay valid. */
  turnStatus?: { text: string; at: number } | null;
  /** Most-recent pagination cursors from the items endpoint. Used by the
   *  load-earlier / load-later paths; not consumed by the projection
   *  itself. `firstId`/`hasMore` page OLDER (toward the head); `lastId`/
   *  `hasMoreNewer` page NEWER (toward the tail). `hasMoreNewer` is true
   *  only for a floating deep `around` window that hasn't yet been
   *  connected to the live tail; on a normal tail-anchored resume it's
   *  false (the loaded run already reaches the tail). */
  pagination: { firstId: number | null; hasMore: boolean; lastId: number | null; hasMoreNewer: boolean };
  /** Owner-scoped decorations (hardening phase 4): client-only rows
   *  that annotate the transcript without existing server-side —
   *  system lines ("New chat started", model-switch notes). Keyed +
   *  timestamped so the projection interleaves them and the reconciler
   *  owns their DOM (previously keyless DOM appends the reconciler had
   *  to tiptoe around). A separate bucket, untouched by durable /
   *  inflight mutations — the same "orthogonal markers" semantics the
   *  old DOM rows had, now per-chat and replay-safe. */
  decorations: Decoration[];
}

export type Decoration = SystemDecoration | MemoDecoration;

export interface SystemDecoration {
  /** Stable reconcile key: `deco_${ts}_${rand}`. */
  key: string;
  kind: 'system';
  text: string;
  /** Wall-clock ms — sorts the row into the transcript. */
  timestamp: number;
}

/** A pending voice-memo card, addressed to the chat it was RECORDED
 *  in. The decoration declares existence + timeline position; the
 *  memo's data (blob, waveform, transcript, status) lives in the
 *  voiceMemos IDB store with an in-memory mirror in memoCard's rec
 *  registry, and playback state lives in the DOM node the reconciler
 *  preserves via keyed identity. */
export interface MemoDecoration {
  /** Stable reconcile key: `memo:${memoId}`. */
  key: string;
  kind: 'memo';
  memoId: string;
  timestamp: number;
}

export interface PendingSend {
  messageId: string;
  text: string;
  /** Source icon — voice / typed / sent. */
  source?: 'voice' | 'text' | 'sent';
  /** Wall-clock at send (ms). Sorts the bubble into the transcript
   *  alongside durable rows. */
  sentAt: number;
  /** Set when the send POST returned a non-2xx; surfaces the Retry
   *  affordance on the bubble. */
  failed?: boolean;
  /** Attachments threaded through atomic-send (Q1). */
  attachments?: Array<{ dataUrl: string; mimeType: string; fileName?: string }>;
}

/**
 * One row from the plugin's items endpoint. Lifted from the existing
 * ad-hoc shape — see `proxy/parley/upstream.ts` ConversationItem.
 */
export interface ConversationItem {
  id: number | string;
  role: 'user' | 'assistant' | 'tool' | 'system' | 'notification' | 'gap';
  content: string;
  /** Parley wire-shape id (umsg_… / msg_…). Optional; older plugin
   *  rows or legacy adapters omit it and we fall back to `id`. */
  parley_id?: string;
  /** State.db extensions on assistant rows that issued tool calls. */
  tool_calls?: string;   // JSON array of {id, type:'function', function: {name, arguments}}
  tool_call_id?: string; // on role='tool' rows — links back to the call
  tool_name?: string;
  /** Notification discriminator (cron / reminder / approval). Surfaces
   *  the appropriate emoji + label in the projection. */
  kind?: string;
  /** Gap-marker metadata (role==='gap' only). Explicit boundary ids so
   *  the projection emits a stable GapBubbleSpec without depending on
   *  the row's array neighbours (durable is timestamp-sorted downstream,
   *  so array position is NOT a reliable boundary signal). `gap_after_id`
   *  is the NUMERIC cursor the load-gap handler fetches AFTER to shrink
   *  the gap from its older edge. */
  gap_older_id?: string | null;
  gap_newer_id?: string | null;
  gap_after_id?: number | null;
  /** Timestamp — unix seconds (hermes) or ms (openclaw / openai-compat).
   *  Projection normalizes. */
  timestamp?: number;
  created_at?: number;
}

/**
 * SSE-shape envelope. Mirror of `proxy/parley/upstream.ts`
 * ParleyEnvelope. Re-declared here so this module can be imported
 * without a circular dep through the proxy layer.
 */
export type ParleyEnvelope =
  | { type: 'reply_delta'; chat_id: string; text: string; message_id: string; edit?: boolean; interim?: boolean }
  | { type: 'reply_final'; chat_id: string; message_id: string; text?: string; interim?: boolean }
  | { type: 'tool_call'; chat_id: string; call_id: string; tool_name: string; args: unknown; started_at?: string }
  | { type: 'tool_result'; chat_id: string; call_id: string; tool_name: string; result: unknown; duration_ms?: number }
  | { type: 'typing'; chat_id: string }
  /** Ephemeral working indicator. The hermes plugin converts the gateway's
   *  "⏳ Working — N min — iteration i/n, tool" heartbeat into this (keyed
   *  `status_<chat>`), so it renders as the turn-status line, never a
   *  bubble. Not persisted; ignored on ring replay. */
  | { type: 'status'; chat_id: string; message_id?: string; text?: string; state?: 'working' | 'done'; ts?: number }
  | { type: 'image'; chat_id: string; url: string; caption?: string }
  | { type: 'notification'; chat_id: string; kind: string; content: string; parley_id?: string }
  | { type: 'session_changed'; chat_id: string; session_id: string; title: string }
  | { type: 'user_message'; chat_id: string; message_id: string; text: string }
  | { type: 'error'; chat_id: string; message: string };

/**
 * Output of the projection — the canonical bubble list. The reconciler
 * walks this and brings DOM into agreement.
 *
 * Every BubbleSpec carries a stable `key` that the reconciler uses to
 * preserve DOM identity across re-projections (so the user's text
 * selection, scroll position, copy-button state, etc. survive). The
 * key is `message_id` for plain bubbles, `turn:${ts}` for activity
 * rows that group a turn's tool calls.
 */
export type BubbleSpec =
  | UserBubbleSpec
  | AssistantBubbleSpec
  | NotificationBubbleSpec
  | ActivityRowSpec
  | GapBubbleSpec
  | SystemLineSpec
  | MemoCardSpec
  | TurnStatusSpec;

/** "Agent is working" line pinned to the bottom of the transcript while a
 *  turn is in flight (live send not yet answered, an open activity row, or
 *  a fresh heartbeat). `text` is the human label ("Thinking", "Working ·
 *  3 min · iteration 4/60 · terminal"). Exactly one per chat, fixed key. */
export interface TurnStatusSpec {
  kind: 'turnStatus';
  key: string;
  timestamp: number;
  text: string;
}

/** A client-only system line ("New chat started", "Model: …"). Derived
 *  from ChatState.decorations — reconciler-owned DOM, unlike the legacy
 *  keyless `.line.system` appends it replaces (hardening phase 4). */
export interface SystemLineSpec {
  kind: 'systemLine';
  key: string;
  text: string;
  timestamp: number;
}

/** A pending voice-memo playback card. Derived from a MemoDecoration;
 *  the reconciler renders it once via memoCard's registry and then
 *  PRESERVES the node (update is a no-op) — waveform/status/transcript
 *  updates flow through the card's own DOM hooks, and playback state
 *  survives reconciles because the node does. */
export interface MemoCardSpec {
  kind: 'memoCard';
  key: string;
  memoId: string;
  timestamp: number;
}

/**
 * A discontinuity marker between two non-contiguous runs of durable
 * rows. Produced when a deep-drill window is spliced alongside the tail
 * (instead of replacing it), or when a merge can't prove two pages are
 * adjacent. Renders as an inline "…" placeholder the user can tap (or
 * scroll into) to load the missing range — making a true gap VISIBLE
 * and recoverable instead of a silent hole (the #223 / missing-user-
 * bubble class). When the range on either side becomes contiguous the
 * gap row is dropped.
 */
export interface GapBubbleSpec {
  kind: 'gap';
  /** Stable reconcile key: `gap:${olderId}:${newerId}`. */
  key: string;
  timestamp: number;
  /** Last id of the run ABOVE the gap (older side), or null at head. */
  olderId: string | null;
  /** First id of the run BELOW the gap (newer side), or null at tail. */
  newerId: string | null;
  /** Numeric cursor the load-gap handler fetches AFTER to shrink the gap
   *  from its older edge (loadLater(afterId)). Null when unknown. */
  afterId: number | null;
}

export interface UserBubbleSpec {
  kind: 'user';
  /** Stable reconcile key. message_id from the user_message envelope
   *  or parley_id from a durable row. */
  key: string;
  text: string;
  /** Wall-clock; ms. */
  timestamp: number;
  /** `true` while the optimistic bubble is awaiting the server's
   *  user_message echo + reply_final ack. */
  pending?: boolean;
  /** `true` if the send POST returned an error. Surfaces Retry. */
  failed?: boolean;
  source?: 'voice' | 'text' | 'sent';
  attachments?: Array<{ dataUrl: string; mimeType: string; fileName?: string }>;
}

export interface AssistantBubbleSpec {
  kind: 'assistant';
  /** Stable reconcile key. message_id (preferred), or
   *  pending:turn:${turnTs} for a turn we KNOW is in flight but
   *  hasn't emitted a reply_delta with a real id yet. */
  key: string;
  text: string;
  timestamp: number;
  /** `true` while the turn is in flight (no reply_final). Drives the
   *  .streaming class + thinking dots. */
  streaming?: boolean;
}

export interface NotificationBubbleSpec {
  kind: 'notification';
  key: string;
  text: string;
  timestamp: number;
  /** 'cron' / 'reminder' / etc. — emoji + label dispatch. */
  notificationKind: string;
}

export interface ActivityRowSpec {
  kind: 'activityRow';
  /** Stable reconcile key: `turn:${user_message_id || turn_started_at}`.
   *  All tool calls/results from the same turn collapse onto one row. */
  key: string;
  /** Anchor timestamp — the parent user_message's ts. Used to sort
   *  the row in the transcript. */
  timestamp: number;
  tools: ActivityTool[];
  /** `true` once the turn's reply_final has fired (or a subsequent
   *  user message has marked the turn complete). Drives the
   *  "running…" → "done" label transition. */
  complete: boolean;
}

export interface ActivityTool {
  callId: string;
  name: string;
  args: unknown;
  result?: unknown;
  durationMs?: number;
}
