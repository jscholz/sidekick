/**
 * @fileoverview Listen — turn-based handsfree mic mode. Two body-
 * transcription paths, gated by the `streamingEngine` setting:
 *
 *   - SERVER (`streamingEngine: 'server'`, the default) — record locally
 *     with MediaRecorder, run Web Speech API for sendword detection in
 *     parallel, and on commit ship the FULL buffered blob to
 *     /v1/transcribe (via /transcribe). Caller's `onCommit(blob, reason)`
 *     fires.
 *
 *   - LOCAL (`streamingEngine: 'local'`) — no blob, no /transcribe.
 *     Open a `BrowserSttProvider` (Web Speech API) and accumulate its
 *     transcript events into the turn's body text. Sendword detector
 *     subscribes to the SAME provider via the new external-source API
 *     so we run a single SR session per turn instead of two racing for
 *     the mic. On commit, caller's `onCommitText(text, reason)` fires.
 *
 * Reply renders + plays through the existing playReplyTts path
 * (caller-owned). After audio.ended + a small grace window, re-arms for
 * the next turn.
 *
 * Listen is wiring on top of existing primitives, NOT a new pipeline.
 * WebRTC (talk + stream) stays untouched — Listen lives alongside.
 *
 * State machine:
 *   idle       — start() not yet called or stop() returned.
 *   armed      — recording (server) or live-transcribing (local),
 *                watching for silence + sendword.
 *   committing — silence/sendword fired; awaiting onCommit/onCommitText.
 *   playing    — caller invoked notifyReplyPlayback(true); waiting
 *                for notifyReplyPlayback(false) → grace → re-arm.
 *
 * Disarm: mic-button tap or menu-toggle off, both wired through stop().
 *
 * Test hooks: when ?listen_mock_mic=1 is set on the URL, the module
 * exposes window.__listen.{state, injectSilence, injectSpeech} so the
 * Playwright smoke can drive synthetic frames into the silence detector
 * without a real getUserMedia stream.
 */

import { log, diag } from '../../util/log.ts';
import * as audioPlatform from '../shared/platform.ts';
import * as settings from '../../settings.ts';
import { playFeedback } from '../shared/feedback.ts';
import * as sendwordDetector from './sendwordDetector.ts';
import { SilenceWindow, getHandsfreeConfig } from '../shared/handsfree.ts';
import { BargeDetector } from '../shared/bargeDetector.ts';
import { getBargeThreshold, getBargeDetectorTuning } from '../../voiceTuning.ts';
import * as recorderBar from '../shared/recorderBar.ts';
import { BrowserSTTProvider, isSupported as isBrowserSttSupported } from '../streaming/browserDictate.ts';
import type { STTProvider, TranscriptEvent } from '../shared/stt-provider.ts';

export type ListenState = 'idle' | 'armed' | 'committing' | 'playing' | 'cooldown';

export type ListenOpts = {
  /** Called when a turn commits (silence elapsed or sendword detected).
   *  Receives the recorded audio blob; caller is responsible for posting
   *  it to /transcribe and rendering the reply. The caller MUST drive
   *  notifyReplyPlayback(true/false) around TTS playback so Listen knows
   *  when to re-arm. Returning a rejected promise leaves Listen in the
   *  cooldown → armed transition (best-effort recovery). */
  /** `reason` lets the caller know whether this turn ended via the
   *  silence timeout or because the sendword fired. Only the latter
   *  needs the trailing sendword stripped from the transcript before
   *  rendering. Defaults to 'silence' for callers that don't care.
   *  'barge' = user spoke during TTS playback to interrupt; the
   *  caller should cancel any in-flight TTS before invoking
   *  notifyReplyPlayback(false) so Listen re-arms cleanly. */
  onCommit: (blob: Blob, reason?: 'silence' | 'sendword' | 'barge') => Promise<void> | void;
  /** Called when a turn commits in LOCAL streaming-engine mode. The
   *  body transcription has already happened in-browser via Web Speech
   *  — caller just needs to render+submit the supplied `text`. Empty
   *  text means the user said nothing transcribable; caller should
   *  skip the send (Listen will re-arm directly). When set, this
   *  REPLACES `onCommit` — the two paths are mutually exclusive per
   *  turn (the engine setting determines which fires). When omitted,
   *  local mode silently degrades to the server path. */
  onCommitText?: (text: string, reason?: 'silence' | 'sendword' | 'barge') => Promise<void> | void;
  /** Optional: fired when barge detection triggers during TTS playback.
   *  Caller should cancel its TTS playback (text-tts.cancelReplyTts) and
   *  immediately call notifyReplyPlayback(false) so Listen drops the
   *  current "playing" state and re-arms. The very next user utterance
   *  starts a fresh recording with no committed blob (the barge IS the
   *  signal — we don't ship the bleed-into-mic audio as a turn). */
  onBarge?: () => void;
  /** Called when the trash button is tapped or stop() is invoked while
   *  armed without a commit. UI should clear the listening indicator. */
  onCancel?: () => void;
  /** Optional hook fired on each state transition. Useful for the
   *  status-line indicator + button class wiring in main.ts. */
  onState?: (s: ListenState) => void;
  /** Container element to mount the visual recorder bar (waveform +
   *  trash button) into. Pass the composer element. When omitted, no
   *  bar mounts (smoke tests, headless contexts). */
  barContainer?: HTMLElement | null;
  /** Optional sibling to insertBefore inside `barContainer` — same
   *  semantics as memo.start (drops the bar in front of the composer
   *  actions row). */
  barInsertBefore?: HTMLElement | null;
  /** Optional element to relocate INTO the bar's right-end slot.
   *  Memo uses this to embed the send button; Listen uses it to embed
   *  the mic button (so the user has a visible "end call" affordance
   *  in the same physical spot). Caller is responsible for restoring
   *  the element to its original parent on teardown — the bar's
   *  destroy() doesn't track where it came from. */
  barRightBtn?: HTMLElement | null;
};

const REARM_GRACE_MS = 500;
const SILENCE_WARMUP_MS = 500;
const SILENCE_FRAME_MS = 50;

let state: ListenState = 'idle';
let opts: ListenOpts | null = null;
let mediaStream: MediaStream | null = null;
let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];
let analyser: AnalyserNode | null = null;
let silenceLoop: ReturnType<typeof setInterval> | null = null;
let bargeDetector: BargeDetector | null = null;
let armedAt = 0;
let silenceWindow: SilenceWindow | null = null;
let mockFrames: { type: 'silence' | 'speech'; remainingMs: number } | null = null;
let cooldownTimer: ReturnType<typeof setTimeout> | null = null;
// Visual recorder bar (waveform + trash button). Mounted on start(),
// destroyed on teardown. Analyser is attached only while state==='armed'
// — frozen waveform during commit/playing/cooldown so the user never
// sees a live waveform that misrepresents whether audio is being
// captured for transcription.
let bar: recorderBar.RecorderBar | null = null;
// LOCAL engine (streamingEngine='local') turn-state. The active
// BrowserSttProvider for in-browser body transcription, the running
// transcript accumulators, and the unsubscribe handle for our transcript
// listener. Null on every server-engine turn.
//   localBufferedText — accumulated across utterances within this turn
//     (one final's worth of text appended per utterance boundary).
//   localBestInterim  — longest text seen DURING the current utterance.
//     Web Speech sometimes commits a phrase like "test test test over"
//     as a single final whose recognized text is just "over" (low
//     confidence on the leading words → engine drops them). The longest
//     interim we saw before that final is the engine's earlier guess
//     for the same audio; we prefer whichever of (final, best-interim)
//     is longer at utterance boundary.
let localProvider: STTProvider | null = null;
let localBufferedText = '';
let localBestInterim = '';
let localUnsub: (() => void) | null = null;
/** True when the current turn was armed against the local provider —
 *  determines whether commit harvests text vs blob. Captured at arm
 *  time so a mid-turn settings flip doesn't rip the floor out from
 *  under commitNow. */
let armedWithLocal = false;
/** Start sendword detection, choosing the transcript source:
 *   - LOCAL engine: FED from the BrowserSttProvider already running for
 *     body transcription (one shared SR session).
 *   - Otherwise (server engine, CAP included): the detector opens its own
 *     standalone Web Speech session. `webkitSpeechRecognition` exists in
 *     WKWebView and works there — a native SFSpeechRecognizer bridge was
 *     built on the assumption it didn't, was never registered so never
 *     ran, and was deleted 2026-09-06 once the standalone path was
 *     confirmed working on device (he'd been using it for months).
 */
function startSendword(phrase: string): void {
  const fedFromLocal = armedWithLocal && !!localProvider;
  sendwordDetector.start({
    phrase,
    onMatch: () => commitFromSendword(),
    feed: fedFromLocal,
  });
}

/** External read of the current state. */
export function getState(): ListenState { return state; }

/** Notify Listen that reply playback started/ended. The PWA's reply
 *  pipeline owns the audio element; Listen just observes. While
 *  playing, the mic stays open but silence/sendword detection is
 *  paused (no barge logic — settled decision). */
export function notifyReplyPlayback(playing: boolean): void {
  if (playing) {
    // Accept 'cooldown' as a valid source: commitNow flips to cooldown
    // immediately after onCommit returns (line ~621) if the caller
    // hasn't yet moved us to 'playing'. When backend.sendMessage's POST
    // resolves before the reply envelopes land (mock-backend, or any
    // fast real backend), the cooldown transition happens BEFORE the
    // TTS pipeline gets a chance to fire play-start. Without this,
    // notifyReplyPlayback(true) becomes a no-op, the agent's TTS plays
    // un-tracked, audio.ended → notifyReplyPlayback(false) is also a
    // no-op (state !== 'playing'), and the post-commit cooldownTimer
    // re-arms WHILE the agent is still talking. Reproduced in:
    // listen-silence-commit smoke times out waiting for re-arm because
    // the cooldownTimer fires armRecorder() against a torn-down mic
    // capture → teardown → idle.
    if (state === 'committing' || state === 'armed' || state === 'playing' || state === 'cooldown') {
      // Pull back to 'playing' and CANCEL the pending re-arm — the TTS
      // is actually playing now, the cooldown→armed timer fires the
      // ended-path handler below.
      if (cooldownTimer) { clearTimeout(cooldownTimer); cooldownTimer = null; }
      transition('playing');
      // Pause the sendword detector during TTS — the user's mic would
      // otherwise pick up the agent's voice and trip a false match.
      try { sendwordDetector.stop(); } catch { /* noop */ }
      // Start barge detection. The mic stream stays open through TTS
      // (per design); we now actively listen for sustained user voice
      // above the threshold during playback. Fire → caller cancels TTS
      // and re-arms (via the onBarge callback). Browser AEC + the
      // 500ms warmup mute handle most speakerphone bleed; classic ran
      // this same algorithm reliably on a Pi for months.
      startBargeLoop();
    }
    return;
  }
  // Stopping playback path — clear the barge loop regardless of how
  // we got here (natural reply end, barge fire, user cancel).
  stopBargeLoop();
  if (state === 'playing') {
    // Grace window before re-arming so the audio tail and any trailing
    // events (audio.onended → next event-loop tick) settle.
    transition('cooldown');
    if (cooldownTimer) clearTimeout(cooldownTimer);
    cooldownTimer = setTimeout(() => {
      cooldownTimer = null;
      if (getState() !== 'cooldown') return;
      // Re-arm by rebuilding the recorder. The mic stream is still
      // alive; we just need a fresh blob accumulator. armRecorder()
      // also restarts the sendword detector.
      armRecorder().then(() => {
        // Listening chime on re-arm too, not just on initial start.
        // Without this the user has no audible cue that "your turn
        // again, mic is hot." Critical when running handsfree (eyes
        // off the screen — the original ask was "I'm flying blind").
        try { playFeedback('listening'); } catch { /* noop */ }
      }).catch((e) => {
        diag('listen: re-arm failed', e?.message);
        // Fall back to idle; caller can re-tap to retry.
        teardown();
      });
    }, REARM_GRACE_MS);
  }
}

/** Start arming Listen. Acquires the mic, builds analyser + recorder,
 *  starts the silence loop. Idempotent: if already non-idle, returns
 *  the current state. */
export async function start(o: ListenOpts): Promise<boolean> {
  if (state !== 'idle') return true;
  opts = o;
  // Phase timing — turn-based mirror of realtime's [webrtc-timing].
  // Everything here is local (no signaling), so the only expected real
  // cost is the mic grant; these lines prove/disprove that on device.
  const startT0 = performance.now();
  let phaseT = startT0;
  const phase = (label: string) => {
    const now = performance.now();
    log(`[listen-timing] ${label} +${Math.round(now - phaseT)}ms (total ${Math.round(now - startT0)}ms)`);
    phaseT = now;
  };
  // Reuse the shared AudioContext primed by the caller's gesture.
  const ctx = audioPlatform.getSharedAudioCtx();
  if (!ctx) {
    log('listen: no shared AudioContext — was primeAudio() skipped?');
    return false;
  }
  if (ctx.state !== 'running') {
    try { await ctx.resume(); } catch { /* ignore */ }
  }
  phase('ctx');
  try {
    // Match realtime talk's DSP triple (echoCancellation=true, NS+AGC=false).
    // Pairs with the TTS-via-Web-
    // Audio routing experiment in tts.ts: by routing player output
    // through the same AudioContext as the mic, we hope Chrome's AEC
    // engages on the speaker bleed. AEC alone should be enough — NS+AGC
    // ON would shape the signal in ways that defeat Silero on real
    // user voice during double-talk.
    mediaStream = await audioPlatform.getMicStream('listen', {
      echoCancellation: true, noiseSuppression: false, autoGainControl: false,
    });
  } catch (e: any) {
    log('listen: mic error:', e?.message);
    teardown();
    return false;
  }
  phase('mic');
  // Audio-session diag: confirms
  // the prime ran (track label after prime should resemble BT when one
  // is connected; iPhone Mic when not) and the route is settled.
  // v0.444 enumerate-and-swap code was dropped: enumerateDevices on
  // cold-start iOS PWA only returns iPhone Microphone — BT is not
  // exposed at that point. The actual fix is the audio-session prime
  // in ios-specific.ts:primeIOSAudioSession (called from
  // prepareForCapture). Remove this log line once the prime is
  // verified to eliminate call-1 routing flatlines.
  try {
    const t = mediaStream?.getAudioTracks?.()[0];
    log(`[audio-session-debug] listen track: label="${t?.label || '?'}" enabled=${t?.enabled} muted=${t?.muted} readyState=${t?.readyState}`);
  } catch (e: any) { log('[audio-session-debug] track inspect threw:', e?.message); }
  analyser = audioPlatform.getMicAnalyser(mediaStream, 256);
  if (!analyser) {
    log('listen: analyser unavailable — silence detection disabled');
  }
  ensureVisibilityHandler();
  // Mount the visual recorder bar (waveform + trash). Same module memo
  // uses; analyser gets attached/detached as state moves in/out of
  // 'armed' so the waveform is honest about when audio is being captured
  // for transcription. Skipped when no container — smoke tests, headless.
  if (o.barContainer) {
    bar = recorderBar.mount({
      container: o.barContainer,
      insertBefore: o.barInsertBefore || null,
      // Right-slot button — caller passes the mic button (Listen) so
      // the user has a visible "end call" affordance at the bar's
      // right end. Memo passes its send button; same DOM slot.
      sendBtn: o.barRightBtn || null,
      onCancel: () => {
        // Trash button = disarm. cancel() runs teardown which destroys
        // the bar, so the click handler doesn't need to do that itself.
        cancel();
      },
    });
  }
  await armRecorder();
  phase('recorder-armed');
  // "Listening" chime — same audible cue memo uses, so the user gets a
  // consistent "we're hearing you" signal across the two modes.
  try { playFeedback('listening'); } catch { /* noop */ }
  phase('chime');
  installTestHooksIfRequested();
  return true;
}

/** Visibility-change handler — pause sendword detection when the tab
 *  goes to the background. Web Speech API is unreliable while hidden
 *  on iOS Safari (sessions get killed silently, restart loop fails);
 *  on resume we re-arm the detector if Listen is still active. The
 *  silence loop keeps running so a memo recorded while pocketed still
 *  commits — only sendword pauses. */
let visibilityHandlerInstalled = false;
function ensureVisibilityHandler(): void {
  if (visibilityHandlerInstalled) return;
  if (typeof document === 'undefined') return;
  visibilityHandlerInstalled = true;
  document.addEventListener('visibilitychange', () => {
    if (state !== 'armed' && state !== 'committing') return;
    if (document.visibilityState === 'hidden') {
      try { sendwordDetector.stop(); } catch { /* noop */ }
    } else {
      // Re-arm sendword on resume if we're still in armed state.
      if (state === 'armed') {
        const engine = (settings.get() as any).listenSttEngine || 'local';
        const { sendwordPhrase } = getHandsfreeConfig();
        if (sendwordPhrase && engine !== 'silence-only') {
          startSendword(sendwordPhrase);
        }
      }
    }
  });
}

async function armRecorder(): Promise<void> {
  if (!mediaStream) {
    teardown();
    return;
  }
  // Engine selection — `streamingEngine: 'local'` opts out of the
  // MediaRecorder → /transcribe path entirely. Body transcription runs
  // in-browser via Web Speech (BrowserSttProvider). Caller's
  // onCommitText receives the accumulated transcript at commit time.
  // We require BOTH the setting AND a working SR ctor AND a caller
  // that supplied onCommitText — any missing piece falls through to
  // the server path so the user still gets a working Listen mode
  // (e.g. Firefox without WebSpeech, or a caller that hasn't been
  // updated to handle local mode).
  const useLocal = (settings.get() as any).streamingEngine === 'local'
    && isBrowserSttSupported()
    && typeof opts?.onCommitText === 'function';
  armedWithLocal = useLocal;

  // Tear down any provider/recorder from a prior turn. We rebuild fresh
  // each arm so a stop()/arm() cycle starts cleanly (Chromium leaks
  // state across MediaRecorder instances → corrupt webm; SR sessions
  // benefit from the same hygiene).
  await teardownLocalProvider();
  if (mediaRecorder) {
    try { mediaRecorder.ondataavailable = null; } catch { /* noop */ }
    try { mediaRecorder.onstop = null; } catch { /* noop */ }
    mediaRecorder = null;
  }
  audioChunks = [];

  if (useLocal) {
    // LOCAL path — Web Speech provider for body transcription.
    // No MediaRecorder, no blob. The mic stream stays open (analyser
    // still drives the silence/barge loops); BrowserSttProvider opens
    // its own SR session against the OS-default mic, which on iOS +
    // Chrome shares the same source as the mediaStream we already
    // hold. The redundant getUserMedia call inside SR is the platform
    // contract we accept.
    localBufferedText = '';
    localBestInterim = '';
    localProvider = new BrowserSTTProvider();
    try {
      localUnsub = localProvider.onTranscript((ev: TranscriptEvent) => {
        if (ev.role !== 'user') return;
        // (1) Body accumulation
        if (ev.is_final) {
          // Empty-text finals are the synthetic utterance-end sentinel
          // BrowserSttProvider emits on `onend`. They carry no text;
          // the longest interim still applies as the utterance.
          // Otherwise pick whichever of (final, best-interim) is longer
          // — see localBestInterim docstring for the Web Speech case
          // where a final truncates a longer interim.
          const utterance = ev.text.length >= localBestInterim.length
            ? ev.text
            : localBestInterim;
          if (utterance) {
            localBufferedText = (localBufferedText + ' ' + utterance).trim();
          }
          localBestInterim = '';
        } else if (ev.text.length > localBestInterim.length) {
          localBestInterim = ev.text;
        }
        // (2) Sendword matching (FED mode — same listener does both,
        // since STTProvider only supports one onTranscript subscriber).
        sendwordDetector.feedTranscript(ev);
      });
      await localProvider.start();
    } catch (e: any) {
      diag('listen: local provider start failed, falling back to server', e?.message);
      await teardownLocalProvider();
      armedWithLocal = false;
    }
  }

  if (!armedWithLocal) {
    // SERVER path — MediaRecorder buffers a blob for /transcribe.
    // Cap the audio bitrate at 24 kbps. Speech-to-text (Deepgram /
    // Whisper) transcribes low-bitrate audio fine, and the default
    // MediaRecorder bitrate (~216 kbps default) makes multi-minute memos ~10x larger than they need
    // to be — a 92s memo shrank from 2.5MB to ~250KB, cutting park-
    // bench 5G upload time from 22s to ~2s. Works on iOS Safari (AAC)
    // and Chrome (Opus).
    try {
      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 24000 });
    } catch {
      mediaRecorder = new MediaRecorder(mediaStream, { audioBitsPerSecond: 24000 });
    }
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
    // No timeslice — `start()` writes the complete webm container
    // (EBML header + segment + cluster + duration) to a single blob
    // on stop(). With timeslice, Chromium fragments the file into
    // segments that concatenate cleanly only on the FIRST recorder
    // instance per MediaStream lifetime; the second recorder's
    // segments produce a malformed container that Deepgram rejects.
    mediaRecorder.start();
  }

  armedAt = Date.now();
  // Initialise the silence window from current handsfree config.
  // tickSilence reads expired() each frame; setThreshold lets a live
  // settings flip propagate without us having to subscribe.
  const cfg = getHandsfreeConfig();
  silenceWindow = new SilenceWindow(cfg.silenceSec, armedAt);
  startSilenceLoop();
  // Sendword detector. Two source modes:
  //   - LOCAL engine: subscribe to the same BrowserSttProvider we just
  //     started for body transcription. One SR session per turn,
  //     shared event stream — no second instance racing for the mic.
  //   - SERVER engine: open a standalone SR session inside the
  //     detector (the original v0.397 path). The MediaRecorder blob
  //     doesn't expose realtime text, so we have no source to share.
  // listenSttEngine='silence-only' opts out of sendword detection in
  // both paths (the user-facing kill switch — separate from
  // streamingEngine which controls body transcription).
  const sendwordEngine = (settings.get() as any).listenSttEngine || 'local';
  diag(`[turnbased] sendword config: phrase="${cfg.sendwordPhrase}" engine=${sendwordEngine} streamingEngine=${(settings.get() as any).streamingEngine} armedWithLocal=${armedWithLocal} localProvider=${!!localProvider}`);
  if (cfg.sendwordPhrase && sendwordEngine !== 'silence-only') {
    // Source selection lives in startSendword: FED from the local
    // provider, or a standalone Web Speech session everywhere else
    // (CAP included).
    startSendword(cfg.sendwordPhrase);
  } else {
    diag(`[turnbased] sendword skipped: phrase=${!!cfg.sendwordPhrase} engine=${sendwordEngine}`);
  }
  transition('armed');
}

/** Stop + release the BrowserSttProvider, drop the transcript listener.
 *  Idempotent. Safe to call from the server-engine path (no-op when
 *  the provider was never created). */
async function teardownLocalProvider(): Promise<void> {
  if (localUnsub) {
    try { localUnsub(); } catch { /* noop */ }
    localUnsub = null;
  }
  if (localProvider) {
    try { await localProvider.stop(); } catch { /* noop */ }
    localProvider = null;
  }
}

function startSilenceLoop(): void {
  if (silenceLoop) clearInterval(silenceLoop);
  silenceLoop = setInterval(tickSilence, SILENCE_FRAME_MS);
}

function stopSilenceLoop(): void {
  if (silenceLoop) { clearInterval(silenceLoop); silenceLoop = null; }
}

function startBargeLoop(): void {
  if (!mediaStream) return;
  stopBargeLoop();
  const _settings: any = settings.get();
  if (!_settings.bargeIn) {
    log('[turnbased-barge] skipped — barge disabled');
    return;
  }
  const threshold = typeof _settings.bargeVadThreshold === 'number' ? _settings.bargeVadThreshold : 0.5;
  // Device anti-echo tuning (iOS: warmup + minPeak gate). Omitting this
  // let speaker TTS self-barge through the bare detector (2026-06-10).
  const tuning = getBargeDetectorTuning();
  bargeDetector = new BargeDetector();
  void bargeDetector.start({
    micStream: mediaStream,
    isPlayingCb: () => state === 'playing',
    isEnabledCb: () => !!(settings.get() as any).bargeIn,
    onFire: () => { try { opts?.onBarge?.(); } catch (e: any) { diag('listen: onBarge threw', e?.message); } },
    positiveSpeechThreshold: threshold,
    ...tuning,
  });
  log('[turnbased-barge] started',
    `warmupMs=${tuning.warmupMs ?? 'default'}`,
    `minSpeechMs=${tuning.minSpeechMs ?? 'default'}`,
    `minPeak=${tuning.minPeak ?? 'none'}`);
}

function stopBargeLoop(): void {
  if (bargeDetector) {
    void bargeDetector.stop();
    bargeDetector = null;
  }
}

/** One frame of silence detection. Reads peak from the analyser (or the
 *  injected mock-frame queue when a smoke test is driving us). The
 *  silenceWindow holds lastVoiceAt + threshold; when expired, fire
 *  commit. Threshold updates live via setThreshold so user changes
 *  propagate mid-session. */
function tickSilence(): void {
  if (state !== 'armed') return;
  if (!silenceWindow) return;
  const now = Date.now();
  if (now - armedAt < SILENCE_WARMUP_MS) {
    // Skip the warmup window so the "listening" chime + late mic
    // unmute don't get counted as silence.
    return;
  }

  // Re-read the threshold each frame so a settings flip takes effect
  // without us subscribing to the settings module.
  silenceWindow.setThreshold(getHandsfreeConfig().silenceSec);

  let isSpeech = false;
  if (mockFrames && mockFrames.remainingMs > 0) {
    isSpeech = mockFrames.type === 'speech';
    mockFrames.remainingMs -= SILENCE_FRAME_MS;
    if (mockFrames.remainingMs <= 0) mockFrames = null;
  } else if (analyser) {
    // Same device-aware threshold the barge loop uses — silence
    // detection has the same "is this speech or ambient?" question,
    // so the cutoff should match. Otherwise a mic that sits at 0.12
    // ambient on iOS BT would never trigger silence-end with a 0.10
    // global default.
    isSpeech = readPeak(analyser) > getBargeThreshold();
  }

  if (isSpeech) {
    silenceWindow.noteVoice(now);
    return;
  }
  if (silenceWindow.expired(now)) {
    void commitNow('silence');
  }
}

function readPeak(node: AnalyserNode): number {
  const data = new Uint8Array(node.frequencyBinCount);
  node.getByteTimeDomainData(data);
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const v = Math.abs((data[i] - 128) / 128);
    if (v > peak) peak = v;
  }
  return peak;
}

/** Internal: stop the recorder/provider, harvest the body (blob or
 *  text), fire onCommit/onCommitText per the active engine. */
async function commitNow(reason: 'silence' | 'sendword'): Promise<void> {
  if (state !== 'armed') return;
  transition('committing');
  clearSendwordCommitTimer();
  stopSilenceLoop();
  try { sendwordDetector.stop(); } catch { /* noop */ }
  // The 'commit' chime plays at DETECTION time in commitFromSendword
  // (before the commitDelaySec grace window), not here — by commit
  // time the user already got their feedback.

  if (armedWithLocal) {
    // LOCAL path — pull the accumulated transcript from the provider.
    // Stop the provider FIRST so any in-flight final landing during
    // teardown still appends to localBufferedText (the listener stays
    // active until teardownLocalProvider's unsub).
    // Concatenate buffered finals with the in-progress utterance's
    // longest interim — covers the silence-fired-before-final case
    // (Web Speech can hold a final until session end).
    const text = [localBufferedText, localBestInterim]
      .filter(Boolean).join(' ').trim();
    await teardownLocalProvider();
    log(`listen: commit (${reason}) text="${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"`);
    if (!text.trim()) {
      // Empty turn — re-arm directly without invoking the caller.
      armRecorder().catch(() => teardown());
      return;
    }
    try {
      const out = opts?.onCommitText?.(text.trim(), reason);
      if (out && typeof (out as Promise<void>).then === 'function') {
        await out;
      }
    } catch (e: any) {
      diag('listen: onCommitText threw', e?.message);
      armRecorder().catch(() => teardown());
      return;
    }
  } else {
    // SERVER path — harvest the MediaRecorder blob, ship to caller.
    const blob = await stopRecorder();
    log(`listen: commit (${reason}) blob=${blob ? blob.size : 0}b`);
    if (!blob || blob.size === 0) {
      // Empty blob — re-arm directly without invoking onCommit.
      armRecorder().catch(() => teardown());
      return;
    }
    try {
      const out = opts?.onCommit?.(blob, reason);
      if (out && typeof (out as Promise<void>).then === 'function') {
        await out;
      }
    } catch (e: any) {
      diag('listen: onCommit threw', e?.message);
      // Best-effort recovery — re-arm so the user isn't stranded.
      armRecorder().catch(() => teardown());
      return;
    }
  }
  // If the caller never moved us to 'playing' (e.g. the reply was
  // empty so playReplyTts skipped), re-arm directly after a grace.
  // Read via getState() so TS doesn't narrow on the literal we set above.
  if (getState() === 'committing') {
    transition('cooldown');
    if (cooldownTimer) clearTimeout(cooldownTimer);
    cooldownTimer = setTimeout(() => {
      cooldownTimer = null;
      if (getState() === 'cooldown') {
        armRecorder().catch(() => teardown());
      }
    }, REARM_GRACE_MS);
  }
}

async function stopRecorder(): Promise<Blob | null> {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return null;
  const mimeType = mediaRecorder.mimeType;
  await new Promise<void>((resolve) => {
    mediaRecorder!.onstop = () => resolve();
    try { mediaRecorder!.stop(); } catch { resolve(); }
    setTimeout(resolve, 1000);
  });
  if (audioChunks.length === 0) return null;
  return new Blob(audioChunks, { type: mimeType });
}

// Sendword grace window (commitDelaySec): the chime confirms detection
// immediately; the commit itself waits so a "…over — wait, also" keeps
// recording into the same turn. commitNow's state guard makes a timer
// that outlives the armed session a no-op; the explicit clears (here on
// re-fire, in commitNow, in teardown) keep it from firing into a NEW
// armed session after an empty-turn re-arm.
let sendwordCommitTimer: ReturnType<typeof setTimeout> | null = null;

function clearSendwordCommitTimer(): void {
  if (sendwordCommitTimer !== null) {
    clearTimeout(sendwordCommitTimer);
    sendwordCommitTimer = null;
  }
}

/** Commit via the sendword detector path. Chimes at detection, commits
 *  after the commitDelaySec grace window (0 = immediately). Safe to
 *  call only from state==='armed'; otherwise no-op. */
export function commitFromSendword(): void {
  if (state !== 'armed') return;
  // Immediate audio feedback the moment the sendword is detected, so a
  // bike-mode user knows their utterance was captured BEFORE the grace
  // window + /transcribe round-trip (which can take 10+s). Mirrors the
  // realtime path's chime in dictation.ts:handleUserFinal.
  try { playFeedback('commit'); } catch { /* feedback is best-effort */ }
  const { commitDelaySec } = getHandsfreeConfig();
  if (commitDelaySec <= 0) {
    void commitNow('sendword');
    return;
  }
  clearSendwordCommitTimer();
  sendwordCommitTimer = setTimeout(() => {
    sendwordCommitTimer = null;
    void commitNow('sendword');
  }, commitDelaySec * 1000);
}

/** Cancel without committing (trash button, mic-button-off). Releases
 *  the mic and resets state to idle. */
export function cancel(): void {
  const wasArmed = state !== 'idle';
  teardown();
  if (wasArmed && opts?.onCancel) {
    try { opts.onCancel(); } catch { /* noop */ }
  }
}

/** Stop and release everything. Equivalent to cancel() but doesn't
 *  invoke the onCancel callback — used by the menu-toggle off path. */
export function stop(): void {
  teardown();
}

function teardown(): void {
  stopSilenceLoop();
  clearSendwordCommitTimer();
  if (cooldownTimer) { clearTimeout(cooldownTimer); cooldownTimer = null; }
  try {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  } catch { /* noop */ }
  mediaRecorder = null;
  audioChunks = [];
  // Release the local STT provider if we were running on the local
  // engine. Fire-and-forget — the await chain isn't worth the async
  // teardown signature change for downstream callers (cancel/stop are
  // declared sync and we don't want to break that contract).
  void teardownLocalProvider();
  localBufferedText = '';
  localBestInterim = '';
  armedWithLocal = false;
  if (mediaStream) {
    audioPlatform.releaseMicStream('listen');
    mediaStream = null;
  }
  analyser = null;
  mockFrames = null;
  try { sendwordDetector.stop(); } catch { /* noop */ }
  // Tear down the visual recorder bar BEFORE transition('idle') so
  // the transition's analyser-detach logic (bar.attachAnalyser(null))
  // doesn't run on a destroyed bar.
  if (bar) {
    try { bar.destroy(); } catch { /* noop */ }
    bar = null;
  }
  transition('idle');
}

function transition(s: ListenState): void {
  if (state === s) return;
  state = s;
  try { opts?.onState?.(s); } catch { /* noop */ }
  // Sync the recorder bar's analyser to whether we're actively
  // capturing for transcription. Live waveform during 'armed' (mic
  // → blob), frozen during commit/playing/cooldown so the user
  // doesn't see motion that misrepresents capture state. The bar
  // itself stays mounted across all non-idle states.
  if (bar) {
    bar.attachAnalyser(s === 'armed' ? analyser : null);
  }
  // Refresh the test hook surface every transition so polling sees fresh state.
  installTestHooksIfRequested();
}

// ── Test hooks ─────────────────────────────────────────────────────────
// Activated only when ?listen_mock_mic=1 is on the URL. Smokes drive
// synthetic frames in via injectSilence/injectSpeech instead of routing
// real mic audio.

function isMockMicEnabled(): boolean {
  try {
    const qs = new URLSearchParams(location.search);
    return qs.get('listen_mock_mic') === '1';
  } catch {
    return false;
  }
}

function installTestHooksIfRequested(): void {
  if (typeof window === 'undefined') return;
  if (!isMockMicEnabled()) return;
  (window as any).__listen = {
    get state() { return state; },
    injectSilence(durationMs: number) {
      mockFrames = { type: 'silence', remainingMs: durationMs };
      // Pretend we never heard speech — wind lastVoiceAt back so the
      // configured silence window can elapse during the mock frame.
      silenceWindow?.noteVoice(Date.now() - durationMs);
    },
    injectSpeech(durationMs: number) {
      mockFrames = { type: 'speech', remainingMs: durationMs };
      silenceWindow?.noteVoice();
    },
    commit() { void commitNow('sendword'); },
  };
}
