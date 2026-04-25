/**
 * @fileoverview TTS pipeline — sentence-chunked synthesis, sequential playback
 * with pause/resume/seek support via a per-reply playback state machine.
 *
 * Public API:
 *   speak(text, { replyId? })  — enqueue + play a reply
 *   stop(reason)               — destructive stop (bumps generation)
 *   pause() / resume()         — preserve position
 *   seekTo(ratio)              — 0..1 within the currently active reply
 *   getPosition()              — { position, duration, ratio } or null
 *   getDuration()              — total seconds across all synthesized chunks,
 *                                or null if any chunk isn't yet synthesized
 *   getReplyId()               — id of the active reply or null
 *   isSpeaking()               — legacy; true while playing or within tail
 *   on(event, fn), off(event, fn)
 *
 * Events: 'synth-start', 'chunk-ready' (idx, duration), 'duration-known'
 * (totalDuration), 'play-start', 'progress' ({position, duration, ratio}),
 * 'chunk-change' (idx), 'paused', 'resumed', 'ended', 'stopped' (reason).
 * Every event payload includes { replyId }.
 */

import { log, diag } from '../../util/log.ts';
import { fetchWithTimeout } from '../../util/fetchWithTimeout.ts';
import { setStatus } from '../../status.ts';
import * as settings from '../../settings.ts';
import { onTtsStart as sttOnTtsStart, onTtsEnd as sttOnTtsEnd, getActiveStream } from './deepgram.ts';
import { getAudioCtx, unlock, onRouteChange } from '../../audio/unlock.ts';
import * as session from '../../audio/session.ts';
import * as replyCache from './replyCache.ts';

let generation = 0;
let speaking = false;
let speakingTailUntil = 0;  // post-playback window where isSpeaking() stays true
let lastBlobUrl = null;

/** @type {HTMLAudioElement|null} */
let player = null;
/** @type {((reason: string) => void)|null} */
let onStopCallback = null;

/** Tail period after natural TTS end during which isSpeaking() stays true.
 *  Covers (a) physical speaker decay into the mic and (b) Deepgram's own
 *  audio-to-result latency, so the last few syllables of TTS output aren't
 *  re-transcribed into the user's draft. Skipped on barge-in stop so the
 *  user's interrupting speech isn't dropped. */
const TTS_TAIL_MS = 600;

// ── Event emitter ──────────────────────────────────────────────────────────
/** @type {Map<string, Set<Function>>} */
const listeners = new Map();
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
}
export function off(event, fn) {
  listeners.get(event)?.delete(fn);
}
function emit(event, payload) {
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of set) {
    try { fn(payload); } catch (e) { log('tts listener err:', e.message); }
  }
}

// ── Active reply state ─────────────────────────────────────────────────────
/**
 * @typedef {{
 *   id: string,
 *   gen: number,
 *   chunks: string[],
 *   buffers: (AudioBuffer|null)[],
 *   durations: (number|null)[],
 *   failed: boolean[],
 *   currentChunk: number,
 *   chunkStartedAt: number,
 *   offsetAtStart: number,
 *   source: AudioBufferSourceNode | null,
 *   gain: GainNode | null,
 *   state: 'synthesizing'|'playing'|'paused'|'ended'|'stopped',
 *   paused: { chunk: number, offset: number } | null,
 *   progressFrame: number | null,
 *   streamPushedIdx: number,
 *   streamEnded: boolean,
 *   driveRunning: boolean,          // true while drivePlayback's loop is active
 *   seekPending: boolean,           // true after seekTo stops source; loop must not auto-advance
 *   cumulativeChars: number,        // total text chars received so far (for proportional load)
 *   chunkChars: number[],           // chars per chunk (parallel to chunks[])
 *   voiceId: string,                // captured at reply creation; survives voice changes mid-synth
 * }} ActiveReply
 */
/** @type {ActiveReply|null} */
let activeReply = null;

export function init(playerEl) {
  player = playerEl;
  // When the audio route is rebuilt (BT switch, earpiece↔speaker toggle,
  // any devicechange), the old AudioContext is about to be closed — any
  // source/gain nodes we hold are about to dangle. Hard-stop playback so
  // activeReply doesn't claim state='playing' on a dead context. User
  // re-clicks play to continue; the new source attaches to the fresh
  // context. Registered once per module load.
  onRouteChange(() => {
    if (activeReply || speaking) {
      log('TTS: route change — stopping active playback');
      try { stop('route-change'); } catch (e) { log('route-change stop failed:', e.message); }
    }
  });
}
export function setOnStop(fn) { onStopCallback = fn; }
export function isSpeaking() { return speaking || Date.now() < speakingTailUntil; }
export function getReplyId() { return activeReply?.id ?? null; }

/** Ensure the AudioContext exists + is unlocked. Call from any user-gesture
 *  handler that might trigger TTS on iOS — the play button especially.
 *  Safe to call multiple times; no-op once unlocked unless the route has
 *  been flagged stale by a BT connect/disconnect.
 *
 *  Also primes the media-sink <audio> element while we're inside a user
 *  gesture — iOS only registers the page as a BT media source after a
 *  gesture-initiated play(). Without this prime, BT play/pause taps reach
 *  iOS but never get routed into navigator.mediaSession.setActionHandler. */
export function ensureAudioCtx() {
  if (!player) return;
  unlock(player);
  session.primeMediaSink();
}

/** More precise than isSpeaking: returns the exact state of the active reply,
 *  or 'idle' if nothing is active. UI uses this to decide play vs pause icon. */
export function getState() { return activeReply?.state ?? 'idle'; }

/** Total duration across all chunks, or null if any chunk is still pending
 *  synthesis (not yet finalized). Failed chunks contribute 0. */
export function getDuration() {
  if (!activeReply) return null;
  let total = 0;
  for (let i = 0; i < activeReply.durations.length; i++) {
    const d = activeReply.durations[i];
    if (d != null) { total += d; continue; }
    if (activeReply.failed[i]) continue;  // failed contributes 0
    return null;  // still pending
  }
  return total;
}

/** Current playhead position in seconds + ratio (0..1). Null if no active reply. */
export function getPosition() {
  if (!activeReply) return null;
  let elapsed = 0;
  for (let i = 0; i < activeReply.currentChunk; i++) {
    elapsed += activeReply.durations[i] || 0;
  }
  if (activeReply.state === 'paused') {
    elapsed += activeReply.paused?.offset ?? 0;
  } else if (activeReply.state === 'playing') {
    const ctx = getAudioCtx();
    // Only add wall-clock elapsed when a source is actually running. If
    // state is 'playing' but we're still waiting on the first chunk to
    // synthesize, reply.source is null and chunkStartedAt is 0 → using
    // ctx.currentTime would yield the AudioContext's total lifetime as
    // the position (full-bar bug).
    if (ctx && activeReply.source && activeReply.chunkStartedAt > 0) {
      const chunkElapsed = ctx.currentTime - activeReply.chunkStartedAt;
      elapsed += activeReply.offsetAtStart + chunkElapsed;
    } else {
      elapsed += activeReply.offsetAtStart;
    }
  } else if (activeReply.state === 'ended') {
    return { position: getDuration() || 0, duration: getDuration(), ratio: 1 };
  }
  const duration = getDuration();
  return { position: elapsed, duration, ratio: duration ? elapsed / duration : 0 };
}

/** Estimated total duration based on cumulative chars + synthesis rate.
 *  Used as denominator for the played-bar while true duration is unknown
 *  (mid-stream). Ensures the played bar never jumps to 100% before the
 *  loaded bar has caught up. */
function getEstimatedTotalTime() {
  if (!activeReply) return 0;
  const r = activeReply;
  const synthChars = r.chunkChars.reduce((a, c, i) => a + (r.durations[i] != null ? c : 0), 0);
  const synthTime = r.durations.reduce((a, d) => a + (d || 0), 0);
  if (synthChars === 0 || r.cumulativeChars === 0) return 0;
  return r.cumulativeChars * synthTime / synthChars;
}

/** Clean agent text for TTS: strip markdown, limit length. */
function cleanForTts(text) {
  let t = text;
  // Strip any leading bracketed speaker tag (e.g. "[Clawdian] ...", "[R2] ...").
  // The agent emits one per openclaw.json's messages.responsePrefix but we
  // never want it spoken out loud.
  t = t.replace(/^\[[A-Za-z0-9_\- ]+\]\s*/, '');
  t = t.replace(/```[\s\S]*?```/g, '[code block]');
  t = t.replace(/`([^`]+)`/g, '$1');
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
  // Strip italic markers (*text* and _text_) — single-asterisk / underscore
  // pairs that Deepgram Aura would otherwise pronounce as "asterisk" /
  // "underscore" instead of treating as emphasis.
  t = t.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,!?)]|$)/g, '$1$2');
  t = t.replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,!?)]|$)/g, '$1$2');
  // Strip markdown list bullets / heading markers at line start — they'd
  // be read literally otherwise ("asterisk Item one", "dash Item two").
  t = t.replace(/^[\s]*[-*•]\s+/gm, '');
  t = t.replace(/^#+\s+/gm, '');
  // Strip URLs — unlistenable as audio
  t = t.replace(/https?:\/\/[^\s<)\]"']+/g, '(link in canvas)');
  // Strip emoji — TTS reads them as descriptions ("robot", "fire", etc.)
  t = t.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '');
  // Final catch: any remaining lone asterisks (unpaired, embedded in
  // words, etc.) — Deepgram pronounces each one. Better to lose a
  // stray formatting hint than to have "**" spoken twice.
  t = t.replace(/\*/g, '');
  t = t.replace(/^[#\-\s]+$/gm, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t.slice(0, 1800);
}

/** Split text into sentence-aligned chunks for low first-byte latency.
 *  The opening chunks are capped smaller than the rest so audio starts
 *  sooner on cold synth — subsequent chunks synthesize in parallel so
 *  total completion time is unchanged, only time-to-first-audio
 *  shrinks. Prior iteration only kept chunk 0 small (60ch). That left
 *  chunk 1 at the full 180ch target, which synthesizes in 2-4s — long
 *  enough that chunk 0 (a short sentence, often ~3s of speech) finishes
 *  playing before chunk 1's buffer is ready, producing an audible
 *  "first sentence then hang" pause. Scaling: 60ch, 120ch, then 180ch
 *  target gives each successive chunk roughly matched synth-time ≤
 *  playback-time of the previous one. */
function chunkForTts(text, targetChars = 180, firstChunkChars = 60) {
  const sentences = text.match(/[^.!?\n]+[.!?]+|[^.!?\n]+$/g) || [text];
  const chunks = [];
  let cur = '';
  for (const s of sentences) {
    const t = s.trim();
    if (!t) continue;
    // Progressive caps: chunk 0 ≤ firstChunkChars, chunk 1 ≤ 2× that,
    // chunks 2+ ≤ targetChars. Keeps the second chunk short enough to
    // finish synth before chunk 0 finishes playing.
    const cap = chunks.length === 0 ? firstChunkChars
      : chunks.length === 1 ? firstChunkChars * 2
      : targetChars;
    if (cur && (cur.length + t.length + 1) > cap) {
      chunks.push(cur);
      cur = t;
    } else {
      cur = cur ? cur + ' ' + t : t;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function synthesizeChunk(text) {
  const res = await fetchWithTimeout('/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model: settings.get().voice }),
    // 20s: typical Aura chunk completes in 1-3s; longer sentences can
    // spike to 8-10s on slow upstream. 20s gives headroom without
    // leaving the UI hanging on a dead connection.
    timeoutMs: 20_000,
  });
  if (!res.ok) throw new Error(`tts ${res.status}`);
  return res.blob();
}

// Play through <audio> element. Used as fallback when AudioContext is missing
// or decodeAudioData fails.
function playBlobViaElement(blob: Blob) {
  return new Promise<void>((resolve) => {
    const url = URL.createObjectURL(blob);
    if (lastBlobUrl) { try { URL.revokeObjectURL(lastBlobUrl); } catch {} }
    lastBlobUrl = url;
    player.src = url;
    player.onended = () => resolve();
    player.onerror = () => resolve();
    player.play().catch(() => resolve());
  });
}

// Decode a synthesized blob into an AudioBuffer. Returns null on failure
// (caller falls back to the <audio> element path).
async function decodeChunk(blob) {
  const audioCtx = getAudioCtx();
  if (!audioCtx) return null;
  if (audioCtx.state === 'suspended') {
    try { await audioCtx.resume(); } catch {}
  }
  try {
    const arrayBuffer = await blob.arrayBuffer();
    return await audioCtx.decodeAudioData(arrayBuffer);
  } catch (e) {
    log('decodeAudioData failed:', e.message);
    return null;
  }
}

/** Save the active reply's current playback position into replyCache so a
 *  later prev/next skip back to this reply can resume where the user left
 *  off. Only stores a position if one is meaningfully "in the middle" —
 *  too-early or too-late positions aren't worth the state (user wants a
 *  fresh start at 0 in either case). No-op if the reply isn't cached. */
function captureOutgoingPosition() {
  if (!activeReply) return;
  if (activeReply.state === 'synthesizing' || activeReply.state === 'stopped') return;
  if (!replyCache.has(activeReply.id)) return;
  const pos = getPosition();
  if (!pos || !Number.isFinite(pos.position)) return;
  // Don't save if essentially at end — replay should start from 0.
  if (pos.duration && pos.position > pos.duration - 1) return;
  // Don't save trivial positions — probably just a stray click.
  if (pos.position < 0.5) return;
  replyCache.setPosition(activeReply.id, pos.position);
}

/** Called by beginReply()/playCached() when a previous reply is still
 *  audible. Fades the old source to 0 over 30ms then disconnects — mirrors
 *  stop()'s click-safe teardown, minus generation bump / 'stopped' emit /
 *  activeReply=null. The caller owns the supersession: it will bump
 *  generation (killing the prior drivePlayback loop on next iteration) and
 *  set activeReply to the new reply. Without this, the AudioBufferSourceNode
 *  for the prior reply's current chunk stays connected to destination and
 *  keeps emitting audio until its buffer finishes naturally — up to one
 *  chunk (~3–7s) of audible overlap with the new reply.
 *
 *  Bug fired in the wild during a Wi-Fi handoff: prior reply was mid-chunk
 *  when a new reply started streaming; both played simultaneously in BT
 *  earbuds. */
function supersedePreviousReply() {
  captureOutgoingPosition();
  if (!activeReply) return;
  const prev = activeReply;
  const src = prev.source;
  const g = prev.gain;
  if (src) {
    prev.source = null;
    prev.gain = null;
    const audioCtx = getAudioCtx();
    if (g && audioCtx) {
      const now = audioCtx.currentTime;
      try {
        g.gain.cancelScheduledValues(now);
        g.gain.setValueAtTime(g.gain.value, now);
        g.gain.linearRampToValueAtTime(0, now + 0.03);
      } catch {}
      setTimeout(() => {
        try { src.stop(); } catch {}
        try { src.disconnect(); } catch {}
        try { g.disconnect(); } catch {}
      }, 40);
    } else {
      try { src.stop(); } catch {}
      try { src.disconnect(); } catch {}
    }
  }
  // Flip state + stop the progress RAF so any UI bound to the old reply
  // resets cleanly. The drivePlayback loop's gen check will also exit on
  // next iteration; this is belt-and-suspenders.
  prev.state = 'stopped';
  stopProgressLoop(prev);
  // Notify the UI (replyPlayer) so the old bubble's button/bar reset.
  // 'superseded' reason avoids marking the bubble as user-played.
  emit('stopped', { replyId: prev.id, reason: 'superseded' });
  log(`TTS superseded: reply=${prev.id}`);
}

/** Play one chunk of `reply` starting at `offset` seconds. Returns a Promise
 *  that resolves when the chunk finishes naturally, or when playback is
 *  interrupted by pause/stop/seek (in which case reply.state ≠ 'playing'). */
function playChunkSegment(reply, idx, offset) {
  return new Promise<void>((resolve) => {
    const audioCtx = getAudioCtx();
    const buffer = reply.buffers[idx];
    if (!audioCtx || !buffer) { resolve(); return; }

    const source = audioCtx.createBufferSource();
    const gain = audioCtx.createGain();
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(audioCtx.destination);
    // ALSO connect to the media-sink destination node so iOS sees an
    // <audio> element actively playing. Without this fan-out, BT
    // play/pause/skip never reach navigator.mediaSession handlers
    // (Web Audio alone is invisible to AVFoundation as a media source).
    // The mediaSink path is muted at the <audio> element — actual audible
    // output still flows through audioCtx.destination, A2DP routing
    // unchanged. No-op if the sink isn't available yet.
    const mediaSink = session.getMediaSink();
    if (mediaSink) {
      try { gain.connect(mediaSink); } catch (e) { diag('media-sink connect failed:', (e as Error)?.message); }
    }
    source.onended = () => {
      // Only advance state if this source is still the active one. If pause
      // or seek already stopped it, the outer state machine handles cleanup.
      if (reply.source === source) {
        reply.source = null;
        reply.gain = null;
      }
      try { source.disconnect(); } catch {}
      try { gain.disconnect(); } catch {}
      resolve();
    };
    reply.source = source;
    reply.gain = gain;
    reply.chunkStartedAt = audioCtx.currentTime;
    reply.offsetAtStart = offset;
    try { source.start(0, offset); } catch { resolve(); }
  });
}

function startProgressLoop(reply) {
  const tick = () => {
    if (!activeReply || activeReply !== reply || reply.state !== 'playing') {
      reply.progressFrame = null;
      return;
    }
    const pos = getPosition();
    if (pos) emit('progress', {
      replyId: reply.id,
      ...pos,
      estimatedTotal: getEstimatedTotalTime(),
    });
    reply.progressFrame = requestAnimationFrame(tick);
  };
  if (reply.progressFrame) cancelAnimationFrame(reply.progressFrame);
  reply.progressFrame = requestAnimationFrame(tick);
}

function stopProgressLoop(reply) {
  if (reply.progressFrame != null) {
    cancelAnimationFrame(reply.progressFrame);
    reply.progressFrame = null;
  }
}

/** Pause the currently-playing reply, preserving position. */
export function pause() {
  if (!activeReply || activeReply.state !== 'playing') return false;
  const ctx = getAudioCtx();
  if (!ctx) return false;
  // Guard: if the first chunk hasn't actually started sounding yet
  // (source is null / chunkStartedAt=0), ctx.currentTime - 0 would yield
  // the AudioContext's lifetime as the "offset" — causes the garbage
  // "paused at offset=305.54s" bug. Fall back to offsetAtStart.
  let offsetNow = activeReply.offsetAtStart;
  if (activeReply.source && activeReply.chunkStartedAt > 0) {
    offsetNow += ctx.currentTime - activeReply.chunkStartedAt;
  }
  activeReply.paused = { chunk: activeReply.currentChunk, offset: offsetNow };
  activeReply.state = 'paused';
  // Stop the audio node WITHOUT bumping generation. onended will fire and
  // clear reply.source/gain; the outer loop sees state='paused' and exits.
  if (activeReply.source) {
    try { activeReply.source.stop(); } catch {}
  }
  stopProgressLoop(activeReply);
  // Clear the speaking flag so streaming STT un-gates. A paused reply
  // isn't making sound, so isSpeaking() must return false — otherwise
  // the DG audio-send path stays muted (inPlayback=true skip in the
  // worklet handler) and Web Speech `pauseForTts` never lifts. Leaves
  // streaming silently dead until the next full stop / app kill.
  speaking = false;
  sttOnTtsEnd();
  session.setPlaybackState('paused');
  emit('paused', { replyId: activeReply.id });
  log(`TTS paused at chunk=${activeReply.paused.chunk} offset=${offsetNow.toFixed(2)}s`);
  return true;
}

/** Hydrate activeReply from a replyCache entry and start playback.
 *  No network / synthesis — buffers are already decoded.
 *
 *  @param {string} replyId
 *  @param {{ resume?: boolean }} [opts]
 *    resume: if true, start from the reply's lastPosition (saved when the
 *            user skipped away via prev/next). Default false = start from 0.
 */
export function playCached(replyId, opts: { resume?: boolean } = {}) {
  const entry = replyCache.get(replyId);
  if (!entry) return false;
  supersedePreviousReply();  // kill any audible prior reply before swapping
  const gen = ++generation;
  try { player?.pause(); } catch {}
  speaking = true;
  speakingTailUntil = 0;
  sttOnTtsStart();
  session.prepareForPlayback();

  // Resolve optional resume point: lastPosition (seconds) → (chunk, offset).
  // We walk the durations array to find which chunk the resume point falls
  // within. Clamp to a valid position; on edge cases (past-end, NaN) start
  // from 0 instead of the saved value.
  let startChunk = 0;
  let startOffset = 0;
  const resumePos = opts.resume ? entry.lastPosition : null;
  if (typeof resumePos === 'number' && Number.isFinite(resumePos) && resumePos > 0) {
    let remaining = resumePos;
    for (let i = 0; i < entry.durations.length; i++) {
      const d = entry.durations[i] || 0;
      if (remaining < d - 0.01 || i === entry.durations.length - 1) {
        startChunk = i;
        startOffset = Math.max(0, Math.min(remaining, d - 0.01));
        break;
      }
      remaining -= d;
    }
  }

  const reply = /** @type {ActiveReply} */ ({
    id: replyId, gen,
    chunks: entry.chunks.slice(),
    buffers: entry.buffers.slice(),
    durations: entry.durations.slice(),
    failed: entry.buffers.map(() => false),
    chunkChars: entry.chunkChars.slice(),
    currentChunk: startChunk,
    chunkStartedAt: 0,
    offsetAtStart: startOffset,
    source: null,
    gain: null,
    state: 'playing',
    paused: null,
    progressFrame: null,
    streamPushedIdx: entry.cumulativeChars,
    streamEnded: true,
    driveRunning: false,
    seekPending: false,
    cumulativeChars: entry.cumulativeChars,
    voiceId: entry.voiceId,
  });
  activeReply = reply;
  replyCache.setPinnedId(replyId);
  // Partial-cache entries (precacheFirstChunk wrote chunk 0 only) have
  // null buffers[1..N]. Kick off synthesis for every missing chunk so
  // the drivePlayback loop (which polls buffers[idx]==null on a 30ms
  // timer) resumes as each one lands. streamEnded stays true so the
  // all-settled handler in synthesizeAndStore fires a cache-put that
  // upgrades the partial entry to a full one — subsequent plays are
  // fully cached.
  const allCached = reply.buffers.every((b) => b != null);
  if (!allCached) {
    for (let i = 0; i < reply.buffers.length; i++) {
      if (reply.buffers[i] == null) synthesizeAndStore(reply, i, reply.chunks[i], gen);
    }
  }
  // Emit a consistent event sequence so replyPlayer's bar updates match
  // what it would see during a fresh synthesis. For a full cache the
  // total is known up front; for partial we defer duration-known to the
  // all-settled handler in synthesizeAndStore.
  emit('synth-start', { replyId, chunks: reply.chunks.length });
  if (allCached) {
    const total = reply.durations.reduce((a, d) => a + d, 0);
    emit('duration-known', { replyId, duration: total });
  }
  emit('play-start', { replyId });
  setStatus(`${getListening() ? 'Mic muted — ' : ''}Speaking`, 'live');
  startProgressLoop(reply);
  drivePlayback(reply);
  const cachedSec = reply.durations.filter((d) => d != null).reduce((a, d) => a + d, 0);
  const resumeNote = (startChunk || startOffset) ? ` @${((startOffset || 0) + reply.durations.slice(0, startChunk).filter((d) => d != null).reduce((a,d) => a+d, 0)).toFixed(1)}s` : '';
  log(`TTS playCached: reply=${replyId} (${reply.chunks.length} chunks, ${cachedSec.toFixed(1)}s cached${allCached ? '' : ', partial'})${resumeNote}`);
  return true;
}

/** Pre-synthesize and cache ONLY the first chunk of a reply so the next
 *  play-click starts audible near-instantly — the rest synthesizes on
 *  play-click via playCached's partial-entry path. Used by main.ts when
 *  the agent finishes a reply but TTS output is muted: we still want
 *  fast replay if the user later turns speaker back on, without paying
 *  Aura for every chunk of every muted reply.
 *
 *  No audible output, no TTS state changes, safe to call when muted.
 *  Returns when chunk 0 is cached (or the attempt failed). */
export async function precacheFirstChunk(replyId, text) {
  if (!replyId) return;
  if (replyCache.has(replyId)) return;  // already cached (full or partial)
  const clean = cleanForTts(text);
  if (!clean) return;
  const chunks = chunkForTts(clean);
  if (chunks.length === 0) return;
  try {
    const blob = await synthesizeChunk(chunks[0]);
    const buf = await decodeChunk(blob);
    if (!buf) return;
    // Re-check cache state after the async synth completed. If a click-
    // play raced us and already populated the full entry via the normal
    // tts.speak() path, writing a partial would clobber working cache.
    if (replyCache.has(replyId)) return;
    const buffers = [buf, ...chunks.slice(1).map(() => null)];
    const durations = [buf.duration, ...chunks.slice(1).map(() => null)];
    replyCache.put(replyId, {
      chunks,
      buffers: /** @type {AudioBuffer[]} */ (buffers),
      durations: /** @type {number[]} */ (durations),
      chunkChars: chunks.map((c) => c.length),
      cumulativeChars: clean.length,
      voiceId: settings.get().voice,
    });
    diag(`TTS precache: reply=${replyId} chunk0=${chunks[0].length}ch (${buf.duration.toFixed(2)}s), ${chunks.length - 1} chunks pending lazy synth`);
  } catch (e) {
    diag(`TTS precache failed: ${(e as Error)?.message || 'unknown'}`);
  }
}

/** Restart playback of the currently-active reply from position 0 using
 *  the cached chunk buffers — no re-synthesis. Valid when state is
 *  'ended' or 'paused'. Returns false if the reply is gone / buffers
 *  destroyed; callers then fall back to tts.speak() which re-synthesizes.
 *
 *  Buffer lifetime: the ActiveReply object stays in memory (with its
 *  AudioBuffers) until the next speak()/beginReply() replaces it, or
 *  until tts.stop() nulls it. So only the *most recent* reply can be
 *  instant-replayed. Older replies necessarily re-synth. */
export function replay() {
  if (!activeReply) return false;
  if (activeReply.state !== 'ended' && activeReply.state !== 'paused') return false;
  const r = activeReply;
  // Reset position to the start of the first chunk.
  if (r.source) { try { r.source.stop(); } catch {} }
  r.source = null;
  r.gain = null;
  r.currentChunk = 0;
  r.offsetAtStart = 0;
  r.paused = null;
  r.seekPending = false;
  r.state = 'playing';
  speaking = true;
  speakingTailUntil = 0;
  sttOnTtsStart();
  session.prepareForPlayback();
  emit('play-start', { replyId: r.id });
  setStatus(`${getListening() ? 'Mic muted — ' : ''}Speaking`, 'live');
  startProgressLoop(r);
  drivePlayback(r);
  log(`TTS replay: reply=${r.id} (cached, no re-synth)`);
  return true;
}

/** Resume a paused reply from the saved position. */
export function resume() {
  if (!activeReply || activeReply.state !== 'paused') return false;
  const { chunk, offset } = activeReply.paused;
  activeReply.currentChunk = chunk;
  activeReply.offsetAtStart = offset;
  activeReply.paused = null;
  activeReply.state = 'playing';
  // Re-enter the "TTS is sounding" contract symmetric to pause() above.
  speaking = true;
  sttOnTtsStart();
  session.setPlaybackState('playing');
  emit('resumed', { replyId: activeReply.id });
  log(`TTS resumed at chunk=${chunk} offset=${offset.toFixed(2)}s`);
  startProgressLoop(activeReply);
  // Re-enter the playback loop for this reply. The loop reads the current
  // chunk index + offsetAtStart and continues from there.
  drivePlayback(activeReply);
  return true;
}

/** Seek to `ratio` (0..1) within the currently active reply's total duration.
 *  Returns false if the target is beyond what's been synthesized yet. */
export function seekTo(ratio) {
  if (!activeReply) return false;
  if (ratio < 0) ratio = 0;
  if (ratio > 1) ratio = 1;
  let cumulative = 0;
  let targetChunk = -1, targetOffset = 0;
  // Sum durations until we find the chunk containing ratio*total. If any
  // pending-synth chunk precedes the target, we can't seek past it.
  let totalKnown = 0;
  for (let i = 0; i < activeReply.durations.length; i++) {
    const d = activeReply.durations[i];
    if (d == null) {
      if (activeReply.failed[i]) continue;  // 0 duration, skip
      break;                                 // still pending — stop totalling
    }
    totalKnown += d;
  }
  if (totalKnown === 0) return false;
  const target = ratio * totalKnown;
  for (let i = 0; i < activeReply.durations.length; i++) {
    const d = activeReply.durations[i];
    if (d == null) {
      if (activeReply.failed[i]) continue;
      return false;  // target lies past what we've synthesized so far
    }
    if (cumulative + d > target) {
      targetChunk = i;
      targetOffset = target - cumulative;
      break;
    }
    cumulative += d;
  }
  if (targetChunk < 0) {
    // Ratio 1.0 — seek to end
    targetChunk = activeReply.durations.length - 1;
    targetOffset = activeReply.durations[targetChunk] || 0;
  }
  const wasPlaying = activeReply.state === 'playing';
  const wasEnded = activeReply.state === 'ended';
  // Mark seek before stopping so the drive loop (awaiting playChunkSegment)
  // knows NOT to auto-advance currentChunk when source.onended fires.
  activeReply.seekPending = true;
  if (activeReply.source) { try { activeReply.source.stop(); } catch {} }
  activeReply.currentChunk = targetChunk;
  activeReply.offsetAtStart = targetOffset;
  if (activeReply.state === 'paused') {
    activeReply.paused = { chunk: targetChunk, offset: targetOffset };
  } else if (activeReply.state === 'ended') {
    // Scrub-after-end: rehydrate to paused at the scrub point. Click-play
    // will now resume() from here instead of re-synthesizing from scratch.
    activeReply.state = 'paused';
    activeReply.paused = { chunk: targetChunk, offset: targetOffset };
    emit('paused', { replyId: activeReply.id });
  }
  const estimatedTotal = getEstimatedTotalTime();
  emit('seek', { replyId: activeReply.id, position: target, duration: totalKnown, ratio });
  emit('progress', { replyId: activeReply.id, position: target, duration: totalKnown, ratio, estimatedTotal });
  if (wasPlaying) {
    drivePlayback(activeReply);  // no-op if already running
  }
  return true;
}

/** Cleanup shared by all paths that finish playback (natural end, stop,
 *  empty-reply shortcut). Sets the post-playback tail window and hands
 *  audio session back to capture-compatible mode. */
function finalizeReply() {
  speaking = false;
  speakingTailUntil = Date.now() + TTS_TAIL_MS;
  sttOnTtsEnd();
  session.prepareForCapture();
  setStatus(getListening() ? 'Listening' : 'Idle', getListening() ? 'live' : 'ok');
}

/** Run the playback loop for `reply` from its current chunk/offset.
 *  Exits on state ≠ 'playing' (pause/stop) or natural end.
 *  Idempotent — if already running, returns immediately (re-entry from
 *  resume() / seekTo() is a no-op while the existing loop continues). */
async function drivePlayback(reply) {
  if (reply.driveRunning) return;
  if (reply.state === 'ended' || reply.state === 'stopped') return;
  reply.driveRunning = true;
  try {
    while (true) {
      if (reply.gen !== generation) { reply.state = 'stopped'; return; }
      if (reply.state === 'paused' || reply.state === 'stopped') return;

      // Tail: waiting for more chunks.
      if (reply.currentChunk >= reply.chunks.length) {
        if (reply.streamEnded) break;
        await new Promise(r => setTimeout(r, 30));
        continue;
      }

      const idx = reply.currentChunk;
      // Wait for synthesis of this chunk if it's not ready.
      while (reply.buffers[idx] == null && !reply.failed[idx]) {
        if (reply.gen !== generation) { reply.state = 'stopped'; return; }
        if (reply.state === 'paused' || reply.state === 'stopped') return;
        await new Promise(r => setTimeout(r, 30));
      }
      if (reply.failed[idx]) {
        reply.currentChunk++;
        reply.offsetAtStart = 0;
        continue;
      }

      emit('chunk-change', { replyId: reply.id, chunk: idx });
      await playChunkSegment(reply, idx, reply.offsetAtStart);
      // After the chunk awaits, check for seek — if seekTo stopped us,
      // don't advance; the new currentChunk/offsetAtStart are already set.
      if (reply.seekPending) {
        reply.seekPending = false;
        continue;
      }
      // If pause/stop interrupted, exit — seekTo's re-entry (if any) will
      // spawn a fresh loop.
      if (reply.state !== 'playing') return;
      reply.currentChunk++;
      reply.offsetAtStart = 0;
    }
    // Natural end (streamEnded + all chunks consumed)
    if (reply.state === 'playing') {
      reply.state = 'ended';
      stopProgressLoop(reply);
      emit('ended', { replyId: reply.id });
      // Cache snapshot already happened at duration-known (synthesize
      // side). No second write here.
      if (reply.gen === generation) finalizeReply();
    }
  } finally {
    reply.driveRunning = false;
  }
}

/** @type {() => boolean} */
let getListening = () => false;
export function setListeningGetter(fn) { getListening = fn; }

/** Resolve the voice to use. Priority:
 *  1. User's explicit choice from Settings (ttsVoiceLocal).
 *  2. On Chrome desktop: auto-pick "Google US English" (Chrome's own
 *     known-working cloud voice). Chrome's null-voice auto-default often
 *     ends up a mac-system voice name it can't synthesize → silent drop.
 *  3. Otherwise null → let the browser pick its default (Safari/iOS are
 *     well-behaved here). */
function pickLocalVoice() {
  const voices = (typeof speechSynthesis !== 'undefined') ? speechSynthesis.getVoices() : [];
  if (!voices.length) return null;
  const picked = settings.get().ttsVoiceLocal;
  if (picked) return voices.find(v => v.name === picked) || null;
  // Chrome desktop workaround — force a known-synthesizable voice.
  const ua = navigator.userAgent;
  const isChromeDesktop = /Chrome/i.test(ua) && !/Mobile|Android|CriOS/i.test(ua);
  if (isChromeDesktop) {
    const googleVoice = voices.find(v => /Google US English/i.test(v.name))
                     || voices.find(v => /^Google.*English/i.test(v.name));
    if (googleVoice) return googleVoice;
  }
  return null;
}

let voiceDumpDone = false;
function dumpVoicesOnce() {
  if (voiceDumpDone) return;
  voiceDumpDone = true;
  const vs = (typeof speechSynthesis !== 'undefined') ? speechSynthesis.getVoices() : [];
  log(`speechSynthesis voices (${vs.length}):`, vs.map(v => `${v.name}(${v.lang})${/** @type {any} */ (v).localService ? '·local' : ''}${/** @type {any} */ (v).default ? '·default' : ''}`).join(', '));
}

let currentUtter = null;

/** Speak via the browser's local TTS (Web Speech Synthesis API). Zero-latency
 *  on-device, no network cost, works offline. Voice quality depends on the OS. */
async function speakLocal(text, gen) {
  if (typeof speechSynthesis === 'undefined') {
    log('speechSynthesis unavailable, falling back to server TTS');
    return false;
  }
  // iOS bug workaround: speechSynthesis can be left in a paused state by
  // prior lifecycle events (lock/unlock, visibilitychange). Resume first.
  try { speechSynthesis.resume(); } catch {}
  // Chrome (macOS + Windows) has a well-documented race where cancel() +
  // immediate speak() silently drops the new utterance. Only cancel if
  // something's actually active, and let cancel settle before the new speak.
  if (speechSynthesis.speaking || speechSynthesis.pending) {
    try { speechSynthesis.cancel(); } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  // Voices load asynchronously on some browsers (notably desktop Chrome/Safari).
  // If getVoices() is empty, wait briefly for voiceschanged rather than speaking
  // with a null voice (which silently drops on some engines).
  if (speechSynthesis.getVoices().length === 0) {
    log('speechSynthesis: voices not loaded, waiting…');
    await new Promise<void>((resolve) => {
      const done = () => { speechSynthesis.onvoiceschanged = null; resolve(); };
      speechSynthesis.onvoiceschanged = done;
      setTimeout(done, 1500);  // cap the wait
    });
  }
  dumpVoicesOnce();
  return new Promise((resolve) => {
    const utter = new SpeechSynthesisUtterance(text);
    const voice = pickLocalVoice();
    if (voice) utter.voice = voice;
    // Set lang explicitly — some browsers need it to pick a default voice
    // when utter.voice is null.
    utter.lang = voice?.lang || navigator.language || 'en-US';
    utter.rate = 1.0;
    utter.pitch = 1.0;
    let resumePoll = null;
    const cleanup = () => {
      if (resumePoll) { clearInterval(resumePoll); resumePoll = null; }
      if (currentUtter === utter) currentUtter = null;
    };
    utter.onstart = () => log('speechSynthesis: onstart');
    utter.onend = () => { log('speechSynthesis: onend'); cleanup(); resolve(true); };
    utter.onerror = (e) => {
      log('speechSynthesis error:', e.error || '(unknown)');
      cleanup();
      resolve(true);  // treat as done; don't fall through to server
    };
    currentUtter = utter;
    if (gen !== generation) { cleanup(); resolve(true); return; }
    log(`speechSynthesis.speak: len=${text.length} voice=${voice?.name || '(browser default)'} paused=${speechSynthesis.paused}`);
    try { speechSynthesis.speak(utter); } catch (e) { log('speak failed:', e.message); cleanup(); resolve(true); return; }
    // Resume immediately after speak — Chrome sometimes enters a paused
    // state that makes queued utterances never play until resumed.
    try { speechSynthesis.resume(); } catch {}

    // Chrome (all OS) has a bug where speak() pauses itself after ~15s.
    // Also, sometimes speak() queues silently and never starts. Poll resume()
    // every few seconds while our utterance is pending/speaking.
    resumePoll = setInterval(() => {
      if (currentUtter !== utter) { clearInterval(resumePoll); return; }
      try { speechSynthesis.resume(); } catch {}
    }, 5000);

    // Diagnostic: if speak() was silently dropped (Chrome macOS voice
    // mismatch, etc.), neither onstart nor onerror fires. Log after 1s.
    setTimeout(() => {
      if (currentUtter === utter && !speechSynthesis.speaking && !speechSynthesis.pending) {
        log('speechSynthesis: speak silently dropped (no start, no error)');
      }
    }, 1000);
  });
}

/** Unlock Web Speech Synthesis inside a user gesture. iOS Safari gates the
 *  API — the first speak() must be inside a click/touch handler. Subsequent
 *  calls from async contexts (WebSocket message handlers, TTS-reply flow)
 *  then work. Call this from btn-mic click / any user gesture.
 *
 *  IMPORTANT: only run on iOS. Chrome (macOS/Windows/Linux) doesn't need
 *  this prime AND the speak()+cancel() pattern it uses triggers the long-
 *  standing Chromium bug where subsequent speak() calls queue but never
 *  play. See https://bugs.chromium.org/p/chromium/issues/detail?id=521818 */
export function primeLocalSynthesis() {
  if (typeof speechSynthesis === 'undefined') return;
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (!isIOS) return;
  try {
    speechSynthesis.resume();
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;  // silent prime
    speechSynthesis.speak(u);
    // Cancel immediately — we just needed the speak() inside a gesture.
    setTimeout(() => { try { speechSynthesis.cancel(); } catch {} }, 50);
  } catch {}
}

// ── Streaming API ─────────────────────────────────────────────────────────
// Lets callers feed cumulative reply text as agent tokens stream in and
// have playback start as soon as the first sentence synthesizes — instead
// of waiting for the full reply before any audio. Chunks are emitted at
// sentence boundaries; the still-growing tip after the last boundary stays
// buffered until more text arrives (or endReply flushes it).

/** Internal: find new sentence-complete text in cumulative-text since the
 *  last push. Returns { stable, nextIdx } or null if no new stable region.
 *  The boundary rule is "sentence-ender + whitespace" OR newline OR end of
 *  string, with a minimum-content threshold so micro-chunks aren't emitted
 *  (e.g. we don't want to synthesize the single word "Sure." as its own
 *  chunk just because the punctuation is there — prefer waiting). */
const MIN_STREAM_CHUNK_CHARS = 20;
function findStableSlice(cleanedText, fromIdx) {
  const tail = cleanedText.slice(fromIdx);
  if (!tail) return null;
  const re = /[.!?\n]+(\s+|$)/g;
  let lastEnd = -1;
  let m;
  while ((m = re.exec(tail)) !== null) {
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd < 0) return null;
  const stable = tail.slice(0, lastEnd).trim();
  if (stable.length < MIN_STREAM_CHUNK_CHARS) return null;
  return { stable, nextIdx: fromIdx + lastEnd };
}

/** Emit a load-progress event with current synthesized/cumulative char ratio.
 *  UI uses this to size the "loaded" bar proportional to how much of the
 *  agent's reply has been synthesized vs how much text we've received. */
function emitLoadProgress(reply) {
  const synthesized = reply.chunkChars.reduce((a, c, i) =>
    a + (reply.durations[i] != null ? c : 0), 0);
  const total = Math.max(reply.cumulativeChars, synthesized, 1);
  emit('load-progress', {
    replyId: reply.id,
    synthesizedChars: synthesized,
    totalChars: total,
    ratio: synthesized / total,
  });
}

/** Internal: synthesize + decode one chunk's text, writing into reply.buffers
 *  / durations / failed at the given index. Emits chunk-ready, load-progress,
 *  and (if all chunks settled and stream ended) duration-known. */
function synthesizeAndStore(reply, idx, chunkText, gen) {
  synthesizeChunk(chunkText)
    .then(async (blob) => {
      // Note: we intentionally do NOT early-exit on `gen !== generation`.
      // A stopped reply (barge-in, stream-reset) still needs to finish
      // decoding + populate the cache so the NEXT play-click can hit it
      // instead of re-synthesizing from scratch. Only UI events are gated
      // on active generation; cache writes are unconditional.
      const buf = await decodeChunk(blob);
      const isActive = gen === generation;
      if (!buf) {
        reply.failed[idx] = true;
        if (isActive) emitLoadProgress(reply);
        // Fall through — maybe other chunks still settle and trigger caching.
      } else {
        reply.buffers[idx] = buf;
        reply.durations[idx] = buf.duration;
        if (isActive) {
          emit('chunk-ready', { replyId: reply.id, chunk: idx, duration: buf.duration });
          emitLoadProgress(reply);
        }
      }
      if (reply.streamEnded) {
        const allSettled = reply.durations.every((d, i) => d != null || reply.failed[i]);
        if (allSettled) {
          if (isActive) {
            const total = getDuration();
            if (total != null) emit('duration-known', { replyId: reply.id, duration: total });
          }
          // Cache unconditionally. Previously we gated this on active
          // generation too, which meant any reply that got stopped mid-
          // synth (barge-in, scroll-away, stream-reset) never populated
          // the cache — every subsequent click on that bubble triggered
          // a full re-synth. Since buffers live in the reply's closure,
          // we can complete the write even after the reply is stale.
          try {
            replyCache.put(reply.id, {
              chunks: reply.chunks,
              buffers: /** @type {AudioBuffer[]} */ (reply.buffers),
              durations: /** @type {number[]} */ (reply.durations),
              chunkChars: reply.chunkChars,
              cumulativeChars: reply.cumulativeChars,
              voiceId: reply.voiceId || settings.get().voice,
            });
          } catch (e) { log('replyCache put failed:', e.message); }
        }
      }
    })
    .catch(e => {
      log('chunk err:', e.message);
      reply.failed[idx] = true;
      if (gen === generation) emitLoadProgress(reply);
      // Audible chime on network-timeout specifically — user-facing
      // signal for bike mode where the screen may not be visible. Other
      // synth errors (decode failure, 500s) don't chime because they
      // can't be fixed by waiting for connectivity.
      if (e?.name === 'TimeoutError') {
        import('../../audio/feedback.ts').then(m => m.playFeedback('error')).catch(() => {});
      }
    });
}

/** Add a new chunk to an active streaming reply. Updates all parallel
 *  arrays + kicks off synthesis. Factored out so the three chunk-add
 *  sites (pushReplyText + endReply's two flushes) stay in sync. */
function addChunkToReply(reply, chunkText, gen) {
  const idx = reply.chunks.length;
  reply.chunks.push(chunkText);
  reply.buffers.push(null);
  reply.durations.push(null);
  reply.failed.push(false);
  reply.chunkChars.push(chunkText.length);
  synthesizeAndStore(reply, idx, chunkText, gen);
}

/** Initialize a streaming reply. Playback starts as soon as the first
 *  chunk is ready via pushReplyText(). Returns the reply id. */
export function beginReply(opts: { replyId?: string } = {}) {
  supersedePreviousReply();  // kill any audible prior reply before swapping
  const gen = ++generation;
  const replyId = opts.replyId || `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  speaking = true;
  sttOnTtsStart();
  session.prepareForPlayback();

  const reply = /** @type {ActiveReply} */ ({
    id: replyId, gen,
    chunks: [],
    buffers: [],
    durations: [],
    failed: [],
    chunkChars: [],
    currentChunk: 0,
    chunkStartedAt: 0,
    offsetAtStart: 0,
    source: null,
    gain: null,
    state: 'synthesizing',
    paused: null,
    progressFrame: null,
    streamPushedIdx: 0,
    streamEnded: false,
    driveRunning: false,
    seekPending: false,
    cumulativeChars: 0,
    voiceId: settings.get().voice,
  });
  activeReply = reply;
  replyCache.setPinnedId(replyId);
  emit('synth-start', { replyId, chunks: 0 });
  log(`TTS stream begin: reply=${replyId}`);

  // Diagnostic dump — visible in debug panel.
  try {
    const ctx = getAudioCtx();
    const audioSession = /** @type {any} */ (navigator).audioSession;
    const tracks = getActiveStream()?.getAudioTracks() || [];
    diag('TTS route check:',
      'ctx.state=', ctx?.state,
      'ctx.rate=', ctx?.sampleRate,
      'dest.ch=', ctx?.destination?.channelCount,
      'session.type=', audioSession?.type,
      'mic=', tracks[0]?.label || '(n/a)',
      'sinkId=', player?.sinkId || '(default)');
  } catch {}

  return replyId;
}

/** Feed cumulative reply text from agent streaming. tts.ts tracks what
 *  portion has already been consumed and extracts any new sentence-complete
 *  region into new chunks, synthesizing in the background. Safe to call
 *  repeatedly with the same text (no-op). */
export function pushReplyText(cumulativeText) {
  if (!activeReply || activeReply.streamEnded) return;
  const cleaned = cleanForTts(cumulativeText);
  // Track cumulative chars for proportional load bar, even if this push
  // doesn't produce new sentence-complete chunks.
  activeReply.cumulativeChars = Math.max(activeReply.cumulativeChars, cleaned.length);
  emitLoadProgress(activeReply);
  const slice = findStableSlice(cleaned, activeReply.streamPushedIdx);
  if (!slice) return;
  activeReply.streamPushedIdx = slice.nextIdx;
  const newChunks = chunkForTts(slice.stable);
  const gen = activeReply.gen;
  for (const chunkText of newChunks) addChunkToReply(activeReply, chunkText, gen);
  // Kick off the play loop on the first chunk. Subsequent pushes just add
  // chunks; the loop's tail-wait will pick them up.
  if (activeReply.state === 'synthesizing') {
    activeReply.state = 'playing';
    emit('play-start', { replyId: activeReply.id });
    setStatus(`${getListening() ? 'Mic muted — ' : ''}Speaking`, 'live');
    startProgressLoop(activeReply);
    drivePlayback(activeReply);
  }
}

/** Finalize the stream. Flushes any remaining tip text (past the last
 *  sentence boundary) as a last chunk, then marks stream ended. Caller
 *  may pass the final cumulative text; otherwise whatever was last
 *  pushed is the cut point. */
export function endReply(finalCumulativeText) {
  if (!activeReply || activeReply.streamEnded) return;
  const cleaned = finalCumulativeText != null ? cleanForTts(finalCumulativeText) : null;
  const gen = activeReply.gen;
  if (cleaned) {
    activeReply.cumulativeChars = Math.max(activeReply.cumulativeChars, cleaned.length);
    // Push any new stable text first
    const slice = findStableSlice(cleaned, activeReply.streamPushedIdx);
    if (slice) {
      activeReply.streamPushedIdx = slice.nextIdx;
      const newChunks = chunkForTts(slice.stable);
      for (const chunkText of newChunks) addChunkToReply(activeReply, chunkText, gen);
    }
    // Flush the remaining tip (text past the last sentence boundary)
    const tip = cleaned.slice(activeReply.streamPushedIdx).trim();
    if (tip) {
      const newChunks = chunkForTts(tip);
      for (const chunkText of newChunks) addChunkToReply(activeReply, chunkText, gen);
      activeReply.streamPushedIdx = cleaned.length;
    }
  }
  activeReply.streamEnded = true;
  emitLoadProgress(activeReply);
  // If no chunks were ever pushed (empty reply), immediately end.
  if (activeReply.chunks.length === 0) {
    activeReply.state = 'ended';
    emit('ended', { replyId: activeReply.id });
    finalizeReply();
    return;
  }
  // If the state machine hasn't started yet (somehow), kick it
  if (activeReply.state === 'synthesizing') {
    activeReply.state = 'playing';
    emit('play-start', { replyId: activeReply.id });
    setStatus(`${getListening() ? 'Mic muted — ' : ''}Speaking`, 'live');
    startProgressLoop(activeReply);
    drivePlayback(activeReply);
  }
  log(`TTS stream end: reply=${activeReply.id} chunks=${activeReply.chunks.length}`);
}

/** One-shot speak: synthesize + play a complete text. For the server-TTS
 *  path this internally routes through beginReply/endReply, so callers get
 *  the full event stream + pause/resume/seek "for free." For the local
 *  (Web Speech) path this bypasses the state machine (no events/scrubbing
 *  supported on local TTS — legacy limitation).
 *
 *  Options:
 *   - opts.replyId      — caller-provided reply id; fresh one minted if absent.
 *   - opts.forceServer  — override the user's ttsEngine preference and use
 *                         server TTS even if engine==='local'. Used by the
 *                         replay path (bubble play buttons) since local
 *                         speechSynthesis on Chrome desktop has a
 *                         cancel-loop bug (crbug/521818) that silently
 *                         drops audio after rapid play-click interactions,
 *                         and plays through speaker causing mic feedback
 *                         back into STT. Replay should always be reliable
 *                         so it forces the server path.
 */
export async function speak(text: string, opts: { forceServer?: boolean; replyId?: string } = {}) {
  const clean = cleanForTts(text);
  if (!clean || !player) return;
  try { player.pause(); } catch {}

  const engine = opts.forceServer ? 'server' : settings.get().ttsEngine;
  if (engine === 'local') {
    const gen = ++generation;
    speaking = true;
    sttOnTtsStart();
    session.prepareForPlayback();
    log(`TTS (local): ${clean.length} chars`);
    setStatus(`${getListening() ? 'Mic muted — ' : ''}Speaking`, 'live');
    try {
      await speakLocal(clean, gen);
    } catch (e) {
      log('local TTS error:', e.message);
    } finally {
      if (gen === generation) finalizeReply();
    }
    return;
  }

  // Server TTS — route through the streaming API as a single push. The
  // begin/end pair creates the reply, synthesizes the full text as one or
  // more chunks, and drives playback.
  const replyId = beginReply({ replyId: opts.replyId });
  endReply(text);

  // Await natural end so existing (awaited) callers still behave the same.
  await new Promise<void>((resolve) => {
    const done = (p) => {
      if (p.replyId !== replyId) return;
      off('ended', done);
      off('stopped', done);
      resolve();
    };
    on('ended', done);
    on('stopped', done);
  });
}

/** Stop all TTS (button or barge-in). Destructive — bumps the generation
 *  counter so any in-flight playback loop exits; activeReply is cleared.
 *  For a resumable halt, use pause() instead. */
export function stop(reason = 'user') {
  const hasActive = activeReply && (activeReply.state === 'playing' || activeReply.state === 'paused' || activeReply.state === 'synthesizing');
  if (!speaking && !hasActive && !currentUtter && (!player || player.paused)) {
    // Nothing is actively playing, but a post-TTS tail window might still be
    // gating the mic. On barge-in, collapse it so the user's speech flows
    // through immediately.
    if (reason === 'barge-in' && Date.now() < speakingTailUntil) {
      speakingTailUntil = 0;
      log('TTS tail cleared by barge-in');
    }
    return false;
  }
  // Save playback position before destroying — enables resume-on-return
  // for the prev/next track buttons in pocket-lock + Media Session. Skipped
  // for barge-in / user / button reasons since those are "explicit clean
  // halt" — user doesn't want to half-resume later.
  if (reason === 'previous-track' || reason === 'next-track' || reason === 'superseded') {
    captureOutgoingPosition();
  } else {
    // Explicit user stop clears any prior saved position on this reply —
    // the next play should start from 0.
    if (activeReply && replyCache.has(activeReply.id)) {
      replyCache.setPosition(activeReply.id, null);
    }
  }
  generation++;
  try { player.pause(); } catch {}
  // Local TTS: cancel any active utterance (web speech synthesis queue).
  if (typeof speechSynthesis !== 'undefined') {
    try { speechSynthesis.cancel(); } catch {}
  }
  currentUtter = null;
  if (activeReply?.source) {
    // 30ms linear gain ramp → avoids click/pop from cutting the waveform
    // mid-sample on barge-in or user-stop.
    const src = activeReply.source;
    const g = activeReply.gain;
    activeReply.source = null;
    activeReply.gain = null;
    const audioCtx = getAudioCtx();
    if (g && audioCtx) {
      const now = audioCtx.currentTime;
      try {
        g.gain.cancelScheduledValues(now);
        g.gain.setValueAtTime(g.gain.value, now);
        g.gain.linearRampToValueAtTime(0, now + 0.03);
      } catch {}
      setTimeout(() => {
        try { src.stop(); } catch {}
        try { src.disconnect(); } catch {}
        try { g.disconnect(); } catch {}
      }, 40);
    } else {
      try { src.stop(); } catch {}
      try { src.disconnect(); } catch {}
    }
  }
  if (activeReply) {
    stopProgressLoop(activeReply);
    activeReply.state = 'stopped';
    emit('stopped', { replyId: activeReply.id, reason });
    activeReply = null;
  }
  // Unpin — the reply no longer needs LRU protection. It's still in the
  // cache until something else evicts it; the user can still replay.
  replyCache.setPinnedId(null);
  // Post-stop cleanup. Barge-in keeps the tail collapsed (handled above)
  // so this branch is just for "normal" stop reasons.
  finalizeReply();
  if (reason === 'barge-in') {
    speakingTailUntil = 0;
  }
  speaking = false;
  // Barge-in means the user is actively speaking right now — drop the tail
  // guard so their speech flows into STT immediately. Any other stop reason
  // (button press, TTS finish, generation bump) gets the echo tail window.
  speakingTailUntil = reason === 'barge-in' ? 0 : Date.now() + TTS_TAIL_MS;
  sttOnTtsEnd();
  session.prepareForCapture();
  setStatus(getListening() ? 'Listening' : 'Idle', getListening() ? 'live' : 'ok');
  log(`TTS stopped (${reason})`);
  if (onStopCallback) onStopCallback(reason);
  return true;
}
