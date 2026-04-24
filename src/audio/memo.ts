/**
 * @fileoverview Voice memo — WhatsApp-style local recording with waveform
 * and timer. Transcription happens on send (batch via /transcribe), not
 * during recording. This means:
 *  - Truly offline-capable: no network needed to record.
 *  - Same code path for online and offline sends (always POST the blob).
 *  - No race conditions on stop (no WS state to wait for).
 */

import { log } from '../util/log.ts';
import * as audioSession from './session.ts';
import * as capture from './capture.ts';
import { getAudioCtx } from './unlock.ts';
import { playFeedback } from './feedback.ts';

let analyser = null;
let mediaStream = null;
// AudioContext is the SHARED one from unlock.ts now. Streaming + TTS use
// the same context; iOS permits ~4 live contexts and we were creating/closing
// a fresh one per memo. Using the shared ctx avoids that pressure and
// simplifies state (auto-resume on visibilitychange is already handled by
// unlock.ts). We hold a module-local ref for convenience but never close it.
let audioCtx = null;
let audioSource = null;
let mediaRecorder = null;
let audioChunks = [];
let animFrame = null;
let timerInterval = null;
let startTime = 0;
let stopping = false;

export function isSupported() { return typeof MediaRecorder !== 'undefined'; }

/**
 * Start recording.
 * @param {Object} opts
 * @param {HTMLElement} opts.container
 * @param {HTMLElement} [opts.insertBefore]
 * @param {(audioBlob: Blob|null) => void} opts.onDone
 * @param {() => void} opts.onCancel
 */
export async function start(opts) {
  // Use the shared AudioContext from unlock.ts — created in a prior user
  // gesture (unlock(player) is called by main.ts's memo onclick right before
  // this) so it's already 'running' by the time we get here. No need to
  // create our own context; no need to kick off a new resume (unlock handles
  // resume + visibilitychange auto-resume).
  audioCtx = getAudioCtx();
  if (!audioCtx) {
    log('memo: no shared AudioContext — was unlock() skipped?');
    if (opts.onCancel) opts.onCancel();
    return false;
  }
  // Defensive: if the ctx slipped out of 'running' (iOS interrupt), try to
  // resume. Safe even without a gesture once the ctx is initially unlocked.
  const resumePromise = audioCtx.state !== 'running' ? audioCtx.resume() : null;

  // Render UI IMMEDIATELY — don't wait for the mic permission chime or
  // audio pipeline setup. drawWaveform safely no-ops when analyser is null,
  // so starting rAF early means bars animate the moment analyser connects.
  renderBar(opts.container, opts.onCancel, opts.insertBefore);
  startTime = Date.now();
  timerInterval = setInterval(updateTimer, 100);
  // Reset waveform state for a fresh recording
  wavePos = 0;
  frameCount = 0;
  waveHistory.fill(0);
  drawWaveform();

  try {
    // Centralized capture: handles iOS AVAudioSession prep + getUserMedia +
    // single-owner mutual exclusion. Throws if another subscriber (streaming)
    // still holds the stream — callers (main.ts's memo button) guarantee that
    // state is released before calling start().
    mediaStream = await capture.acquire('memo');
  } catch (e) {
    log('memo: mic error:', e.message);
    cleanup();
    if (opts.onCancel) opts.onCancel();
    return false;
  }

  if (resumePromise) { try { await resumePromise; } catch {} }
  log('memo: audioCtx state=', audioCtx.state);
  audioSource = audioCtx.createMediaStreamSource(mediaStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  audioSource.connect(analyser);

  // MediaRecorder captures audio as a blob — the only thing that matters for send
  audioChunks = [];
  try {
    mediaRecorder = new MediaRecorder(mediaStream, { mimeType: 'audio/webm;codecs=opus' });
  } catch {
    mediaRecorder = new MediaRecorder(mediaStream);
  }
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
  mediaRecorder.start(1000);

  log('memo: recording (MediaRecorder → blob)');
  // Subtle "mic is live" tick — seatbelt-style audible confirmation so
  // the user knows capture started without looking at the screen.
  playFeedback('start');
  return true;
}

/** Cancel the current memo without producing a blob — equivalent to
 *  tapping the trash button, but exposed as a method so other modules
 *  (e.g. main.ts's releaseCaptureIfActive) can coordinate without
 *  resorting to synthetic DOM clicks. Safe to call from any reset path;
 *  no-op when no memo is active. Does not invoke the onCancel callback
 *  passed to start() — callers that need UI teardown should handle that
 *  separately (e.g. exitMemoMode in main.ts). */
export function cancel() {
  cleanup();
}

/** Stop recording, return audio blob. Transcription happens on the caller's side. */
export async function stop() {
  if (stopping) return { audioBlob: null, durationMs: 0 };
  stopping = true;

  const durationMs = startTime ? Date.now() - startTime : 0;

  let audioBlob = null;
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    // Capture mimeType before the await — another code path (e.g.
    // releaseCaptureIfActive → trash.click → cleanup) can null
    // `mediaRecorder` while we're waiting for onstop to fire, which
    // made the post-await `mediaRecorder.mimeType` access crash.
    const mimeType = mediaRecorder.mimeType;
    await new Promise(resolve => {
      mediaRecorder.onstop = resolve;
      try { mediaRecorder.stop(); } catch { resolve(); }
      setTimeout(resolve, 1000); // safety net
    });
    if (audioChunks.length > 0) {
      audioBlob = new Blob(audioChunks, { type: mimeType });
    }
  }

  cleanup();
  stopping = false;
  return { audioBlob, durationMs };
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

function cleanup() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') { try { mediaRecorder.stop(); } catch {} }
  mediaRecorder = null;
  audioChunks = [];
  // MediaStream ownership lives in capture.ts — release through there so
  // mutual-exclusion state stays consistent. Null our local ref too since
  // other functions in this module check it during teardown.
  capture.release('memo');
  mediaStream = null;
  // AudioContext is shared — DO NOT close it (would kill streaming + TTS).
  // Just drop our reference. The analyser/source nodes we created will be
  // garbage-collected once no references remain.
  audioCtx = null;
  if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  analyser = null;
  audioSource = null;
  if (barEl) { barEl.remove(); barEl = null; }
  timerEl = null;
  canvasEl = null;
}

// ── UI ──────────────────────────────────────────────────────────────────────

let barEl = null;
let timerEl = null;
let canvasEl = null;

function renderBar(container, onCancel, insertBefore) {
  barEl = document.createElement('div');
  barEl.className = 'memo-bar';

  const btnTrash = document.createElement('button');
  btnTrash.className = 'memo-btn memo-trash';
  btnTrash.title = 'Discard';
  btnTrash.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4h10M6 4V2.5h4V4M4.5 4l.5 9.5h6l.5-9.5"/></svg>`;
  btnTrash.onclick = () => { cleanup(); if (onCancel) onCancel(); };

  const dot = document.createElement('span');
  dot.className = 'memo-dot';

  timerEl = document.createElement('span');
  timerEl.className = 'memo-timer';
  timerEl.textContent = '0:00';

  canvasEl = document.createElement('canvas');
  canvasEl.className = 'memo-wave';
  canvasEl.height = 32;

  barEl.appendChild(btnTrash);
  barEl.appendChild(dot);
  barEl.appendChild(timerEl);
  barEl.appendChild(canvasEl);

  if (insertBefore) {
    container.insertBefore(barEl, insertBefore);
  } else {
    container.appendChild(barEl);
  }
}

function updateTimer() {
  if (!timerEl) return;
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const min = Math.floor(elapsed / 60);
  const sec = elapsed % 60;
  timerEl.textContent = `${min}:${sec.toString().padStart(2, '0')}`;
}

// ── Waveform ────────────────────────────────────────────────────────────────

const WAVE_DOTS = 40;
/** Sample a new bar every N rAFs (slows scroll speed without dropping redraw fps). */
const FRAMES_PER_SAMPLE = 8;
const waveHistory = new Float32Array(WAVE_DOTS);
let wavePos = 0;
let frameCount = 0;

function drawWaveform() {
  // Keep the rAF loop alive as long as the canvas is mounted; analyser may
  // connect after the loop starts (UI renders before mic permission resolves).
  if (!canvasEl) return;

  frameCount++;

  // Only push a new sample every N frames → slower scroll
  if (analyser && frameCount % FRAMES_PER_SAMPLE === 0) {
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(data);

    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);
    waveHistory[wavePos % WAVE_DOTS] = rms;
    wavePos++;
  }

  const rect = canvasEl.getBoundingClientRect();
  if (rect.width > 0 && canvasEl.width !== Math.round(rect.width)) {
    canvasEl.width = Math.round(rect.width);
  }

  const ctx = canvasEl.getContext('2d');
  const w = canvasEl.width;
  const h = canvasEl.height;
  ctx.clearRect(0, 0, w, h);

  const dotSpacing = w / WAVE_DOTS;
  const style = getComputedStyle(document.documentElement);
  const color = style.getPropertyValue('--primary').trim() || '#6b8f5e';

  for (let i = 0; i < WAVE_DOTS; i++) {
    const idx = (wavePos + i) % WAVE_DOTS;
    const amp = waveHistory[idx];
    const barH = Math.max(2, amp * h * 4);
    const x = i * dotSpacing + dotSpacing / 2;
    const y = (h - barH) / 2;

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x - 1.5, y, 3, barH, 1.5);
    ctx.fill();
  }

  animFrame = requestAnimationFrame(drawWaveform);
}
