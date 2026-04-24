/**
 * @fileoverview In-memory cache of synthesized TTS audio per agent reply.
 *
 * Every agent reply gets a stable `replyId`. When a reply finishes playback
 * through the TTS pipeline, tts.ts snapshots its chunk buffers into this
 * cache. Subsequent clicks on that reply's play button replay instantly
 * from the cached AudioBuffers — no /tts network roundtrip, no decode.
 *
 * Visual contract:
 *   - not cached → grey play icon on the bubble ("click to generate")
 *   - cached     → sage play icon ("click to play instantly")
 *   - playing    → bright-sage pause icon
 *
 * Cache is keyed on replyId + voiceId: if the user swaps TTS voice,
 * entries synthesized with the old voice are dropped so the user never
 * hears a voice they didn't pick.
 *
 * Bounded by bytes (default 7 MB). LRU eviction on overflow — oldest
 * (least-recently-accessed) entry drops first and fires an 'evicted'
 * event so the UI can flip that bubble's icon back to grey.
 */

import { log } from '../../util/log.ts';

/** Cache budget. Raised from 7MB after a 6MB-reply evicted a paused-mid-
 *  playback reply during commute use — each new reply tipped the budget
 *  over and LRU dropped the entry the user was actively returning to.
 *  50MB holds ~8-10 typical replies; modern browsers are fine with this. */
const MAX_BYTES = 50_000_000;

/** Currently-active reply id (playing / paused / ended). Set by tts.ts
 *  at begin/playCached/replay, cleared on stop. Pinned entries are
 *  exempt from LRU eviction — the user is mid-interaction with them and
 *  a cache miss on the current reply causes an unnecessary resynth. */
let pinnedId = null;
export function setPinnedId(id) { pinnedId = id || null; }

/**
 * @typedef {{
 *   replyId: string,
 *   chunks: string[],
 *   buffers: AudioBuffer[],
 *   durations: number[],
 *   chunkChars: number[],
 *   cumulativeChars: number,
 *   voiceId: string,
 *   totalBytes: number,
 *   lastAccessAt: number,
 *   lastPosition: number | null,  // seconds; set when playback is superseded/stopped mid-track
 * }} CacheEntry
 */

/** @type {Map<string, CacheEntry>} */
const cache = new Map();
let totalBytes = 0;

// Event emitter — UI subscribes to 'cached' and 'evicted' to flip icon state.
const listeners = new Map();
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
}
export function off(event, fn) { listeners.get(event)?.delete(fn); }
function emit(event, payload) {
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of set) {
    try { fn(payload); } catch (e) { log('replyCache listener err:', e.message); }
  }
}

function computeBytes(buffers) {
  // AudioBuffer memory ≈ samples × channels × 4 bytes (Float32 per sample).
  let n = 0;
  for (const b of buffers) {
    if (b) n += b.length * b.numberOfChannels * 4;
  }
  return n;
}

function evictUntil(bytesFree) {
  // LRU: drop oldest entries until we have `bytesFree` headroom. Pinned
  // entry (the currently-active reply) is skipped — losing it would
  // force a resynth of audio the user is actively listening to.
  if (totalBytes + bytesFree <= MAX_BYTES) return;
  const ordered = [...cache.entries()].sort((a, b) => a[1].lastAccessAt - b[1].lastAccessAt);
  for (const [id, entry] of ordered) {
    if (totalBytes + bytesFree <= MAX_BYTES) break;
    if (id === pinnedId) continue;
    cache.delete(id);
    totalBytes -= entry.totalBytes;
    emit('evicted', { replyId: id });
    log(`replyCache evicted ${id} (${(entry.totalBytes/1e6).toFixed(1)}MB), total now ${(totalBytes/1e6).toFixed(1)}MB`);
  }
}

/** Store a synthesized reply. Silently skips if any buffer is missing (a
 *  failed chunk) or if the total exceeds MAX_BYTES on its own. */
export function put(replyId, payload) {
  if (!replyId) return false;
  // Allow null entries for chunks that haven't been synthesized yet —
  // precacheFirstChunk writes a partial entry with just chunk 0, and
  // playCached lazy-fills the rest on play. At least ONE buffer must
  // be a real AudioBuffer; an entry of all-nulls is useless.
  if (!payload.buffers.some(b => b instanceof AudioBuffer)) return false;
  if (!payload.buffers.every(b => b == null || b instanceof AudioBuffer)) return false;
  const size = computeBytes(payload.buffers);
  if (size === 0 || size > MAX_BYTES) return false;
  // Replace existing entry for this id (could be a re-generation).
  const existing = cache.get(replyId);
  if (existing) {
    totalBytes -= existing.totalBytes;
    cache.delete(replyId);
  }
  evictUntil(size);
  const entry = /** @type {CacheEntry} */ ({
    replyId,
    chunks: payload.chunks.slice(),
    buffers: payload.buffers.slice(),
    durations: payload.durations.slice(),
    chunkChars: payload.chunkChars.slice(),
    cumulativeChars: payload.cumulativeChars,
    voiceId: payload.voiceId,
    totalBytes: size,
    lastAccessAt: Date.now(),
    lastPosition: existing?.lastPosition ?? null,  // preserve across re-cache
  });
  cache.set(replyId, entry);
  totalBytes += size;
  emit('cached', { replyId });
  log(`replyCache stored ${replyId} (${(size/1e6).toFixed(1)}MB), total ${(totalBytes/1e6).toFixed(1)}MB across ${cache.size} entries`);
  return true;
}

/** Fetch a cached reply. Bumps its LRU timestamp. */
export function get(replyId) {
  const e = cache.get(replyId);
  if (!e) return null;
  e.lastAccessAt = Date.now();
  return e;
}

export function has(replyId) { return cache.has(replyId); }

/** Remember where playback was when the user skipped away from this reply.
 *  Used so prev/next buttons can resume mid-track instead of restarting.
 *  `position` is in seconds; pass null to forget (e.g. natural end). */
export function setPosition(replyId, position) {
  const e = cache.get(replyId);
  if (!e) return;
  e.lastPosition = position;
}

/** Last known playback position (seconds) for this reply, or null if never
 *  saved or explicitly cleared. */
export function getPosition(replyId) {
  const e = cache.get(replyId);
  return e ? e.lastPosition : null;
}

/** Drop all entries whose voiceId differs from the supplied id. Called on
 *  TTS voice change so stale audio doesn't secretly play back in the
 *  previous voice. */
export function invalidateOtherVoices(currentVoiceId) {
  let dropped = 0;
  for (const [id, entry] of cache) {
    if (entry.voiceId !== currentVoiceId) {
      cache.delete(id);
      totalBytes -= entry.totalBytes;
      emit('evicted', { replyId: id });
      dropped++;
    }
  }
  if (dropped) log(`replyCache invalidated ${dropped} entries on voice change to ${currentVoiceId}`);
}

/** Drop all entries unconditionally. Used on /new / /reset / refresh
 *  so we don't keep references to AudioBuffers from a gone conversation. */
export function clear() {
  for (const id of cache.keys()) emit('evicted', { replyId: id });
  cache.clear();
  totalBytes = 0;
}

/** For debugging / diagnostics. */
export function stats() {
  return { entries: cache.size, totalBytes, maxBytes: MAX_BYTES };
}
