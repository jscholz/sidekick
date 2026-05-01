/**
 * @fileoverview iOS-specific pocket-lock overlay.
 * No desktop equivalent — pocket-dial / shake-to-undo issues are iOS-only.
 *
 * Full-screen cover that eats touches so pocket-dials can't send messages
 * / toggle streams. Unlocked by sliding the thumb left→right. The tab
 * stays foreground so all the iOS mic/TTS/barge-in paths keep working
 * (none of the backgrounded-PWA restrictions apply).
 */

import { log } from '../util/log.ts';
import * as audioPlatform from '../audio/platform.ts';
import * as webrtc from '../pipelines/webrtc/connection.ts';
// Classic pipeline gone: getActiveStream + tts imports removed. Pocket-lock
// keeps the cover overlay + status text + idle meter; per-turn player UI
// is hidden via display:none in CSS while the WebRTC call surface owns
// playback state on the lock screen via the iOS native call UI.

const DIM_MS = 10000;
const UNLOCK_THRESHOLD = 0.85;

let overlayEl = null;
let thumbEl = null;
let trackEl = null;
let stateEl = null;
let timeEl = null;
let canvasEl = null;
let playerEl = null;
let playerBar = null;
let playerLoadedEl = null;
let playerPlayedEl = null;
let playerPlayBtn = null;
let playerPrevBtn = null;
let playerReplayBtn = null;
let playerNextBtn = null;

/** Callbacks for the lock-screen prev/next buttons, set from main.ts so
 *  fakeLock doesn't need to know about the transcript DOM. */
let onPrevReply = () => {};
let onNextReply = () => {};

let active = false;
let dimTimer = null;
let statusTimer = null;

let analyser = null;
let animFrame = null;

/** @type {() => { listening: boolean, speaking: boolean, modelLabel: string }} */
let getStatus = () => ({ listening: false, speaking: false, modelLabel: '' });

/** Called from main.ts once on load, passing a status snapshot fn +
 *  callbacks for prev/next reply navigation.
 *  @param {{
 *    statusFn?: () => { listening: boolean, speaking: boolean, modelLabel: string },
 *    onPrev?: () => void,
 *    onNext?: () => void,
 *  }} [opts]
 */
export function init({ statusFn, onPrev, onNext }: {
  statusFn?: () => { listening: boolean; speaking: boolean; modelLabel: string };
  onPrev?: () => void;
  onNext?: () => void;
} = {}) {
  if (typeof statusFn === 'function') getStatus = statusFn;
  if (typeof onPrev === 'function') onPrevReply = onPrev;
  if (typeof onNext === 'function') onNextReply = onNext;
  overlayEl = document.getElementById('fake-lock');
  thumbEl = document.getElementById('fake-lock-thumb');
  trackEl = overlayEl?.querySelector('.fake-lock-track');
  stateEl = document.getElementById('fake-lock-state');
  timeEl = document.getElementById('fake-lock-time');
  canvasEl = document.getElementById('fake-lock-canvas') as HTMLCanvasElement | null;
  playerEl = document.getElementById('fake-lock-player');
  playerBar = playerEl?.querySelector('.fake-lock-player-bar');
  playerLoadedEl = playerEl?.querySelector('.fake-lock-player-loaded');
  playerPlayedEl = playerEl?.querySelector('.fake-lock-player-played');
  playerPlayBtn = document.getElementById('fake-lock-play');
  playerPrevBtn = document.getElementById('fake-lock-prev');
  playerReplayBtn = document.getElementById('fake-lock-replay');
  playerNextBtn = document.getElementById('fake-lock-next');
  if (!overlayEl || !thumbEl || !trackEl) { log('fake-lock: DOM missing'); return; }

  wireSwipe();
  wirePlayerControls();

  // Any touch/click on the overlay brightens it if dimmed.
  const wake = () => { if (active) { overlayEl.classList.remove('dim'); scheduleDim(); } };
  overlayEl.addEventListener('touchstart', wake, { passive: true });
  overlayEl.addEventListener('click', wake);
  overlayEl.addEventListener('mousemove', wake);
}

function wirePlayerControls() {
  // Per-turn replay gutted: no buttons to wire. Lock-screen player UI
  // stays hidden via .fake-lock-player without the .active class.
}

export function isActive() { return active; }

export function show() {
  if (active || !overlayEl) return;
  // Blur any focused input (composer, draft, settings) before locking.
  // iOS tracks "recently edited" state to decide whether shake-to-undo
  // shows; any text input still focused while pocket-locked means
  // motion from walking/pocket jostling triggers the "Undo Typing"
  // system alert, which then cuts audio playback. Blurring closes out
  // that state before lock takes over.
  try {
    const a = document.activeElement as HTMLElement | null;
    if (a && a !== document.body && typeof a.blur === 'function') a.blur();
  } catch {}
  active = true;
  overlayEl.classList.remove('hidden');
  overlayEl.classList.remove('dim');
  overlayEl.setAttribute('aria-hidden', 'false');
  // Body class lets CSS disable text-selection app-wide while locked
  // (the loupe + "Undo Typing" alerts that fire from accidental
  // long-presses through pocket / on-bike). Behavior cleared in hide().
  document.body.classList.add('fake-lock-engaged');
  updateTime();
  tickStatus();
  statusTimer = setInterval(() => { updateTime(); tickStatus(); }, 1000);
  startMeter();
  scheduleDim();
  log('fake-lock: shown');
}

export function hide() {
  if (!active || !overlayEl) return;
  active = false;
  overlayEl.classList.add('hidden');
  overlayEl.classList.remove('dim');
  overlayEl.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('fake-lock-engaged');
  if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
  if (dimTimer) { clearTimeout(dimTimer); dimTimer = null; }
  stopMeter();
  // Reset thumb
  if (thumbEl) thumbEl.style.transform = '';
  log('fake-lock: hidden');
}

function wireSwipe() {
  let startX = 0;
  let dragging = false;
  let trackWidth = 0;
  let maxDx = 0;

  const getX = (e) => (e.touches?.[0]?.clientX ?? e.clientX ?? 0);

  const onStart = (e) => {
    e.preventDefault();
    startX = getX(e);
    dragging = true;
    trackWidth = trackEl.clientWidth;
    maxDx = trackWidth - thumbEl.clientWidth - 8;  // 4px padding * 2
    thumbEl.classList.add('dragging');
  };
  const onMove = (e) => {
    if (!dragging) return;
    const dx = Math.max(0, Math.min(maxDx, getX(e) - startX));
    thumbEl.style.transform = `translateX(${dx}px)`;
    // Brighten while dragging
    overlayEl.classList.remove('dim');
    if (dx / maxDx > UNLOCK_THRESHOLD) {
      dragging = false;
      thumbEl.classList.remove('dragging');
      hide();
    }
  };
  const onEnd = () => {
    if (!dragging) return;
    dragging = false;
    thumbEl.classList.remove('dragging');
    thumbEl.style.transform = '';  // snap back
    scheduleDim();
  };

  // Hit target is the whole track (not just the thumb) — matches iOS
  // slide-to-unlock UX where you can pick up the drag anywhere along
  // the row and the thumb follows your delta. dx is computed from
  // startX at touchstart so the thumb doesn't snap to your finger;
  // it just moves by the distance you drag.
  trackEl.addEventListener('touchstart', onStart, { passive: false });
  trackEl.addEventListener('mousedown', onStart);
  window.addEventListener('touchmove', onMove, { passive: true });
  window.addEventListener('mousemove', onMove);
  window.addEventListener('touchend', onEnd);
  window.addEventListener('touchcancel', onEnd);
  window.addEventListener('mouseup', onEnd);
}

function scheduleDim() {
  if (dimTimer) clearTimeout(dimTimer);
  dimTimer = setTimeout(() => {
    if (active && overlayEl) overlayEl.classList.add('dim');
  }, DIM_MS);
}

function updateTime() {
  if (!timeEl) return;
  const d = new Date();
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  timeEl.textContent = `${hh}:${mm}`;
}

function tickStatus() {
  if (!stateEl) return;
  const s = getStatus();
  let txt;
  if (s.speaking) txt = '▷ Speaking';
  else if (s.listening) txt = '● Listening';
  else txt = '○ Idle';
  if (s.modelLabel) txt += `  ·  ${s.modelLabel}`;
  stateEl.textContent = txt;
}

// ── Mic meter ────────────────────────────────────────────────────────
/** Polling token for the call-pending wait — cancelled when the
 *  overlay closes so we don't keep hunting for a mic stream that
 *  was never opened. */
let micPollHandle: ReturnType<typeof setTimeout> | null = null;

function startMeter() {
  if (analyser || !canvasEl) return;
  // Pull the live mic stream from the WebRTC peer. When pocket-lock
  // opens before a call is connected, the stream is null — poll a
  // few times so a call started AFTER lock still gets metering.
  // Idle pattern is the visual fallback while polling.
  drawIdle();
  attachMicAnalyserWhenReady(0);
}

/** Try to grab the WebRTC mic stream + wire an analyser. Polls
 *  every 250ms up to ~30s — covers the "user opens pocket-lock then
 *  starts a call" path. Long window because on iOS the user may lock
 *  first and call later.
 *
 *  Refactored 2026-05-01 (Phase 2.2): all the iOS-specific quirks
 *  (suspended-context resume, fallback meterCtx, route-stale handling)
 *  moved into `audioPlatform.getMicAnalyser()`. fakeLock owns ONLY the
 *  polling loop + the visual meter — the audio quirks are platform's
 *  job. Future iOS fixes land in `src/audio/platform.ts:getMicAnalyser`,
 *  not here. */
function attachMicAnalyserWhenReady(attempt: number): void {
  if (!active || !canvasEl || analyser) return;
  const stream = webrtc.getMicStream();
  log(`[fakeLock] meter probe attempt=${attempt} stream=${stream ? 'present' : 'null'} tracks=${stream ? stream.getAudioTracks().length : 0}`);
  if (stream && stream.getAudioTracks().length > 0) {
    const a = audioPlatform.getMicAnalyser(stream, 256);
    if (a) {
      analyser = a;
      log('[fakeLock] mic meter wired via audioPlatform.getMicAnalyser');
      animFrame = requestAnimationFrame(drawMeter);
      return;
    }
    // Platform couldn't produce an analyser (no shared ctx, or
    // platform-specific stream-exclusivity issue). Fall through to
    // the polling loop — context may become available shortly (e.g.
    // user about to tap something that primes audio).
    log('[fakeLock] meter probe got stream but platform returned no analyser; polling');
  }
  if (attempt >= 120) return;  // ~30s of polling at 250ms cadence
  micPollHandle = setTimeout(() => {
    micPollHandle = null;
    attachMicAnalyserWhenReady(attempt + 1);
  }, 250);
}

function stopMeter() {
  if (micPollHandle) { clearTimeout(micPollHandle); micPollHandle = null; }
  if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
  // Disconnect the analyser. The upstream MediaStreamSource node is
  // owned by audioPlatform.getMicAnalyser; disconnecting the analyser
  // here is enough — the source has no other consumers and will be
  // GC'd when its strong ref (the closure inside getMicAnalyser) is
  // released. Future revision could expose a release callback if the
  // platform shim starts tracking source-node lifetimes.
  if (analyser) { try { analyser.disconnect(); } catch {} analyser = null; }
}

const BARS = 32;
const waveHistory = new Float32Array(BARS);
let wavePos = 0;
let frameCount = 0;
const FRAMES_PER_SAMPLE = 3;

function drawMeter() {
  if (!active || !analyser || !canvasEl) return;

  const rect = canvasEl.getBoundingClientRect();
  if (rect.width > 0 && canvasEl.width !== Math.round(rect.width * 2)) {
    canvasEl.width = Math.round(rect.width * 2);
    canvasEl.height = Math.round(rect.height * 2);
  }

  frameCount++;
  if (frameCount % FRAMES_PER_SAMPLE === 0) {
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
    waveHistory[wavePos % BARS] = Math.sqrt(sum / data.length);
    wavePos++;
  }

  const ctx2 = canvasEl.getContext('2d');
  if (!ctx2) return;
  const w = canvasEl.width, h = canvasEl.height;
  ctx2.clearRect(0, 0, w, h);
  const dotSpacing = w / BARS;
  ctx2.fillStyle = 'rgba(255,255,255,0.72)';
  for (let i = 0; i < BARS; i++) {
    const idx = (wavePos + i) % BARS;
    const amp = waveHistory[idx];
    const barH = Math.max(4, amp * h * 4);
    const x = i * dotSpacing + dotSpacing / 2;
    const y = (h - barH) / 2;
    ctx2.beginPath();
    ctx2.roundRect(x - 3, y, 6, barH, 3);
    ctx2.fill();
  }
  animFrame = requestAnimationFrame(drawMeter);
}

function drawIdle() {
  if (!canvasEl) return;
  const rect = canvasEl.getBoundingClientRect();
  if (rect.width > 0 && canvasEl.width !== Math.round(rect.width * 2)) {
    canvasEl.width = Math.round(rect.width * 2);
    canvasEl.height = Math.round(rect.height * 2);
  }
  const ctx2 = canvasEl.getContext('2d');
  if (!ctx2) return;
  const w = canvasEl.width, h = canvasEl.height;
  ctx2.clearRect(0, 0, w, h);
  ctx2.fillStyle = 'rgba(255,255,255,0.25)';
  const y = h / 2 - 2;
  ctx2.fillRect(w * 0.1, y, w * 0.8, 4);
}
