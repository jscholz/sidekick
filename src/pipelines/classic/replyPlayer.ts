/**
 * @fileoverview Per-bubble TTS playback UI — loading bar, playback bar,
 * play/pause/replay button, scrub-by-tap.
 *
 * Subscribes to tts events and updates the DOM of whichever agent bubble
 * has a matching `data-reply-id`. All state lives in the DOM so replies
 * keep their rendered progress across re-renders + session restores.
 *
 * Bar layering:
 *   .play-bar-loaded  — tinted sage, width = synthesizedChars / cumulativeChars
 *                       (grows as synthesis catches up to generated text)
 *   .play-bar-played  — bright sage,  width = position / (loaded-or-total)
 *                       (chases the loaded bar as audio plays)
 *
 * Icon state on .play-btn (CSS swaps glyph via .playing / .paused classes):
 *   idle / ended   — play icon, grey
 *   playing        — pause icon, bright sage
 *   paused         — play icon, bright sage
 */

import { log } from '../../util/log.ts';
import * as tts from './tts.ts';
import * as replyCache from './replyCache.ts';

/** @type {HTMLElement|null} */
let transcriptEl = null;

export function init(opts) {
  transcriptEl = opts?.transcriptEl || null;
  if (!transcriptEl) return;

  tts.on('synth-start',    onSynthStart);
  tts.on('load-progress',  onLoadProgress);
  tts.on('duration-known', onDurationKnown);
  tts.on('play-start',     onPlayStart);
  tts.on('progress',       onProgress);
  tts.on('seek',           onSeek);
  tts.on('paused',         onPaused);
  tts.on('resumed',        onResumed);
  tts.on('ended',          onEnded);
  tts.on('stopped',        onStopped);

  // Delegated click handler — bubbles come and go (streaming, session
  // restore, chat.clear) so we don't want per-line listeners.
  transcriptEl.addEventListener('click', onTranscriptClick);
  // Separate pointerdown handler for the scrub bar so drag-to-scrub
  // works on touch + mouse. Delegated like the click handler.
  transcriptEl.addEventListener('pointerdown', onTranscriptPointerDown);

  // Cache-driven icon state: grey play icon for bubbles without cached
  // audio, sage icon for those with cache. Flip on cache events.
  replyCache.on('cached',  ({ replyId }) => {
    const bubble = findBubble(replyId);
    if (bubble) bubble.classList.add('tts-cached');
  });
  replyCache.on('evicted', ({ replyId }) => {
    const bubble = findBubble(replyId);
    if (bubble) bubble.classList.remove('tts-cached');
  });
}

/** Public helper so main.ts can mark newly-restored bubbles as cached
 *  when they match an already-populated cache entry (e.g. if reply audio
 *  was generated, then user reloaded — not currently applicable since
 *  cache is in-memory, but leaves the door open for persistence). */
export function syncCacheBadges() {
  if (!transcriptEl) return;
  transcriptEl.querySelectorAll('.line.agent[data-reply-id]').forEach((el) => {
    const bubble = /** @type {HTMLElement} */ (el);
    const id = bubble.dataset.replyId;
    if (id && replyCache.has(id)) bubble.classList.add('tts-cached');
    else bubble.classList.remove('tts-cached');
  });
}

function findBubble(replyId) {
  if (!transcriptEl || !replyId) return null;
  return /** @type {HTMLElement|null} */ (
    transcriptEl.querySelector(`.line[data-reply-id="${CSS.escape(replyId)}"]`)
  );
}

function setLoadedRatio(bubble, ratio) {
  const el = bubble.querySelector('.play-bar-loaded');
  if (el) /** @type {HTMLElement} */ (el).style.width = `${Math.min(100, Math.max(0, ratio * 100))}%`;
}

function setPlayedRatio(bubble, ratio) {
  const el = bubble.querySelector('.play-bar-played');
  if (el) /** @type {HTMLElement} */ (el).style.width = `${Math.min(100, Math.max(0, ratio * 100))}%`;
}

/** Set the play-button icon state. CSS picks up .playing / .paused to
 *  swap between play/pause glyphs and adjust color. */
function setBtnState(bubble, state) {
  bubble.classList.remove('tts-playing', 'tts-paused');
  if (state === 'playing') bubble.classList.add('tts-playing');
  else if (state === 'paused') bubble.classList.add('tts-paused');
}

function onSynthStart({ replyId }) {
  const bubble = findBubble(replyId);
  if (!bubble) return;
  bubble.classList.add('tts-active', 'tts-streaming');
  bubble.classList.remove('tts-played');
  setLoadedRatio(bubble, 0);
  setPlayedRatio(bubble, 0);
}

function onLoadProgress({ replyId, ratio }) {
  const bubble = findBubble(replyId);
  if (!bubble) return;
  setLoadedRatio(bubble, ratio);
}

function onDurationKnown({ replyId, duration }) {
  const bubble = findBubble(replyId);
  if (!bubble) return;
  bubble.classList.remove('tts-streaming');
  // Duration is known → all chunks synthesized → loaded bar = 100%.
  setLoadedRatio(bubble, 1);
}

function onPlayStart({ replyId }) {
  const bubble = findBubble(replyId);
  if (!bubble) return;
  bubble.classList.add('tts-active');
  setBtnState(bubble, 'playing');
}

function onProgress({ replyId, position, duration, estimatedTotal }) {
  const bubble = findBubble(replyId);
  if (!bubble) return;
  // Denominator priority: known total > estimated total (mid-stream) > 1.
  // Must NOT fall back to `position` — that gives ratio=1 and the bar
  // flashes full-green before audio actually starts.
  const ref = duration || estimatedTotal || 1;
  setPlayedRatio(bubble, position / ref);
}

function onSeek({ replyId, position, duration }) {
  const bubble = findBubble(replyId);
  if (!bubble) return;
  const ref = duration || 1;
  setPlayedRatio(bubble, position / ref);
}

function onPaused({ replyId }) {
  const bubble = findBubble(replyId);
  if (!bubble) return;
  setBtnState(bubble, 'paused');
  // If the bubble was marked fully-played (scrub-after-end → paused),
  // drop the played class so the icon reflects "paused, can resume"
  // rather than "already heard this".
  bubble.classList.remove('tts-played');
  bubble.classList.add('tts-active');
}

function onResumed({ replyId }) {
  const bubble = findBubble(replyId);
  if (!bubble) return;
  setBtnState(bubble, 'playing');
}

function onEnded({ replyId }) {
  const bubble = findBubble(replyId);
  if (!bubble) return;
  bubble.classList.remove('tts-active', 'tts-streaming');
  bubble.classList.add('tts-played');
  setBtnState(bubble, 'idle');
  setLoadedRatio(bubble, 1);
  setPlayedRatio(bubble, 1);
}

function onStopped({ replyId, reason }) {
  const bubble = findBubble(replyId);
  if (!bubble) return;
  bubble.classList.remove('tts-active', 'tts-streaming');
  setBtnState(bubble, 'idle');
  if (reason === 'user' || reason === 'button') {
    bubble.classList.add('tts-played');
  }
  log(`reply stopped (${reason}): ${replyId}`);
}

// ── Click + drag handlers (delegated) ─────────────────────────────────────

function onTranscriptClick(e) {
  const target = /** @type {HTMLElement} */ (e.target);
  const playBtn = target.closest('.play-btn');
  if (playBtn) { onPlayClick(e, playBtn); return; }
  // Bar taps are handled via pointerdown (below) to also support drag.
}

/** Pointer events unify mouse + touch so drag-to-scrub works on iOS + desktop.
 *  On pointerdown on a .play-bar: seek immediately to the tap ratio, then
 *  listen for pointermove to continue scrubbing. Release on pointerup /
 *  pointercancel. */
function onTranscriptPointerDown(e) {
  const target = /** @type {HTMLElement} */ (e.target);
  const bar = target.closest('.play-bar');
  if (!bar) return;
  onBarPointerDown(e, /** @type {HTMLElement} */ (bar));
}

function onBarPointerDown(e, bar) {
  e.stopPropagation();
  e.preventDefault();
  const bubble = /** @type {HTMLElement|null} */ (bar.closest('.line'));
  if (!bubble) return;
  // iOS AudioContext unlock + id/text coercion — same as play-click path.
  tts.ensureAudioCtx();
  let replyId = bubble.dataset.replyId;
  if (!replyId) {
    replyId = `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    bubble.dataset.replyId = replyId;
  }
  const text = bubble.dataset.text
    || bubble.querySelector('.text')?.textContent?.trim()
    || '';

  const rect = bar.getBoundingClientRect();
  const ratioAt = (clientX) => Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const ratio = ratioAt(e.clientX);
  log(`bar pointerdown: bubble=${replyId} active=${tts.getReplyId()} ratio=${ratio.toFixed(2)} cacheHit=${replyCache.has(replyId)}`);

  const seekOrStart = (r) => {
    if (replyId && tts.getReplyId() === replyId) {
      tts.seekTo(r);
      return;
    }
    // Not active — start fresh playback (cache-first) then seek once ready.
    if (tts.isSpeaking()) tts.stop('button');
    const started = replyId && replyCache.has(replyId) && tts.playCached(replyId);
    if (!started && text) tts.speak(text, { replyId: replyId || undefined, forceServer: true });
    const targetId = replyId;
    const onDone = (p) => {
      if (p.replyId === (targetId || tts.getReplyId())) {
        tts.off('duration-known', onDone);
        tts.seekTo(r);
      }
    };
    tts.on('duration-known', onDone);
  };

  seekOrStart(ratio);
  try { bar.setPointerCapture(e.pointerId); } catch {}

  const onMove = (ev) => {
    // Only seek if the reply is now active (playCached above has hydrated it).
    if (replyId && tts.getReplyId() === replyId) {
      tts.seekTo(ratioAt(ev.clientX));
    }
  };
  const onUp = () => {
    bar.removeEventListener('pointermove', onMove);
    bar.removeEventListener('pointerup', onUp);
    bar.removeEventListener('pointercancel', onUp);
    try { bar.releasePointerCapture(e.pointerId); } catch {}
  };
  bar.addEventListener('pointermove', onMove);
  bar.addEventListener('pointerup', onUp);
  bar.addEventListener('pointercancel', onUp);
}

function onPlayClick(e, btn) {
  e.stopPropagation();
  // iOS: the AudioContext must be created in a user gesture. Mic-button
  // clicks do this; play-button clicks didn't — so fresh page loads
  // that went straight to play (typical on cross-device session pickup)
  // had null audioCtx → decodeChunk returned null → silence.
  tts.ensureAudioCtx();
  const bubble = /** @type {HTMLElement|null} */ (btn.closest('.line'));
  if (!bubble) return;
  // Restored-from-sessionStorage bubbles may lack data-reply-id (if the
  // snapshot predates that attribute). Mint one now so this session's
  // events target the bubble correctly.
  let replyId = bubble.dataset.replyId;
  if (!replyId) {
    replyId = `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    bubble.dataset.replyId = replyId;
  }
  // data-text might be missing on old bubbles — fall back to the
  // rendered .text span (markdown already unwrapped by textContent).
  const text = bubble.dataset.text
    || bubble.querySelector('.text')?.textContent?.trim()
    || '';
  if (!text) return;
  bubble.dataset.text = text;  // cache for future clicks

  log(`play click: bubble=${replyId} active=${tts.getReplyId()} state=${tts.getState()} cacheHit=${replyCache.has(replyId)} speaking=${tts.isSpeaking()}`);

  // If this bubble is the currently active reply, toggle based on state.
  // Using getState() (not isSpeaking) so the 600ms post-TTS tail window
  // doesn't accidentally route to pause().
  if (replyId && tts.getReplyId() === replyId) {
    const state = tts.getState();
    if (state === 'playing') { tts.pause(); return; }
    if (state === 'paused')  { tts.resume(); return; }
    if (state === 'ended' && tts.replay()) return;
    // Fall through to cached → synth below.
  }
  if (tts.isSpeaking()) tts.stop('button');
  // Cache hit → instant replay of any reply (including old bubbles).
  if (replyId && replyCache.has(replyId) && tts.playCached(replyId)) return;
  // Cache miss → re-synthesize via server TTS. forceServer overrides the
  // user's ttsEngine setting because local speechSynthesis on Chrome
  // desktop has a cancel-loop bug that breaks rapid replay clicks + its
  // speaker-path playback re-enters STT as a feedback loop. Replay
  // should "just work" regardless of user's engine preference for
  // initial replies.
  tts.speak(text, { replyId: replyId || undefined, forceServer: true });
}

// (bar click/drag handling moved to onBarPointerDown above)
