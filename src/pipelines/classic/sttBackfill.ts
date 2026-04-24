/**
 * @fileoverview STT gap-backfill — recover dictation lost to DG dropouts.
 *
 * Problem: when the Deepgram streaming WebSocket drops or its server-side
 * ASR pipeline wedges, the audio spoken during the gap never gets
 * transcribed. The live draft has a hole.
 *
 * Solution: while the user is dictating, we buffer every raw audio frame
 * the AudioWorklet produces into a ring of `{ ctxTime, samples }` entries.
 * When deepgram.ts tells us the stream lost coverage (WS closed / wedge
 * detected), we record the gap's start time. When it tells us coverage
 * resumed (WS reopened), we close the gap. On mic-stop, we slice each
 * completed gap's samples out of the ring, encode as WAV, POST to the
 * existing /transcribe endpoint, and hand the resulting text back to the
 * caller (voice.ts) which splices it into the draft.
 *
 * Memory: bounded by `MAX_BUFFER_SECONDS` (default 180s). At 48 kHz mono
 * int16 that's ~17 MB worst-case. Oldest frames drop as new ones arrive.
 *
 * Precision: gap start/end are main-thread timestamps taken from
 * `audioCtx.currentTime` at the moment deepgram.ts reports the state
 * change. Drift between the audio thread and the main thread is on the
 * order of ~10 ms — well below gap-resolution requirements (a dropout
 * is typically seconds long).
 *
 * Not thread-safe; all methods run on the main thread.
 */

import { log } from '../../util/log.ts';
import { fetchWithTimeout } from '../../util/fetchWithTimeout.ts';
import { int16ToWav } from './wav.ts';

// ── Configuration ─────────────────────────────────────────────────────────

/** How much audio history to keep in the ring buffer (seconds). A gap
 *  older than this can no longer be recovered — `flushGaps()` will
 *  silently skip it. Dictation sessions shorter than this are fully
 *  covered; longer sessions retain the trailing window. */
const MAX_BUFFER_SECONDS = 180;

/** Minimum gap duration we'll bother transcribing. Below this, either
 *  the dropout was so short that DG may have already flushed its tail,
 *  or there's simply not enough audio to transcribe reliably. */
const MIN_GAP_SECONDS = 0.5;

/** Per-gap retry schedule on /transcribe failure (ms between attempts).
 *  Covers transient network flakiness at flush time (e.g. user stopped
 *  mic while still rolling into a dead-zone on the bike). After these
 *  attempts, the gap is stashed in the deferred queue and retried when
 *  the next successful /transcribe clears the path. */
const RETRY_DELAYS_MS = [0, 1000, 3000];

/** Max wall-clock age of a deferred gap before we give up on it. If the
 *  user never listens again for 10 minutes, odds that the context still
 *  matters are low. */
const DEFERRED_MAX_AGE_MS = 10 * 60 * 1000;

// ── State ─────────────────────────────────────────────────────────────────

/**
 * @typedef {{ ctxTime: number, samples: Int16Array }} AudioFrame
 * One AudioWorklet message-out event. `ctxTime` is the audio-context
 * currentTime at the moment the main thread received the frame.
 */

/**
 * @typedef {{ start: number, end: number|null }} GapInterval
 * ctxTime range during which DG was believed to be offline. `end` is
 * null while the gap is still open (DG hasn't come back yet).
 */

/** Ring of buffered frames, oldest-first. Capped by total duration.
 *  @type {AudioFrame[]} */
let frames = [];

/** AudioContext sample rate snapshot — populated by init(); used when
 *  wrapping extracted samples into a WAV header. */
let sampleRate = 48000;

/** The gap currently open (if any). Null when DG is believed healthy.
 *  @type {GapInterval|null} */
let activeGap = null;

/** Completed gaps, in order they occurred. Consumed by flushGaps().
 *  @type {GapInterval[]} */
let completedGaps = [];

/**
 * @typedef {{ ctxStart: number, ctxEnd: number, blob: Blob, queuedAt: number }} DeferredGap
 * A gap that was captured + extracted into a WAV blob but whose
 * /transcribe call failed after all retries. Held in memory across
 * mic sessions; drained opportunistically by drainDeferred() after
 * the next successful /transcribe.
 */

/** In-memory queue of failed-to-transcribe gaps. Not persisted across
 *  page refreshes — acceptable since a bike-connectivity dropout
 *  typically resolves within a few minutes and we'll drain the queue
 *  on the next successful listen session in the same page lifetime.
 *  @type {DeferredGap[]} */
let deferredGaps = [];

// ── Public API ─────────────────────────────────────────────────────────────

/** Prepare for a fresh dictation session. Call at mic start. Safe to
 *  call repeatedly — each call clears prior buffer/gap state. */
export function init({ audioCtx }) {
  if (audioCtx && typeof audioCtx.sampleRate === 'number') {
    sampleRate = audioCtx.sampleRate;
  }
  frames = [];
  activeGap = null;
  completedGaps = [];
  log(`sttBackfill: init (sampleRate=${sampleRate})`);
}

/** Drop all buffered state. Call after flushGaps() has consumed the
 *  session's gaps, or on any hard reset (e.g. /new). */
export function reset() {
  frames = [];
  activeGap = null;
  completedGaps = [];
}

/** Ingest one AudioWorklet frame. Called on every worklet postMessage
 *  from deepgram.js's existing message handler — regardless of
 *  whether the DG WS is open or closed. We want to have a clean copy
 *  of ALL audio, not just the parts that DG got.
 *
 *  The `samples` buffer is copied here (not referenced) because the
 *  worklet posts transferable ArrayBuffers and the original reference
 *  becomes unusable after postMessage completes.
 *
 *  @param {ArrayBuffer} buffer — raw 16-bit PCM from audio-processor.js
 *  @param {number} ctxTime — audioCtx.currentTime at receive
 */
export function pushFrame(buffer, ctxTime) {
  // ArrayBuffer → Int16Array view. Copy the underlying bytes so we can
  // safely retain them past this call.
  const view = new Int16Array(buffer);
  const copy = new Int16Array(view.length);
  copy.set(view);
  frames.push({ ctxTime, samples: copy });
  // Trim the head of the ring until it fits within MAX_BUFFER_SECONDS.
  const cutoff = ctxTime - MAX_BUFFER_SECONDS;
  while (frames.length > 0 && frames[0].ctxTime < cutoff) {
    frames.shift();
  }
}

/** Seconds of audio currently buffered as an OPEN gap (DG is down and
 *  we're holding speech locally until it comes back). Status bar reads
 *  this to show "Xs buffered" during weak signal so the user knows the
 *  system is still capturing even though no transcripts are landing.
 *  Returns 0 when there's no active gap. */
export function getBufferedSeconds(): number {
  if (!activeGap) return 0;
  // Use the most recent frame's ctxTime as the upper bound. frames[]
  // is kept sorted by insertion order (monotonic ctxTime), so the tail
  // is always the newest frame.
  const latest = frames.length > 0 ? frames[frames.length - 1].ctxTime : activeGap.start;
  return Math.max(0, latest - activeGap.start);
}

/** True iff we're currently inside an open DG dropout (WS has closed
 *  and markGapEnd hasn't been called yet). Used by voice.ts to defer
 *  the auto-send silence timer — otherwise a long dropout produces
 *  two messages: one when the silence timer fires against the partial
 *  pre-drop draft, and a second when the backfill arrives to extend it. */
export function isInGap(): boolean {
  return activeGap !== null;
}

/** Mark the start of a dropout. Idempotent — if a gap is already
 *  open, the call is ignored (we already noted the earlier start).
 *
 *  @param {number} ctxTime — audioCtx.currentTime at the state event
 */
export function markGapStart(ctxTime) {
  if (activeGap) return;
  activeGap = { start: ctxTime, end: null };
  log(`sttBackfill: gap start @ ${ctxTime.toFixed(2)}s`);
}

/** Mark the end of a dropout. If no gap is open, the call is ignored
 *  (happens on the very first WS open — there's nothing to close). */
export function markGapEnd(ctxTime) {
  if (!activeGap) return;
  activeGap.end = ctxTime;
  const durationSec = ctxTime - activeGap.start;
  if (durationSec >= MIN_GAP_SECONDS) {
    completedGaps.push(activeGap);
    log(`sttBackfill: gap end @ ${ctxTime.toFixed(2)}s (duration ${durationSec.toFixed(2)}s, queued)`);
  } else {
    log(`sttBackfill: gap end @ ${ctxTime.toFixed(2)}s (duration ${durationSec.toFixed(2)}s, too short — skipped)`);
  }
  activeGap = null;
}

/** Process all completed gaps: extract samples, encode as WAV, POST to
 *  /transcribe (with retry), collect transcripts. Returns an array of
 *  `{ ctxStart, ctxEnd, text }` in the original gap order. Consumes
 *  `completedGaps` — subsequent calls (without new gaps) return [].
 *
 *  Called from voice.ts on mic stop. Safe to call with zero gaps
 *  (returns [] immediately). Any permanent /transcribe failure for a
 *  gap is deferred to `deferredGaps` for retry on the next successful
 *  flush, not dropped outright.
 *
 *  Drains `deferredGaps` too — any failures from previous sessions
 *  get another shot every time we're online. */
export async function flushGaps() {
  if (completedGaps.length === 0 && deferredGaps.length === 0) return [];
  const gaps = completedGaps;
  completedGaps = [];
  const results = [];
  if (gaps.length > 0) log(`sttBackfill: flushing ${gaps.length} gap(s)`);

  // Prepare current gaps — extract samples, encode WAV, attempt transcribe.
  for (const gap of gaps) {
    const blob = buildGapBlob(gap);
    if (!blob) continue;
    const text = await transcribeWithRetry(blob, gap.start, gap.end);
    if (text) {
      results.push({ ctxStart: gap.start, ctxEnd: gap.end ?? gap.start, text });
    } else {
      // All retries failed — defer for a later drain.
      deferredGaps.push({
        ctxStart: gap.start,
        ctxEnd: gap.end ?? gap.start,
        blob,
        queuedAt: Date.now(),
      });
      log(`sttBackfill: gap @ ${gap.start.toFixed(1)}s deferred after retry exhaust (queue size: ${deferredGaps.length})`);
    }
  }

  // Now drain any deferred gaps from previous failures. These may
  // belong to earlier sessions — their ctxTime timestamps won't
  // line up with the current draft for positional splice, so voice.ts
  // will fall through to append-at-end. That's OK — the user sees
  // the late-arriving text flagged as backfill.
  await drainDeferred(results);

  return results;
}

/** Proactively retry the deferred-gap queue and return any that now
 *  transcribe successfully. Intended to be wired to a network-recovery
 *  event (DG `dg-open`, `navigator.online`) so that gaps from a
 *  previous connectivity hiccup don't wait for the user to stop the
 *  mic before surfacing. Never throws; failing gaps stay queued. */
export async function tryDrainDeferred() {
  const results = [];
  await drainDeferred(results);
  return results;
}

/** Attempt to re-transcribe previously-deferred gaps. Each successful
 *  one is added to `results`, removed from the queue. Expired entries
 *  (> DEFERRED_MAX_AGE_MS) are dropped silently. */
async function drainDeferred(results) {
  if (deferredGaps.length === 0) return;
  const now = Date.now();
  const remaining = [];
  log(`sttBackfill: attempting drain of ${deferredGaps.length} deferred gap(s)`);
  for (const d of deferredGaps) {
    if (now - d.queuedAt > DEFERRED_MAX_AGE_MS) {
      log(`sttBackfill: deferred gap @ ${d.ctxStart.toFixed(1)}s aged out, dropping`);
      continue;
    }
    const text = await transcribeWithRetry(d.blob, d.ctxStart, d.ctxEnd);
    if (text) {
      results.push({ ctxStart: d.ctxStart, ctxEnd: d.ctxEnd, text });
    } else {
      // Still failing — keep it for next time.
      remaining.push(d);
    }
  }
  deferredGaps = remaining;
}

/** POST one WAV blob to /transcribe, retrying RETRY_DELAYS_MS.length times
 *  with the configured backoff. Returns transcript on success, or empty
 *  string on exhaustion. Never throws. */
async function transcribeWithRetry(blob, ctxStart, ctxEnd) {
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    if (RETRY_DELAYS_MS[attempt] > 0) await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    try {
      const res = await fetchWithTimeout('/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: blob,
        // 15s — matches the memo /transcribe budget. sttBackfill is
        // already a retry loop so a timeout here just means "this
        // attempt didn't land, try the next backoff slot."
        timeoutMs: 15_000,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.ok || !data.transcript) return '';
      const text = data.transcript.trim();
      log(`sttBackfill: gap ${ctxStart.toFixed(1)}-${ctxEnd.toFixed(1)}s (attempt ${attempt + 1}) → "${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"`);
      return text;
    } catch (e) {
      log(`sttBackfill: gap ${ctxStart.toFixed(1)}s attempt ${attempt + 1} failed: ${e.message}`);
    }
  }
  return '';
}

// ── Internals ─────────────────────────────────────────────────────────────

/** Extract frames whose ctxTime is within a gap's range, concatenate
 *  samples, trim leading/trailing near-silence, and wrap as a WAV Blob.
 *  Returns null if the gap didn't produce any samples (all outside the
 *  retained buffer window — frames rolled off).
 *
 *  Silence trimming rationale: on a flaky ride the drop-and-reconnect
 *  pattern means some gaps are dominated by silence (user wasn't
 *  talking when the WS died). Shipping the raw buffer bloats
 *  /transcribe payloads and uses bandwidth we're already short on.
 *  Peak-threshold trim at 0.015 (Int16 peak of ~491) removes quiet
 *  edges while leaving any actual speech + natural pauses in the
 *  middle intact. Empirically ~30-60% size reduction on real rides. */
const SILENCE_PEAK_INT16 = 491;  // ≈ 0.015 of full scale
function trimSilenceEdges(samples: Int16Array): Int16Array {
  const n = samples.length;
  if (n === 0) return samples;
  let head = 0;
  while (head < n && Math.abs(samples[head]) < SILENCE_PEAK_INT16) head++;
  // If the whole buffer was below threshold, keep everything rather
  // than return an empty Int16Array — a truly silent gap has zero
  // transcript anyway, and an empty WAV trips edge cases in encoders.
  if (head >= n) return samples;
  let tail = n - 1;
  while (tail > head && Math.abs(samples[tail]) < SILENCE_PEAK_INT16) tail--;
  if (head === 0 && tail === n - 1) return samples;
  return samples.subarray(head, tail + 1);
}

function buildGapBlob(gap) {
  const end = /** @type {number} */ (gap.end);
  const slices = [];
  let total = 0;
  for (const frame of frames) {
    if (frame.ctxTime >= gap.start && frame.ctxTime < end) {
      slices.push(frame.samples);
      total += frame.samples.length;
    }
  }
  if (total === 0) {
    log(`sttBackfill: gap @ ${gap.start.toFixed(1)}s produced no buffered samples (rolled off)`);
    return null;
  }
  const merged = new Int16Array(total);
  let pos = 0;
  for (const s of slices) { merged.set(s, pos); pos += s.length; }
  const trimmed = trimSilenceEdges(merged);
  const droppedSec = (merged.length - trimmed.length) / sampleRate;
  const blob = int16ToWav(trimmed, sampleRate);
  log(`sttBackfill: gap blob ${gap.start.toFixed(1)}-${end.toFixed(1)}s (${(blob.size / 1024).toFixed(0)}KB, trimmed ${droppedSec.toFixed(1)}s of edge silence)`);
  return blob;
}
