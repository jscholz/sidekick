/**
 * @fileoverview Single source-of-truth rendered-message map keyed by
 * adapter-supplied `message_id`. Replaces the ad-hoc dedup machinery
 * (defensive `data-message-id` checks in handleReplyDelta /
 * handleReplyFinal, the `bubbleReplyIds` map + `seenEventIds` set in
 * the proxy client, the `bubbleAlreadyRendered` DOM-query helper).
 *
 * The two render paths (history fetch via `renderHistoryMessage` and
 * SSE via `showStreamingIndicator` + `finalizeStreamingBubble`) both
 * call `upsert(messageId, partial)`. New messageId → fresh bubble +
 * map entry; existing → in-place update of the same bubble. Order
 * within the transcript is decided by insertion order at create time
 * (history renders oldest→newest; live SSE always appends to the
 * tail).
 *
 * Invariants:
 *   - exactly one bubble per messageId in the DOM at any time;
 *   - `getStreaming()` returns the unique entry whose status is
 *     'streaming' (only one is allowed in flight per the
 *     `:not(.streaming)` selector contract elsewhere).
 *
 * Pending bubbles created by `showThinking()` before any messageId is
 * known are stored under a synthetic `pending:${tempId}` key. On the
 * first delta carrying a real messageId, the caller invokes
 * `migrate(pendingKey, realMessageId)` to swap the map key and stamp
 * `data-message-id` on the bubble.
 */

import * as chat from './chat.ts';
import { miniMarkdown } from './util/markdown.ts';

export type Role = 'user' | 'assistant';
export type Status = 'streaming' | 'finalized';

export interface UpsertPartial {
  role: Role;
  /** Cumulative text for the bubble. Streaming deltas pass the latest
   *  cumulative slice; finalized writes the canonical text. */
  text: string;
  status: Status;
  /** Speaker label override. Defaults: 'You' for user, caller-supplied
   *  agent label for assistant — pass it explicitly so this module
   *  doesn't need to know about settings. */
  speaker: string;
  /** Bubble class string passed straight through to `chat.addLine`.
   *  Caller decides 'agent', 'agent streaming', 'agent streaming pending',
   *  's0' for user, etc. Only consulted on CREATE — subsequent updates
   *  manage the .streaming / .pending classes by status transition. */
  cls: string;
  /** Reply id stamped on the bubble for TTS / play-bar linkage. */
  replyId?: string;
  timestamp?: number | Date | string;
  /** Render markdown vs. plain. Only consulted on CREATE; updates in
   *  place use the same path so the original setting is preserved. */
  markdown?: boolean;
  /** History-fetch path uses prepend+batch when lazy-loading earlier
   *  pages. Only consulted on CREATE. */
  prepend?: boolean;
  batch?: boolean;
  attachments?: Array<{ dataUrl: string; mimeType: string; fileName?: string }>;
  /** Atomic-send (Q1) optimistic user bubble. Only consulted on CREATE. */
  pending?: boolean;
  /** Input-source icon (voice / typed / sent). Only consulted on CREATE. */
  source?: 'voice' | 'text' | 'sent';
}

interface Entry {
  el: HTMLElement;
  status: Status;
  markdown: boolean;
}

const entries = new Map<string, Entry>();

/** Idempotent upsert — returns the bubble element for `messageId`. New
 *  → creates a fresh DOM bubble via `chat.addLine` and registers it.
 *  Existing → updates text/status in place and returns the same
 *  element. Safe to call any number of times for the same messageId
 *  with monotonically growing cumulative text. */
export function upsert(messageId: string, partial: UpsertPartial): HTMLElement | null {
  const existing = entries.get(messageId);
  if (existing) {
    return updateExisting(existing, partial);
  }
  return create(messageId, partial);
}

function create(messageId: string, partial: UpsertPartial): HTMLElement | null {
  const el = chat.addLine(partial.speaker, partial.text, partial.cls, {
    markdown: partial.markdown,
    timestamp: partial.timestamp,
    attachments: partial.attachments,
    replyId: partial.replyId,
    messageId,
    prepend: partial.prepend,
    batch: partial.batch,
    pending: partial.pending,
    source: partial.source,
  }) as HTMLElement | null;
  if (!el) return null;
  entries.set(messageId, {
    el,
    status: partial.status,
    markdown: !!partial.markdown,
  });
  return el;
}

function updateExisting(entry: Entry, partial: UpsertPartial): HTMLElement {
  const { el } = entry;
  // Text update — re-render the .text span. Path mirrors
  // showStreamingIndicator's existing in-place mutation so behavior
  // is identical to the pre-refactor baseline.
  if (partial.text != null) {
    const textSpan = el.querySelector('.text');
    if (textSpan) {
      textSpan.innerHTML = entry.markdown ? miniMarkdown(partial.text) : escapeText(partial.text);
    }
    el.dataset.text = partial.text;
  }
  // Status transition — streaming → finalized strips the .streaming
  // class and the thinking-dots span. Mirrors finalizeStreamingBubble.
  if (entry.status === 'streaming' && partial.status === 'finalized') {
    el.classList.remove('streaming');
    const dots = el.querySelector('.thinking-dots');
    if (dots) dots.remove();
    el.querySelectorAll('a').forEach(a => { a.target = '_blank'; (a as HTMLAnchorElement).rel = 'noopener'; });
  }
  entry.status = partial.status;
  // replyId can change (pending bubble adopting the real reply id
  // when the first delta arrives). Other id fields don't change once
  // the bubble exists, so don't re-stamp them.
  if (partial.replyId) el.dataset.replyId = partial.replyId;
  return el;
}

function escapeText(s: string): string {
  return s.replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
  }[ch]!));
}

/** Wipe both the in-memory map and the transcript DOM children. */
export function clear(): void {
  entries.clear();
  // chat.clear() owns DOM wipe + snapshot purge + viewedSessionIdRef
  // reset; route through it so we don't have two independent wipe
  // paths to maintain.
  chat.clear();
}

/** Return the (at most one) bubble currently in the streaming state.
 *  Replaces the module-level `streamingEl` ref in main.ts. */
export function getStreaming(): HTMLElement | null {
  for (const entry of entries.values()) {
    if (entry.status === 'streaming') return entry.el;
  }
  return null;
}

export function has(messageId: string): boolean {
  return entries.has(messageId);
}

/** Pending-bubble migration: when `showThinking` registers a bubble
 *  under `pending:${tempId}` and the first delta arrives with a real
 *  message_id, swap the map key + stamp `data-message-id` on the
 *  bubble. No-op if `tempKey` isn't tracked (defensive — the caller
 *  may have already migrated, or the pending bubble was wiped by a
 *  clear()). */
export function migrate(tempKey: string, realMessageId: string): HTMLElement | null {
  const entry = entries.get(tempKey);
  if (!entry) return null;
  entries.delete(tempKey);
  // If the real id is already mapped (race: history fetch landed
  // between showThinking and the first delta), drop the synthetic
  // pending bubble — the real one is the source of truth.
  if (entries.has(realMessageId)) {
    entry.el.remove();
    return entries.get(realMessageId)!.el;
  }
  entries.set(realMessageId, entry);
  entry.el.dataset.messageId = realMessageId;
  return entry.el;
}

/** Drop a single entry by id. Used for pending-bubble cleanup paths
 *  that don't have a real message_id to migrate to (idle timeout,
 *  send aborted before any delta). */
export function remove(messageId: string): void {
  const entry = entries.get(messageId);
  if (!entry) return;
  entries.delete(messageId);
  entry.el.remove();
}
