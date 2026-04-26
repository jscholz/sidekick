/**
 * @fileoverview SideKick — main entry point. Wires all modules together.
 * No logic lives here — just imports + initialization + cross-module callbacks.
 */

import { loadConfig, getConfig, gwWsUrl, getAgentLabel, getAppName, applySkinning } from './config.ts';
import { log, diag, setDebugElement } from './util/log.ts';
import { fetchWithTimeout, TimeoutError } from './util/fetchWithTimeout.ts';
import * as status from './status.ts';
import * as settings from './settings.ts';
import * as theme from './theme.ts';
import * as wakeLock from './wakeLock.ts';
import * as chat from './chat.ts';
import * as backend from './backend.ts';
import * as sessionDrawer from './sessionDrawer.ts';
import * as cmdkPalette from './cmdkPalette.ts';
import * as gateway from './gateway.ts';
import * as tts from './pipelines/classic/tts.ts';
import { unlock, getAudioCtx, reset as resetAudio } from './audio/unlock.ts';
import * as audioSession from './audio/session.ts';
import * as capture from './audio/capture.ts';
import * as fakeLock from './fakeLock.ts';
import * as deepgram from './pipelines/classic/deepgram.ts';
import * as sttBackfill from './pipelines/classic/sttBackfill.ts';
import { setMicPeakListener } from './audio/micMeter.ts';
import { attachCard } from './canvas/attach.ts';
import { registerCard } from './canvas/registry.ts';
import { parseCardsFromText, extractImageBlocks } from './canvas/fallback.ts';
import { miniMarkdown } from './util/markdown.ts';
import * as ambient from './ambient.ts';
import { playFeedback } from './audio/feedback.ts';
import * as memo from './audio/memo.ts';
import * as queue from './queue.ts';
import * as voiceMemos from './voiceMemos.ts';
import * as memoCard from './memoCard.ts';
import * as attachments from './attachments.ts';
import * as draft from './draft.ts';
import * as composer from './composer.ts';
import * as voice from './pipelines/classic/voice.ts';
import * as replyPlayer from './pipelines/classic/replyPlayer.ts';
import * as replyCache from './pipelines/classic/replyCache.ts';
import * as webrtcControls from './pipelines/webrtc/controls.ts';
import * as bgTrace from './bgTrace.ts';
import { stripReasoningLeak } from './backends/hermes.ts';

// Card kind modules
import imageCard from './canvas/cards/image.ts';
import youtubeCard from './canvas/cards/youtube.ts';
import spotifyCard from './canvas/cards/spotify.ts';
import linksCard from './canvas/cards/links.ts';
import markdownCard from './canvas/cards/markdown.ts';
import loadingCard from './canvas/cards/loading.ts';

// ─── State ──────────────────────────────────────────────────────────────────

/** Matches NO_REPLY and variants the agent sometimes emits when deciding not to reply. */
const NO_REPLY_RE = /^\s*NO[-_]?(?:REPL(?:Y)?)?\.?\s*$/i;

/** Track pointer — which agent reply BT next/prev navigates relative to.
 *  Distinct from `tts.getReplyId()` which is "what's currently playing":
 *  the pointer persists when nothing is playing (e.g., user tapped pause
 *  or hasn't started yet), so BT prev/next has a deterministic anchor.
 *  Defaults to the latest agent reply on session load + advances every
 *  time a new agent reply lands. setTrackPointer() also updates the DOM
 *  class so the bubble-edge indicator follows. */
let trackPointerId: string | null = null;
function setTrackPointer(id: string | null) {
  trackPointerId = id;
  const el = document.getElementById('transcript');
  if (!el) return;
  el.querySelectorAll('.line.agent.track-pointer').forEach(b => b.classList.remove('track-pointer'));
  if (!id) return;
  const target = el.querySelector(`.line.agent[data-reply-id="${CSS.escape(id)}"]`);
  if (target) {
    target.classList.add('track-pointer');
    // Cached / not-cached → primary vs muted edge color.
    if (replyCache.has(id)) target.classList.add('track-cached');
    else target.classList.remove('track-cached');
  }
}
function getTrackPointer(): string | null {
  // Lazy default: if no explicit pointer, fall back to whatever's playing,
  // else to the latest agent reply in DOM order. Lets a fresh session
  // have a sane "current track" without an explicit init step.
  if (trackPointerId) return trackPointerId;
  const playing = tts.getReplyId();
  if (playing) return playing;
  const el = document.getElementById('transcript');
  if (!el) return null;
  const bubbles = el.querySelectorAll('.line.agent[data-reply-id]:not(.streaming)');
  if (!bubbles.length) return null;
  return (bubbles[bubbles.length - 1] as HTMLElement).dataset.replyId || null;
}

// When TTS chunks land in replyCache, flip the pointer's edge color from
// gray (uncached) → primary (cached). Subscribe once at module load.
replyCache.on('cached', ({ replyId }: { replyId: string }) => {
  if (trackPointerId === replyId) {
    const el = document.querySelector(`.line.agent[data-reply-id="${CSS.escape(replyId)}"]`);
    if (el) el.classList.add('track-cached');
  }
});
replyCache.on('evicted', ({ replyId }: { replyId: string }) => {
  if (trackPointerId === replyId) {
    const el = document.querySelector(`.line.agent[data-reply-id="${CSS.escape(replyId)}"]`);
    if (el) el.classList.remove('track-cached');
  }
});

/** Find the agent reply bubble AFTER the one identified by `currentReplyId`
 *  in DOM order. Skips the .streaming bubble (mid-flight, not a "track").
 *  Returns { replyId, text } or null. */
function findAgentReplyAfter(currentReplyId) {
  const el = document.getElementById('transcript');
  if (!el) return null;
  const bubbles = Array.from(
    el.querySelectorAll('.line.agent[data-reply-id]:not(.streaming)')
  ) as HTMLElement[];
  if (!currentReplyId) return null;
  const idx = bubbles.findIndex(b => b.dataset.replyId === currentReplyId);
  if (idx < 0 || idx === bubbles.length - 1) return null;
  const next = bubbles[idx + 1];
  return { replyId: next.dataset.replyId, text: next.dataset.text || '' };
}

/** Find the agent reply bubble BEFORE the one identified by `currentReplyId`,
 *  or the LAST one if no current reply (for "play previous" from idle). */
function findAgentReplyBefore(currentReplyId) {
  const el = document.getElementById('transcript');
  if (!el) return null;
  const bubbles = Array.from(
    el.querySelectorAll('.line.agent[data-reply-id]:not(.streaming)')
  ) as HTMLElement[];
  if (bubbles.length === 0) return null;
  if (!currentReplyId) {
    const last = bubbles[bubbles.length - 1];
    return { replyId: last.dataset.replyId, text: last.dataset.text || '' };
  }
  const idx = bubbles.findIndex(b => b.dataset.replyId === currentReplyId);
  if (idx <= 0) return null;
  const prev = bubbles[idx - 1];
  return { replyId: prev.dataset.replyId, text: prev.dataset.text || '' };
}

/** Skip to the previous or next agent reply relative to the currently-active
 *  TTS reply. Unified behavior across all skip surfaces (pocket-lock
 *  prev/next buttons, Apple Watch / iOS Control Center / BT headset track
 *  buttons via Media Session API).
 *
 *  Cached replies play instantly via playCached + resume from the position
 *  they were at when the user skipped away. Uncached replies re-synthesize
 *  from scratch (no way to resume into audio that doesn't exist yet).
 *
 *  On the LATEST reply, "next" has no successor — treat it as barge-in
 *  (interrupt the agent, let the user speak).
 *
 *  @param {'prev' | 'next'} direction
 */
function skipTo(direction) {
  // Pointer drives BT prev/next, NOT the currently-playing reply id.
  // Persistent across pause/idle so the user has a deterministic anchor
  // for "skip from here" even when nothing is playing right now.
  const anchor = getTrackPointer();
  const target = direction === 'prev'
    ? findAgentReplyBefore(anchor)
    : findAgentReplyAfter(anchor);
  if (!target) {
    // Past-latest "next": pointer stays put, seek the current TTS to its
    // end so playback finishes naturally rather than barging in. (Pause
    // / barge-in is the single-tap behavior; skip-next-past-end is "let
    // this finish, I'm done"). If nothing is playing at all, no-op.
    if (direction === 'next') {
      if (tts.isSpeaking()) {
        try { tts.seekTo(1.0); } catch {}
      }
    }
    return;
  }
  const reason = direction === 'prev' ? 'previous-track' : 'next-track';
  tts.stop(reason);  // saves position of outgoing reply into replyCache
  setTrackPointer(target.replyId);
  if (replyCache.has(target.replyId)) {
    if (tts.playCached(target.replyId, { resume: true })) return;
  }
  // Uncached: re-synthesize. tts.speak takes care of marking the cache
  // entry once chunks arrive; a separate hook below toggles .track-cached
  // when replyCache fills so the edge color flips from gray to primary.
  tts.speak(target.text, { replyId: target.replyId });
}

/** Handle voice-nav keywords fired from voice.ts. Same behavior as the
 *  pocket-lock prev/next buttons, BT headset media keys, and the iOS
 *  Control Center's track controls — all funnel through skipTo().
 *  'pause' toggles the current reply's playback. */
function handleNavAction(action: 'prev' | 'next' | 'pause') {
  if (action === 'pause') {
    if (tts.isSpeaking()) tts.pause();
    else tts.resume();
    return;
  }
  skipTo(action);
}
window.addEventListener('sidekick:nav', (e) => {
  const detail = (e as CustomEvent).detail;
  if (detail && typeof detail.action === 'string') handleNavAction(detail.action);
});

/** Re-render memo cards from IndexedDB into the transcript. Idempotent — render skips existing. */
async function restoreMemoCards() {
  try {
    const transcriptEl = document.getElementById('transcript');
    if (!transcriptEl) return;
    const memos = await voiceMemos.getAll();
    for (const rec of memos) memoCard.render(transcriptEl, rec);
    if (memos.length) {
      log('restored', memos.length, 'memo card(s) from IndexedDB');
      chat.forceScrollToBottom();
    }
  } catch (e) { log('memo restore failed:', e.message); }
}

let listening = false;
let mediaStream = null;
let memoActive = false;  // true while voice-memo recording bar is shown

// releaseCaptureIfActive is defined as a closure inside boot() so it can
// call stopStreaming() directly (which is itself a closure there). That
// avoids the synthetic-btn-mic-click coordination the previous version
// used. See `function releaseCaptureIfActive` inside boot below.
let releaseCaptureIfActive: () => void = () => {};
/** Reply ID of an in-flight streaming TTS session (created on first chat.delta,
 *  finalized on chat.final or cleared on NO_REPLY / image-only). null when idle. */
let streamingTtsReplyId = null;

/** Toggle the composer send button between idle (grey) and active (green).
 *  Sendable = memo recording in progress, typed text, draft content, or
 *  a pending voice transcript ready to send. */
function updateSendButtonState() {
  const send = document.getElementById('composer-send') as HTMLButtonElement | null;
  const input = document.getElementById('composer-input') as HTMLTextAreaElement | null;
  if (!send) return;
  const sendable = memoActive
    || (input?.value?.trim().length ?? 0) > 0
    || draft.hasContent()
    || attachments.hasPending();
  send.classList.toggle('active', sendable);
  send.disabled = !sendable;
}

// ─── Mic device picker ─────────────────────────────────────────────────────

/** Populate the mic <select> with available audio input devices.
 *  Must be called after getUserMedia grants permission (labels are hidden until then). */
async function populateMicPicker() {
  const select = document.getElementById('set-mic') as HTMLSelectElement | null;
  if (!select) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter(d => d.kind === 'audioinput');
    select.innerHTML = '<option value="">Default</option>';
    for (const d of inputs) {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Mic ${d.deviceId.slice(0, 8)}…`;
      select.appendChild(opt);
    }
    select.value = settings.get().micDevice;
  } catch (e) {
    log('enumerateDevices error:', e.message);
  }
}

// ─── Boot ───────────────────────────────────────────────────────────────────

async function boot() {
  // Load config from server (keys, gateway info)
  await loadConfig();
  const cfg = getConfig();
  // Apply per-install skinning (app name, subtitle, theme color) before the
  // rest of the UI renders so branding is consistent from boot.
  applySkinning();

  // Debug panel — Ctrl+Shift+D on desktop, triple-tap header on mobile
  setDebugElement(document.getElementById('debug'));
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'D') {
      document.getElementById('debug').classList.toggle('on');
    }
  });
  // Triple-tap on header toggles debug (mobile)
  let headerTaps = 0, headerTapTimer = null;
  document.querySelector('.header').addEventListener('click', () => {
    headerTaps++;
    clearTimeout(headerTapTimer);
    if (headerTaps >= 3) {
      document.getElementById('debug').classList.toggle('on');
      headerTaps = 0;
    } else {
      headerTapTimer = setTimeout(() => { headerTaps = 0; }, 500);
    }
  });

  // Status indicator
  status.init({
    status: document.getElementById('status'),
    statusText: document.getElementById('status-text'),
  });

  // Background-lifecycle diagnostic tracer — opt-in via ?bg_trace=1 or
  // localStorage.sidekick_bg_trace=1. Noop when not enabled. Install
  // before audioSession/capture touch anything so we catch the first
  // transitions. Getters are lazy — each poll reads live state, no
  // eager construction.
  bgTrace.install({
    getStream: () => capture.getActiveStream(),
    getAudioCtx: () => getAudioCtx(),
    getKeepaliveEl: () => audioSession.getKeepaliveEl(),
  });
  // Expose dump() globally when tracing is enabled so the bench-test
  // protocol can grab the buffer from devtools with `sidekickBgTrace()`
  // and paste it into a bug report.
  if (bgTrace.isEnabled()) {
    (window as any).sidekickBgTrace = () => bgTrace.dump();
  }

  // Background audio session — Media Session (lock-screen + BT headset tap)
  // + silent keepalive. BT taps map to play/pause handlers so a Pixel Buds
  // tap stops TTS or toggles listening without needing to touch the phone.
  audioSession.init({
    onPlay: () => {
      // BT play priority:
      // 1. If TTS paused → resume from where we paused.
      // 2. Else if TTS already speaking → no-op (don't restart).
      // 3. Else play whatever the track pointer is on (generate audio
      //    on demand if the bubble isn't cached). User-confirmed
      //    behavior: "start talking now, wherever the pointer is" —
      //    even if nothing was playing before.
      // 4. Else (no reply to play, no pointer) → fall through to mic
      //    listening (existing keep-doing-what-you-were-doing default).
      if (tts.getState() === 'paused') { tts.resume(); return; }
      if (tts.isSpeaking()) return;
      const ptr = getTrackPointer();
      if (ptr) {
        const bubble = document.querySelector(`.line.agent[data-reply-id="${CSS.escape(ptr)}"]`) as HTMLElement | null;
        const text = bubble?.dataset.text || '';
        if (text) {
          if (replyCache.has(ptr)) {
            if (tts.playCached(ptr, { resume: true })) return;
          }
          tts.speak(text, { replyId: ptr });
          return;
        }
      }
      if (listening) return;
      const btnMicEl = document.getElementById('btn-mic');
      if (btnMicEl) btnMicEl.click();
    },
    onPause: () => {
      // Single-tap BT / media-session pause. If TTS is playing, PAUSE
      // (not stop — keeps position so the user can resume). If TTS is
      // paused, resume. Otherwise, toggle listening.
      const state = tts.getState();
      if (state === 'playing') { tts.pause(); return; }
      if (state === 'paused')  { tts.resume(); return; }
      if (listening) {
        const btnMicEl = document.getElementById('btn-mic');
        if (btnMicEl) btnMicEl.click();
      }
    },
    onStop: () => {
      // Explicit stop (distinct from pause) — user wants playback to
      // fully end and the mic released.
      if (tts.isSpeaking()) tts.stop('bt-tap');
      if (listening) {
        const btnMicEl = document.getElementById('btn-mic');
        if (btnMicEl) btnMicEl.click();
      }
    },
    // BT double-tap → nexttrack. On the latest reply, there IS no next,
    // so semantically "skip ahead" = interrupt the agent = barge-in.
    // On older replies, advance to the next agent reply (if any) and
    // play it — cached if available, re-synth otherwise.
    //
    // resume:true so that next→prev→next comes back to where the user
    // left off in each track (position saved in replyCache on stop).
    onNextTrack: () => skipTo('next'),
    onPreviousTrack: () => skipTo('prev'),
    onSeekTo: (time) => {
      const duration = tts.getDuration();
      if (!duration || !Number.isFinite(time)) return;
      tts.seekTo(Math.max(0, Math.min(1, time / duration)));
    },
    // When the tab returns to foreground, webkitSpeechRecognition may be
    // in an error state ("not-allowed" is common after being backgrounded).
    // Bounce the mic button to re-initialize cleanly — same pattern used
    // for engine-toggle recovery.
    onForeground: () => {
      if (!listening) return;
      if (settings.get().streamingEngine !== 'local') return;
      // Defer slightly so visibility settles.
      setTimeout(() => {
        if (!listening) return;
        const btnMicEl = document.getElementById('btn-mic') as HTMLButtonElement | null;
        if (!btnMicEl) return;
        log('foreground: bouncing mic to recover SR');
        btnMicEl.click();
        setTimeout(() => { if (!listening) btnMicEl.click(); }, 500);
      }, 300);
    },
  });
  if (!audioSession.isStandalone()) {
    log('NOTE: not running as installed PWA — background audio will be limited');
  }

  // Pocket lock — full-screen overlay with swipe-to-unlock. Keeps tab
  // foreground so mic/TTS/barge-in keep working (no iOS suspension).
  // Prev/next callbacks share the same transcript-walking logic as the
  // Media Session handlers below.
  fakeLock.init({
    statusFn: () => ({
      listening,
      speaking: tts.isSpeaking(),
      modelLabel: (() => {
        const e = settings.getCurrentModelEntry?.();
        if (!e) return '';
        return (e.name || e.id).replace(/^openrouter\//, '').split('/').slice(-1)[0];
      })(),
    }),
    // Pocket-lock prev/next share the same skip logic as Media Session
    // (Apple Watch, iOS Control Center, BT headset buttons). One source of
    // truth; consistent behavior across all control surfaces.
    onPrev: () => skipTo('prev'),
    onNext: () => skipTo('next'),
  });
  const btnLock = document.getElementById('btn-lock');
  if (btnLock) btnLock.onclick = () => fakeLock.show();

  // Voice transport toggle (dev kill-switch). Label reflects the current
  // setting; click flips it and reloads so the new transport's wiring
  // applies cleanly. Removed when classic pipeline is gutted.
  const btnTransport = document.getElementById('btn-transport');
  if (btnTransport) {
    const sync = () => {
      const t = settings.get().voiceTransport;
      btnTransport.textContent = t === 'webrtc' ? 'RTC' : 'Classic';
      btnTransport.classList.toggle('transport-classic', t === 'classic');
    };
    sync();
    btnTransport.onclick = () => {
      const cur = settings.get().voiceTransport;
      const next = cur === 'webrtc' ? 'classic' : 'webrtc';
      settings.set('voiceTransport', next);
      log('voiceTransport flipped:', cur, '→', next, '(reloading)');
      location.reload();
    };
  }

  // Sidebar — always visible (48px rail), expands on hamburger. Holds
  // new-chat, sessions list (if backend supports it), and info/settings
  // at the bottom. Desktop: expand state persists across reload and shifts
  // body content right (Gemini-style). Mobile: overlay-style, never
  // persisted (taps outside collapse it so the chat reclaims focus).
  const sidebar = document.getElementById('sidebar');
  const sbToggle = document.getElementById('sb-toggle');
  const sbToggleMobile = document.getElementById('sb-toggle-mobile');
  const SIDEBAR_PREF_KEY = 'sidekick.sidebar.expanded';
  if (sidebar && sbToggle) {
    const setExpanded = (exp: boolean) => {
      sidebar.classList.toggle('expanded', exp);
      sidebar.classList.toggle('collapsed', !exp);
      sidebar.setAttribute('aria-expanded', exp ? 'true' : 'false');
      // Body class drives mobile-only CSS: hide the toolbar hamburger when
      // the sidebar is open so the user taps outside to close (no competing
      // toggle on top of the overlay). On desktop, the same class shifts
      // body.padding-left to 260px so the main content slides right.
      document.body.classList.toggle('sidebar-expanded', exp);
      if (exp) sessionDrawer.refresh();  // fresh data each time we open
      // Persist only on desktop — a mobile toggle is a transient navigation
      // action, not a global preference, and we don't want it forcing the
      // drawer open on the next desktop load (or vice versa).
      if (window.innerWidth >= 700) {
        try { localStorage.setItem(SIDEBAR_PREF_KEY, exp ? '1' : '0'); } catch {}
      }
    };
    // Restore persisted state on desktop only. Mobile always starts collapsed.
    if (window.innerWidth >= 700) {
      try {
        if (localStorage.getItem(SIDEBAR_PREF_KEY) === '1') setExpanded(true);
      } catch {}
    }
    const toggle = (e?: Event) => {
      if (e) e.stopPropagation();  // don't let the same click count as "outside"
      setExpanded(!sidebar.classList.contains('expanded'));
    };
    sbToggle.onclick = toggle;
    if (sbToggleMobile) sbToggleMobile.onclick = toggle;
    // Tap outside sidebar closes it ON MOBILE ONLY. Desktop keeps it open
    // until manual hamburger toggle. Capture phase (third arg `true`) is
    // important: chat-bubble interactive controls (play, copy, scrubber)
    // call e.stopPropagation() to avoid side-effects in the transcript,
    // which was killing this listener during the bubble phase. Capture
    // fires on the way DOWN to the target, before any child handler runs,
    // so the collapse happens regardless. The button's own onclick still
    // fires normally afterwards.
    document.addEventListener('click', (e) => {
      if (!sidebar.classList.contains('expanded')) return;
      if (sidebar.contains(e.target as Node)) return;
      if (window.innerWidth >= 700) return;   // desktop: no-op
      setExpanded(false);
    }, true);
  }

  // Session list inside the sidebar — renders when backend supports browsing.
  sessionDrawer.init({
    onResume: replaySessionMessages,
    // Stale-foreground recovery: if the session the user is currently
    // viewing gets deleted out from under them (menu delete, bulk wipe,
    // backend nuke), drop the ghost transcript and rotate to a fresh
    // chat surface so they can keep going.
    onSessionGone: () => {
      diag('reset history: viewed session disappeared from server');
      chat.clear();
      draft.dismiss();
      voice.cancelPendingFlush();
      replyCache.clear();
      voiceMemos.clearAll().catch(() => {});
      historyLoaded = false;
      backend.newSession?.();
      chat.addSystemLine('The session you were viewing was deleted. Started a fresh chat.');
    },
  });
  // Cmd+K palette — instant session filter + debounced messages_fts
  // search. Resume hits funnel through replaySessionMessages so behavior
  // matches a normal drawer tap.
  cmdkPalette.init({ onResume: replaySessionMessages });

  // Info popup — triggered from the sidebar-bottom button.
  const btnInfo = document.getElementById('sb-info');
  const infoPanel = document.getElementById('info-panel');
  const infoClose = document.getElementById('info-close');
  if (btnInfo && infoPanel) {
    btnInfo.onclick = () => { infoPanel.classList.remove('hidden'); infoPanel.setAttribute('aria-hidden', 'false'); };
    const closeInfo = (e?: Event) => {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      infoPanel.classList.add('hidden');
      infoPanel.setAttribute('aria-hidden', 'true');
    };
    if (infoClose) {
      // pointerup + click for iOS-quirky cases — same pattern as
      // settings-close. Without pointerup, the close on iPhone could
      // register :active but fail to fire click (observed in BUG 5).
      infoClose.addEventListener('pointerup', closeInfo);
      infoClose.addEventListener('click', closeInfo);
    }
    infoPanel.addEventListener('click', (e) => {
      if (e.target === infoPanel) closeInfo();
    });
  }

  // Tap the status text to toggle streaming engine (only while listening)
  const statusTextEl = document.getElementById('status-text');
  if (statusTextEl) {
    statusTextEl.onclick = () => {
      if (!listening) return;
      const next = settings.get().streamingEngine === 'server' ? 'local' : 'server';
      settings.set('streamingEngine', next);
      // Keep Settings dropdown in sync
      const select = document.getElementById('set-streaming-engine') as HTMLSelectElement | null;
      if (select) select.value = next;
      // Restart streaming with the new engine (same pattern as setting change)
      const btnMic = document.getElementById('btn-mic') as HTMLButtonElement | null;
      if (btnMic) { btnMic.click(); setTimeout(() => btnMic.click(), 800); }
    };
  }

  // Settings
  settings.load();
  settings.applyVisuals();
  settings.hydrate({
    onThemeChange: () => theme.applyTheme(settings.get().theme),
    onSessionsFilterChange: () => sessionDrawer.refreshAfterFilterChange(),
    onVoiceChange: () => {
      // Drop cached audio that was synthesized in the old voice so future
      // replays re-synthesize in the voice the user just picked.
      replyCache.invalidateOtherVoices(settings.get().voice);
      if (settings.get().tts) tts.speak('Voice changed.');
    },
    onMicChange: () => {
      // If currently listening, restart with the new device/engine.
      // Longer delay (800ms) gives iOS time to actually release the mic
      // before re-acquiring — race here produces a stream that looks live
      // but won't route audio to createMediaStreamSource.
      if (listening) {
        const btnMic = document.getElementById('btn-mic') as HTMLButtonElement | null;
        if (btnMic) { btnMic.click(); setTimeout(() => btnMic.click(), 800); }
      }
    },
    onStreamingEngineChange: () => {
      // If currently listening, restart with the new STT engine
      if (listening) {
        const btnMic = document.getElementById('btn-mic');
        if (btnMic) { btnMic.click(); setTimeout(() => btnMic.click(), 300); }
      }
    },
    onWakeLockChange: () => {
      // Decoupled from `listening`: the UI checkbox is labelled
      // "Pocket Lock / Stay Awake" and users expect it to mean "screen
      // doesn't sleep" regardless of mic state. Tying acquisition to
      // listening meant flipping the toggle with mic off did nothing,
      // and the lock quietly failed to survive in-pocket backgrounding
      // if listening had paused for any reason in between.
      if (settings.get().wakeLock) wakeLock.acquire('setting');
      else wakeLock.release('setting');
    },
    onAutoSendChange: () => syncSpeakingButton(),
    onModelChange: (ref: string, catalog: any[], opts: { silent?: boolean } = {}) => {
      const entry = catalog.find((e: any) => e.id === ref);
      const label = entry ? (entry.name || entry.id).replace(/^openrouter\//, '') : ref;
      if (!opts.silent) chat.addSystemLine(`Model: ${label}`);
      attachments.updateModelGate();
    },
  });

  // Theme
  theme.applyTheme(settings.get().theme);
  theme.watchSystem(() => settings.get().theme);

  // Wake lock — the ref-counted holders set in wakeLock.ts is authoritative;
  // watchVisibility re-acquires the OS sentinel on visibility→visible / focus
  // / resume whenever any key is held. Register the 'setting' key on boot
  // if the user has Pocket Lock / Stay Awake enabled.
  wakeLock.watchVisibility();
  if (settings.get().wakeLock) wakeLock.acquire('setting');

  // Mic-stream resuscitation on foreground. When iOS backgrounds the
  // PWA, the MediaStream may be invalidated even though `listening`
  // stays true; audioCtx.resume() alone won't bring the mic back. On
  // visibility→visible or focus we check whether the mic track is still
  // live — if it ended, simulate a mic-toggle double-click to cleanly
  // tear down the dead stream and re-request getUserMedia.
  const resuscitateMic = () => {
    if (document.visibilityState !== 'visible') return;
    if (!listening || !mediaStream) return;
    const track = mediaStream.getAudioTracks()[0];
    if (!track || track.readyState === 'ended') {
      diag('mic: foreground resuscitation — track dead, restarting');
      const btnMic = document.getElementById('btn-mic') as HTMLButtonElement | null;
      if (btnMic) {
        // click once to clear internal state, again to re-start. Small
        // delay so the stop path finishes cleanup before the start path
        // requests a new MediaStream.
        btnMic.click();
        setTimeout(() => btnMic.click(), 300);
      }
    }
  };
  document.addEventListener('visibilitychange', resuscitateMic);
  window.addEventListener('focus', resuscitateMic);
  document.addEventListener('resume', resuscitateMic);

  // Chat
  const transcriptEl = document.getElementById('transcript');
  const chatRestored = await chat.init(transcriptEl);
  chat.onLoadEarlier(loadEarlierHistory);
  // Backfill ALWAYS runs on connect — dedup by text handles duplicates.
  // The snapshot lives in IndexedDB (survives tab close, PWA kills, and
  // cross-SW-version reloads); backfill plugs any residual gap on connect.
  if (chatRestored) log('chat: restored from snapshot');

  // Attachments + draft — composer wiring that isn't tied to a specific button
  attachments.init({ onChange: updateSendButtonState });
  replyPlayer.init({ transcriptEl });

  // STT backfill — subscribe to DG WS state events and translate into
  // gap-start / gap-end markers in the ring buffer. On mic stop,
  // voice.flushBackfill() POSTs each gap to /transcribe. First dg-open
  // fires when there's no active gap (just bootstraps the connection);
  // sttBackfill.markGapEnd is a no-op in that case.
  deepgram.on('dg-close', ({ ctxTime }) => sttBackfill.markGapStart(ctxTime));
  deepgram.on('dg-wedge', ({ ctxTime }) => sttBackfill.markGapStart(ctxTime));
  deepgram.on('dg-open',  ({ ctxTime }) => {
    sttBackfill.markGapEnd(ctxTime);
    // Proactive drain: any gaps that got deferred on a prior failed
    // /transcribe attempt now have a fresh chance over the healthy
    // connection. Without this, deferred gaps wait for mic stop
    // before surfacing — a rider on a flaky network loses the middle
    // of their utterance until they pause. Splice any recovered
    // text straight into the draft at the chronologically correct
    // position so it reads as continuous dictation.
    sttBackfill.tryDrainDeferred().then((gaps) => {
      for (const g of gaps) {
        if (g.text && g.text.trim()) draft.appendBackfill(g.text.trim(), g.ctxStart);
      }
    }).catch(() => { /* silent — drain is best-effort */ });
  });

  // Feed TTS state to Media Session so iOS Control Center / Android
  // media notification / Apple Watch Now Playing know we're actually
  // playing audio. Without a 'playing' state, Watch taps fire our
  // action handlers but iOS doesn't route the playback gesture to our
  // page — user sees "playing" on Watch but no audio comes out of phone.
  tts.on('play-start', () => { audioSession.setPlaybackState('playing'); });
  tts.on('resumed',    () => { audioSession.setPlaybackState('playing'); });
  tts.on('paused',     () => { audioSession.setPlaybackState('paused'); });
  tts.on('ended',      () => { audioSession.setPlaybackState('none'); drainPendingReply(); });
  tts.on('stopped',    () => { audioSession.setPlaybackState('none'); drainPendingReply(); });
  tts.on('progress', ({ position, duration }) => {
    audioSession.setPositionState(duration || 0, position || 0, 1.0);
  });
  tts.on('duration-known', ({ duration }) => {
    const pos = tts.getPosition();
    audioSession.setPositionState(duration, pos?.position || 0, 1.0);
  });

  // Global hotkeys. Space toggles play/pause of current TTS (skipped in
  // text inputs). Alt+M toggles the mic stream. Esc closes an open
  // settings or info panel.
  document.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    const tag = t?.tagName;
    const inText = tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable;

    // Esc: close whichever overlay panel is open (settings panel is
    // always eligible; info panel only when not hidden).
    if (e.key === 'Escape') {
      const settingsPanel = document.getElementById('settings');
      if (settingsPanel?.classList.contains('on')) {
        settingsPanel.classList.remove('on');
        e.preventDefault();
        return;
      }
      const infoPanel = document.getElementById('info-panel');
      if (infoPanel && !infoPanel.classList.contains('hidden')) {
        infoPanel.classList.add('hidden');
        infoPanel.setAttribute('aria-hidden', 'true');
        e.preventDefault();
        return;
      }
    }

    // `/`: focus the inline session filter. Skip when an input/textarea
    // is already focused so it doesn't hijack a literal slash typed into
    // the composer or the cmd+K palette. (cmdkPalette.init wires its
    // own cmd+K handler at document level.)
    if (e.key === '/' && !inText) {
      const sidebar = document.getElementById('sidebar');
      if (sidebar && !sidebar.classList.contains('expanded')) {
        // Make sure the sidebar is open so the input is visible/clickable.
        sidebar.classList.add('expanded');
      }
      sessionDrawer.focusFilter();
      e.preventDefault();
      return;
    }

    // Alt+M: toggle mic. `e.code` survives Mac's Alt+key → µ remapping.
    // Fires even from within text inputs — the intent to start streaming
    // is explicit enough that composer focus shouldn't eat it.
    if (e.altKey && e.code === 'KeyM') {
      e.preventDefault();
      document.getElementById('btn-mic')?.click();
      return;
    }

    // Alt+T: toggle TTS ("Talk" — makes the agent speak replies).
    if (e.altKey && e.code === 'KeyT') {
      e.preventDefault();
      document.getElementById('btn-speak')?.click();
      return;
    }

    // Space: play/pause the current TTS (only when nothing editable is focused).
    if (e.key === ' ' || e.code === 'Space') {
      if (inText) return;
      const state = tts.getState();
      if (state === 'playing') { e.preventDefault(); tts.pause(); }
      else if (state === 'paused') { e.preventDefault(); tts.resume(); }
    }
  });
  draft.init({
    transcriptEl,
    onChange: updateSendButtonState,
    onFocus: voice.cancelPendingFlush,
    onFlush: (text) => {
      // User bubble FIRST, then send. Send fires backend.onSend → the
      // "thinking…" agent bubble, which appends at the end of the
      // transcript. If we sent first, the thinking bubble would land
      // above the user's message, making the agent look like it was
      // replying to something not yet written. Matches sendTypedMessage's
      // order for typed messages (see sendTypedMessage above).
      chat.addLine('You', text, 's0', { source: 'voice' });
      backend.sendMessage(text, { voice: true });
      playFeedback('send');
    },
  });
  // composer.init is called later (after sendTypedMessage is defined)
  // so onSubmit can be wired — see the call next to composerSend.onclick.

  // Clear previously-sent memos (reload = clean slate). Pending/queued
  // memos are preserved so the offline outbox survives phone lock/reboot.
  // Defensive: clearSent was added after voiceMemos shipped — if a stale
  // cached voiceMemos.ts is paired with a fresh main.ts (SW cache race),
  // skip rather than crash boot.
  if (typeof voiceMemos.clearSent === 'function') {
    await voiceMemos.clearSent().catch(() => {});
  }
  // Restore memo cards from IndexedDB (only pending now)
  await restoreMemoCards();

  // TTS
  const player = document.getElementById('player') as HTMLAudioElement;
  tts.init(player);
  tts.setListeningGetter(() => listening);
  tts.setOnStop((reason) => {
    if (reason === 'barge-in') {
      // Short cooldown — catches the immediate "stop" / "ok" word uttered
      // as the user interrupted, nothing more. Previous 2s window was
      // swallowing real content during rapid speech right after a barge-in.
      voice.setBargeInCooldown(300);
    }
  });

  // Register card kinds — inline attachments on agent bubbles.
  [imageCard, youtubeCard, spotifyCard, linksCard, markdownCard, loadingCard]
    .forEach(registerCard);

  // Ambient clock + weather — floating pill in lower-right on desktop,
  // hidden via CSS on mobile (single media query).
  ambient.init();

  // Fast tooltips: native HTML `title` triggers a slow ~1.5-3s browser
  // tooltip. We swap `title` → `data-tip` on hover so the CSS-driven
  // fade-in (600ms delay) shows first, and the native tooltip is
  // suppressed because the title attribute is briefly absent. Restored
  // on mouseleave so screen readers + keyboard focus still find it.
  document.body.addEventListener('mouseover', (e) => {
    const t = e.target as HTMLElement;
    if (!t || !t.hasAttribute || !t.hasAttribute('title')) return;
    const v = t.getAttribute('title');
    if (v) { t.setAttribute('data-tip', v); t.removeAttribute('title'); }
  }, true);
  document.body.addEventListener('mouseout', (e) => {
    const t = e.target as HTMLElement;
    if (!t || !t.hasAttribute || !t.hasAttribute('data-tip')) return;
    const v = t.getAttribute('data-tip');
    if (v) { t.setAttribute('title', v); t.removeAttribute('data-tip'); }
  }, true);

  // Drive the mic-button peak indicator. Smooth the raw worklet peaks
  // with a light exponential filter so the CSS var eases between frames.
  const btnMicForPulse = document.getElementById('btn-mic');
  if (btnMicForPulse) {
    let smoothed = 0;
    setMicPeakListener((peak) => {
      // Attack fast, decay slow — matches perception of volume meters.
      smoothed = peak > smoothed
        ? peak
        : smoothed * 0.7 + peak * 0.3;
      btnMicForPulse.style.setProperty('--mic-peak', smoothed.toFixed(3));
    });
  }

  // ── Backend ────────────────────────────────────────────────────────────
  // Whichever adapter is configured (openclaw by default, openai-compat
  // for a minimal cloud-LLM deploy, future: geminilive) — same interface.
  // Tool-event side channels (e.g. openclaw's /ws/canvas) are opened by
  // the adapter as part of connect(); the shell just subscribes.
  await backend.connect({
    onStatus: async (connected) => {
      if (connected) {
        status.setStatus('Gateway: connected', 'ok');
        // For backends that browse sessions (hermes), resume the adapter's
        // default conversation on boot. If it's empty (fresh install),
        // replaySessionMessages is a no-op and the user gets the blank
        // welcome. For backends without session browsing (openclaw),
        // fall back to the existing history backfill path.
        if (backend.capabilities().sessionBrowsing) {
          // Prefer the session id persisted alongside the restored chat
          // snapshot — that's the session whose transcript is ACTUALLY on
          // screen after reload. Falls back to the adapter's
          // conversationName ('sidekick-main' default) for the fresh
          // install path where no snapshot existed.
          const restoredSid = chat.getRestoredViewedSessionId();
          const sid = restoredSid || backend.getCurrentSessionId?.();
          if (sid) {
            // If we restored a session from snapshot, seed the drawer
            // highlight immediately — before resumeSession's network
            // fetch resolves — so it doesn't briefly flash the
            // placeholder row. If resumeSession succeeds it replays
            // freshly and re-sets viewed via replaySessionMessages
            // (idempotent).
            if (restoredSid) sessionDrawer.setViewed(restoredSid);
            try {
              const { messages } = await backend.resumeSession(sid);
              if (messages.length) replaySessionMessages(sid, messages);
            } catch (e: any) {
              diag(`boot: resume ${sid} failed: ${e.message}`);
            }
          }
        } else {
          await backfillHistory();
        }
        await flushOutbox();
        if (settings.refreshModels) settings.refreshModels().catch(() => {});
      } else {
        status.setStatus('Gateway: disconnected');
      }
    },
    onDelta: handleReplyDelta,
    onFinal: handleReplyFinal,
    onToolEvent: handleToolEvent,
    onActivity: handleActivity,
  });
  // Show/hide the sessions section inside the sidebar based on the
  // active backend's capabilities (sidebar itself is always visible).
  sessionDrawer.applyCapabilities();

  // Any user-initiated send shows the thinking indicator immediately —
  // doesn't wait for the first delta. Critical for the case where the
  // agent jumps straight to tool calls (calendar, email, web fetch) with
  // no text deltas for seconds; without this the chat looks dead.
  backend.onSend(() => showThinking());

  // Any user-initiated send is also a signal that the network is
  // responsive — take that opportunity to retry queued audio blobs
  // stuck in the outbox. Triggered the right fix for the case where
  // /transcribe fails on mobile mid-memo, gateway stays connected, and
  // without this the queue just sits (reconnect-only retries don't
  // fire when the WS never dropped). Mutex in queue.flush keeps this
  // idempotent if two triggers overlap.
  backend.onSend(() => { flushOutbox().catch(() => {}); });

  // Hide settings rows whose feature isn't supported by the active backend.
  // E.g. openai-compat doesn't expose a model catalog → hide the model row.
  const caps = backend.capabilities();
  if (!caps.models) {
    const rowModel = document.getElementById('row-model');
    if (rowModel) rowModel.style.display = 'none';
  }

  // ── Streaming lifecycle ────────────────────────────────────────────────
  //
  // startStreaming / stopStreaming are the full lifecycle for the live-mic
  // mode (AudioWorklet → Deepgram WS). Extracted as named functions so other
  // paths (releaseCaptureIfActive, btn-refresh, memo-auto-resume) can
  // invoke them directly instead of synthetic button clicks.

  async function startStreaming() {
    if (listening) return;
    unlock(player);
    // Register the page as a BT media source while we're inside this user
    // gesture — iOS gates play() on the hidden audio-mediasink element
    // behind a gesture, and only opts the page in to BT play/pause/skip
    // routing once that play() succeeds.
    audioSession.primeMediaSink();

    // Kick off resume SYNCHRONOUSLY inside the user gesture — iOS loses
    // the "user activated" state after any await, so a resume() called
    // after getUserMedia silently fails to actually wake the context.
    const ctx = getAudioCtx();
    const resumePromise = (ctx && ctx.state !== 'running') ? ctx.resume() : null;

    // Prime speechSynthesis inside this gesture so later async-context
    // speak() calls aren't blocked by iOS Safari's gesture rule.
    tts.primeLocalSynthesis?.();

    try {
      const micDevice = settings.get().micDevice;
      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      };
      if (micDevice) audioConstraints.deviceId = { exact: micDevice };
      log('requesting mic…', micDevice ? `device=${micDevice}` : '(default)',
          'ctx.state=', ctx?.state);
      mediaStream = await capture.acquire('streaming', audioConstraints);
      const track = mediaStream.getAudioTracks()[0];
      log('mic granted, track:', track?.label);
      playFeedback('start');
      populateMicPicker();
      if (resumePromise) {
        try { await resumePromise; log('ctx resumed, state=', ctx?.state); } catch {}
      }
      listening = true;
      const btnMicEl = document.getElementById('btn-mic');
      if (btnMicEl) btnMicEl.classList.add('active');
      audioSession.setListening(true);
      // Wake lock is app-lifecycle scoped now (acquired at boot if setting
      // is on, re-acquired on visibility change via wakeLock.watchVisibility).
      // Streaming no longer acquires/releases — that created a hole where
      // stopStreaming would drop the lock even if the user wanted it held.
      draft.ensureBlock();
      sttBackfill.init({ audioCtx: ctx });
      deepgram.start(mediaStream, voice.handleResult);
    } catch (err) {
      log('mic error:', err.message);
      status.setStatus(`Mic error: ${err.message}`);
    }
  }

  function stopStreaming() {
    if (!listening) return;
    listening = false;
    const btnMicEl = document.getElementById('btn-mic');
    if (btnMicEl) btnMicEl.classList.remove('active');
    deepgram.stop();
    capture.release('streaming');
    mediaStream = null;
    voice.cancelPendingFlush();
    // Flush any recoverable audio from DG-gaps, THEN reset the ring.
    // Resetting here also clears the 'Ns buffered' status indicator —
    // previously the buffer stayed populated across reconnects and the
    // header kept showing a stale "6s buffered" readout.
    voice.flushBackfill().finally(() => sttBackfill.reset());
    if (!draft.hasContent()) draft.dismiss();
    // Wake lock intentionally NOT released here — see startStreaming comment;
    // policy is app-lifecycle scoped via settings, not streaming-scoped.
    audioSession.setListening(false);
    status.setStatus(backend.isConnected() ? 'Stopped (gateway connected)' : 'Stopped');
  }

  // Release-all coordinator. Defined here as a closure over startStreaming /
  // stopStreaming / memo state so it calls them directly instead of firing
  // synthetic DOM clicks. Module-scope `releaseCaptureIfActive` (declared
  // at the top of this file) gets reassigned to this closure so external
  // call sites keep working.
  releaseCaptureIfActive = () => {
    if (listening) stopStreaming();
    if (memoActive) {
      memo.cancel();
      const bar = document.querySelector('.memo-bar');
      if (bar) bar.remove();
      memoActive = false;
      const composerInputEl = document.getElementById('composer-input') as HTMLElement | null;
      const btnMemoEl = document.getElementById('btn-memo') as HTMLElement | null;
      if (composerInputEl) composerInputEl.style.display = '';
      if (btnMemoEl) btnMemoEl.style.display = '';
    }
    // Belt-and-suspenders if some future code path leaves the stream held
    // without going through a module teardown.
    if (capture.hasActive()) capture.release();
  };

  // ── Mic + Speak buttons ────────────────────────────────────────────────
  // Two transports share these two buttons:
  //   classic — btn-mic toggles WS+PCM streaming;
  //             btn-speak toggles TTS-on/off (settings.tts).
  //   webrtc — btn-mic = stream-mode call (mic in, transcripts via SSE);
  //             btn-speak = talk-mode call (mic in + TTS out).
  //
  // The transport choice is `settings.get().voiceTransport` (default
  // 'webrtc' on this branch). Settings change is hot — re-resolve the
  // active handler on every click so toggling in settings while either
  // transport is alive cleanly hands off.
  const btnMic = document.getElementById('btn-mic');
  const btnSpeak = document.getElementById('btn-speak');

  // WebRTC controls — stateless init; the click handlers it installs
  // override the classic ones below when voiceTransport === 'webrtc'.
  webrtcControls.init({
    getSessionId: () => sessionDrawer.getViewed() || backend.getCurrentSessionId?.() || null,
    onStatus: (msg, kind) => status.setStatus(msg, kind ?? null),
  });

  // Re-bind the click handlers each time voiceTransport changes (or once
  // at boot). Closures reference the ambient `listening` / startStreaming
  // / stopStreaming declared above.
  function rebindVoiceButtons() {
    const transport = settings.get().voiceTransport;
    if (transport === 'webrtc') {
      // webrtcControls.init already installed click handlers on both
      // buttons. Nothing further to do — but make sure classic state is
      // released if we just flipped.
      if (listening) stopStreaming();
      return;
    }
    // Classic: restore the legacy handlers.
    if (btnMic) btnMic.onclick = () => {
      if (listening) stopStreaming();
      else startStreaming();
    };
    if (btnSpeak) btnSpeak.onclick = () => {
      const on = !settings.get().tts;
      settings.set('tts', on);
      syncSpeakingButton();
      if (!on) {
        voice.cancelPendingFlush();
        tts.stop('button');
      } else {
        audioSession.primeMediaSink();
      }
    };
    // Close any open WebRTC call when leaving webrtc transport.
    void webrtcControls.closeIfOpen();
  }

  function syncSpeakingButton() {
    // In webrtc mode the speak button reflects "talk-mode active";
    // in classic mode it reflects the persistent TTS setting.
    if (settings.get().voiceTransport === 'webrtc') {
      const isTalk = webrtcControls.currentMode() === 'talk' && webrtcControls.isOpen();
      btnSpeak?.classList.toggle('muted', !isTalk);
      return;
    }
    const on = settings.get().tts;
    btnSpeak?.classList.toggle('muted', !on);
  }

  rebindVoiceButtons();
  syncSpeakingButton();

  // ── Composer ────────────────────────────────────────────────────────────
  const composerInput = document.getElementById('composer-input') as HTMLTextAreaElement;
  const composerSend = document.getElementById('composer-send') as HTMLButtonElement;

  function autoResize() {
    composerInput.style.height = 'auto';
    composerInput.style.height = Math.min(composerInput.scrollHeight, 160) + 'px';
  }
  composerInput.addEventListener('input', () => { autoResize(); updateSendButtonState(); });

  // Paste image support — if the clipboard has an image (e.g. screenshot
  // copied via cmd+shift+4 then cmd+C, or Claude Code "copy image"), add
  // it to the pending attachments via the same path as the attach/camera
  // buttons. Text paste falls through to the default textarea behavior.
  composerInput.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items as DataTransferItemList | undefined;
    if (!items) return;
    const mediaFiles = [];
    for (const item of items) {
      if (item.type?.startsWith('image/') || item.type?.startsWith('video/')) {
        const f = item.getAsFile();
        if (f) mediaFiles.push(f);
      }
    }
    if (mediaFiles.length === 0) return;
    e.preventDefault();  // suppress paste-as-text of binary gunk
    for (const f of mediaFiles) await attachments.add(f);
  });

  function sendTypedMessage() {
    const text = composerInput.value.trim();
    const hasAttachments = attachments.hasPending();

    if (text || hasAttachments) {
      if (!backend.isConnected()) {
        status.setStatus('Gateway offline', 'err');
        // Don't leave the mic hot after a blocked send — user expects
        // the UI to reset to a clean state when the gateway is down.
        releaseCaptureIfActive();
        return;
      }
      // Slash commands that reset session state should also wipe local UI
      if (/^\/(reset|new|clear)\b/i.test(text)) {
        diag('reset history: slash command');
        releaseCaptureIfActive();
        chat.clear();
        draft.dismiss();
        voice.cancelPendingFlush();
        replyCache.clear();
        voiceMemos.clearAll().catch(() => {});
        pendingReply = null;  // drop any FIFO-queued reply
        historyLoaded = false;
      } else {
        chat.addLine('You', text || '', 's0', {
          source: 'text',
          attachments: hasAttachments ? attachments.toChatEcho() : undefined,
        });
      }
      const opts = hasAttachments ? { attachments: attachments.toSendPayload() } : {};
      try {
        backend.sendMessage(text, opts);
      } catch (e) {
        // Adapter rejected the send (e.g. WS not yet in OPEN state). Surface
        // it and release the mic, otherwise we'd leave the composer cleared
        // but the user still dictating into an empty box.
        const msg = (e as Error)?.message || String(e);
        diag(`sendMessage failed: ${msg}`);
        status.setStatus(`Send failed: ${msg}`, 'err');
        releaseCaptureIfActive();
        return;
      }
      attachments.clear();
      playFeedback('send');
      composerInput.value = '';
      autoResize();
      updateSendButtonState();
    } else if (draft.hasContent()) {
      if (!backend.isConnected()) {
        status.setStatus('Gateway offline', 'err');
        releaseCaptureIfActive();
        return;
      }
      draft.flush();
    }
  }

  composerSend.onclick = sendTypedMessage;
  // Wire composer.submit() → same path as clicking send. Used by the
  // voice pipeline's auto-submit-on-silence loop (voice.ts).
  composer.init({
    input: composerInput,
    interim: document.getElementById('composer-interim'),
    onChange: updateSendButtonState,
    onSubmit: sendTypedMessage,
  });
  composerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTypedMessage(); }
  });

  // Global Cmd/Ctrl+Enter → send composer, UNLESS focus is in the draft
  // (draft has its own Cmd+Enter binding that flushes the draft). Matches
  // user's mental model: "Enter-family" always means send; which field
  // depends on where your focus is.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (!(e.metaKey || e.ctrlKey)) return;
    const target = document.activeElement as HTMLElement | null;
    // Draft textEl has its own handler (flushes the draft) — don't double-fire.
    if (target?.classList?.contains('draft-text')) return;
    // Avoid double-firing when focus is already in the composer — the
    // composer's own handler above catches plain Enter AND Cmd+Enter.
    if (target === composerInput) return;
    e.preventDefault();
    sendTypedMessage();
  });

  // Camera + attach — each triggers a hidden <input type=file>. On change,
  // attachments.add() reads the file + renders the chip. Send happens via
  // the existing composer-send path.
  const cameraInput = document.getElementById('camera-input') as HTMLInputElement | null;
  const attachInput = document.getElementById('attach-input') as HTMLInputElement | null;
  const btnCamera = document.getElementById('btn-camera') as HTMLButtonElement | null;
  const btnAttach = document.getElementById('btn-attach') as HTMLButtonElement | null;
  if (btnCamera && cameraInput) {
    btnCamera.onclick = () => {
      if (btnCamera.disabled) return;
      cameraInput.value = '';  // allow re-picking the same file
      cameraInput.click();
    };
    cameraInput.onchange = async () => {
      for (const f of Array.from(cameraInput.files || [])) await attachments.add(f);
    };
  }
  if (btnAttach && attachInput) {
    btnAttach.onclick = () => {
      if (btnAttach.disabled) return;
      attachInput.value = '';
      attachInput.click();
    };
    attachInput.onchange = async () => {
      for (const f of Array.from(attachInput.files || [])) await attachments.add(f);
    };
  }

  // New-chat button — lives in the sidebar now (#sb-new-chat). Works for
  // every backend, regardless of whether it supports session browsing,
  // since newSession is just a conversation-name rotation. /new slash
  // command is a separate path handled by sendTypedMessage.
  const btnNewChat = document.getElementById('sb-new-chat');
  if (btnNewChat) {
    btnNewChat.onclick = () => {
      if (!backend.isConnected()) { status.setStatus('Gateway offline', 'err'); return; }
      diag('reset history: new-chat button');
      // Intentionally do NOT stop streaming or cancel memo — new-chat is a
      // conversation rotation, not a full reset. Users expect to stay in
      // whatever audio mode they were in (streaming stays green, memo bar
      // stays open if open). If memo has an in-flight blob queued in the
      // outbox, it'll send against the NEW session. That's a conscious
      // trade: user asked for a fresh thread, they get one.
      chat.clear();
      draft.dismiss();
      voice.cancelPendingFlush();
      replyCache.clear();
      voiceMemos.clearAll().catch(() => {});
      historyLoaded = false;
      backend.newSession?.();
      chat.addSystemLine('New chat started');
      // Drop the viewed-session pin — chat no longer shows any persisted
      // session, so the drawer should fall back to the adapter's fresh
      // conversationName (not yet in response_store.db → placeholder row).
      sessionDrawer.setViewed(null);
      // Re-render the session list so the old session row loses its
      // active highlight (new one isn't in response_store.db yet).
      sessionDrawer.refresh();
      // On mobile, collapse the sidebar so the user sees the fresh chat —
      // otherwise the expanded drawer hides the transition and the action
      // feels like it didn't land. Desktop keeps the drawer open (session
      // browsing is a natural follow-up to starting a new chat on wider
      // screens).
      const sidebar = document.getElementById('sidebar');
      if (sidebar && window.innerWidth < 700) {
        sidebar.classList.remove('expanded');
        sidebar.classList.add('collapsed');
        sidebar.setAttribute('aria-expanded', 'false');
        document.body.classList.remove('sidebar-expanded');
      }
    };
  }

  updateSendButtonState();  // initial state

  // ── Voice memo button ──────────────────────────────────────────────────
  // Tap mic → textarea becomes recording bar; send-button action swaps to
  // stop+send. Visual icon is always the paper-airplane (no label swap).
  const btnMemo = document.getElementById('btn-memo');

  function exitMemoMode() {
    memoActive = false;
    composerInput.style.display = '';
    btnMemo.style.display = '';
    // Restore the composer-actions row + put the send button back in its
    // original DOM home (last child of .composer-actions-right). The bar
    // itself is removed by memo.cleanup(). Re-query each time since the
    // composer DOM is stable but the const lived in the onclick scope.
    const composerEl2 = composerInput.parentElement;
    const actionsEl = composerEl2?.querySelector('.composer-actions') as HTMLElement | null;
    const actionsRightEl = composerEl2?.querySelector('.composer-actions-right') as HTMLElement | null;
    if (actionsEl) actionsEl.style.display = '';
    // Only reparent if the send button got moved into the bar (it may
    // already be in its home if memo.start failed before renderBar).
    if (actionsRightEl && composerSend.parentElement !== actionsRightEl) {
      actionsRightEl.appendChild(composerSend);
    }
    composerSend.onclick = sendTypedMessage;
    updateSendButtonState();
  }

  /** Flush queued audio items — update the corresponding memo cards with transcripts. */
  async function flushOutbox() {
    const result = await queue.flush(
      async (text) => { backend.sendMessage(text); },
      async (blob, mimeType, id) => {
        // 15s timeout: Deepgram REST typically returns in 1-3s even for
        // minute-long clips. On dead network the browser would keep this
        // hanging for ~minutes. 15s gives ample headroom while still
        // freeing the queue loop to retry on the next reconnect.
        let res;
        try {
          res = await fetchWithTimeout('/transcribe', {
            method: 'POST', headers: { 'Content-Type': mimeType }, body: blob,
            timeoutMs: 15_000,
          });
        } catch (e) {
          if (e instanceof TimeoutError) {
            // Surface + chime; blob stays in queue for retry on next
            // reconnect. The card moves to queued(⏳) so the user sees
            // something is pending.
            log('transcribe timeout — blob stays queued for retry');
            const transcriptEl = document.getElementById('transcript');
            const card = id && transcriptEl ? memoCard.find(transcriptEl, id) : null;
            if (card) memoCard.update(card, { status: 'queued' });
            playFeedback('error');
          }
          throw e;  // re-throw so queue.flush keeps the item
        }
        const data = await res.json();
        if (!data.ok) {
          // Distinguish PERMANENT failures (corrupt blob, unsupported
          // format, Deepgram 400) from TRANSIENT (network, 5xx, timeout).
          // Permanent: drop from queue so we don't retry forever.
          // Transient: throw, queue.flush keeps the item for next round.
          //
          // Symptom 2026-04-25 PM: 9 audio memos queued, /transcribe
          // returning "deepgram 400 corrupt or unsupported data" on
          // each retry. Likely blobs recorded while the iOS mic-perm
          // dialog was up (silent / partial). Without this fix the
          // outbox just keeps growing.
          const err = String(data.error || 'transcription failed');
          const isPermanent = /\b4\d\d\b|corrupt|unsupported|empty body/i.test(err);
          if (isPermanent) {
            log('transcribe: permanent failure, dropping blob:', err);
            const transcriptEl = document.getElementById('transcript');
            const card = id && transcriptEl ? memoCard.find(transcriptEl, id) : null;
            const note = '(audio unprocessable)';
            if (card) memoCard.update(card, { transcript: note, status: 'failed' });
            try { await voiceMemos.update(id, { transcript: note, status: 'failed' }); } catch {}
            playFeedback('error');
            return;  // don't throw — queue.flush will drop the item
          }
          throw new Error(err);  // transient → keep in queue
        }
        const text = (data.transcript || '').trim();
        const transcriptEl = document.getElementById('transcript');
        const card = id && transcriptEl ? memoCard.find(transcriptEl, id) : null;

        // Empty transcript — /transcribe succeeded but heard nothing
        // (silent clip / inaudible). Surface that on the card so the user
        // isn't left staring at an orphan row. Persist the status so a
        // reload doesn't restore it as pending again.
        if (!text) {
          const note = '(no speech detected)';
          if (card) memoCard.update(card, { transcript: note, status: 'failed' });
          await voiceMemos.update(id, { transcript: note, status: 'failed' });
          return;
        }

        // Compose-only: per webrtc-plan.md §11, memo never auto-sends —
        // the transcript always lands in the composer textarea so the
        // user can review, append more, or scrub before shipping. Drop
        // the placeholder card; matches the live path.
        if (card) card.remove();
        await voiceMemos.remove(id);
        composer.appendText(text);
      }
    );
    if (result.skipped) diag('outbox: flush skipped (already flushing)');
    else if (result.sent > 0) log('outbox: flushed', result.sent, 'queued messages');
    return result;
  }

  // Periodic background retry. Covers the scenario where /transcribe
  // fails mid-memo (blob queued) but the gateway WS stays connected —
  // no reconnect event fires, no user send happens. Without this, a
  // queued blob sits until the next reload or user action. Poll is
  // cheap (IDB read + early-out if empty); only flushes when there's
  // pending work AND the gateway is reachable.
  setInterval(async () => {
    try {
      const pending = await queue.pending();
      if (pending > 0 && backend.isConnected()) {
        diag(`outbox: periodic retry (${pending} pending)`);
        flushOutbox().catch(() => {});
      }
    } catch {}
  }, 30_000);

  // Periodic network-status refresh. Surfaces queued count, weak-signal
  // detection, and sttBackfill buffered duration in the header. Only
  // writes when the user isn't actively listening or speaking — feature
  // statuses ("Listening", "Speaking", "Mic muted — Speaking") carry
  // their own narrative and we don't want to stomp them. The ~2s cadence
  // is a compromise: granular enough to notice drift, not chatty enough
  // to flicker the header during normal use.
  const WEAK_SIGNAL_MS = 8_000;
  setInterval(async () => {
    if (listening) return;  // listening path owns status (Listening / Mic muted / Speaking)
    if (tts.isSpeaking()) return;
    try {
      const gwConnected = backend.isConnected();
      const summary = await queue.summary();
      const buffered = sttBackfill.getBufferedSeconds();
      const msIdle = gateway.msSinceLastMessage();

      if (!gwConnected) {
        status.setState('reconnecting', { queuedCount: summary.count, queuedAudioMs: summary.totalAudioMs });
      } else if (msIdle > WEAK_SIGNAL_MS && summary.count > 0) {
        status.setState('stalled', { queuedCount: summary.count, queuedAudioMs: summary.totalAudioMs });
      } else if (msIdle > WEAK_SIGNAL_MS) {
        status.setState('weakSignal');
      } else {
        status.setState('connected', {
          queuedCount: summary.count,
          queuedAudioMs: summary.totalAudioMs,
          bufferedSeconds: buffered,
        });
      }
    } catch {}
  }, 2_000);

  /** Save blob to IDB + enqueue for retry + render a placeholder memo card
   *  in chat. Always runs on record stop, regardless of online/offline —
   *  gives the user immediate visual feedback during the quiet
   *  transcription window. Returns {id, card, rec}. */
  async function renderMemoCard(audioBlob, durationMs) {
    const id = crypto.randomUUID();
    const transcriptEl = document.getElementById('transcript');

    const rec = {
      id, blob: audioBlob, mimeType: audioBlob.type, durationMs,
      waveform: new Float32Array(40),
      transcript: null, status: 'pending', timestamp: Date.now(),
    };

    let card = null;
    if (transcriptEl) {
      card = memoCard.render(transcriptEl, rec);
      chat.autoScroll();
    }

    await voiceMemos.save(rec);
    await queue.enqueue({ id, type: 'audio', blob: audioBlob, mimeType: audioBlob.type, durationMs });
    log('memo: queued audio blob (' + Math.round(audioBlob.size / 1024) + 'KB)');

    // Background waveform extraction
    voiceMemos.extractWaveform(audioBlob).then(bars => {
      if (card) {
        const anyCard = card as any;
        if (anyCard._setWaveform) anyCard._setWaveform(bars);
      }
      voiceMemos.update(id, { waveform: Array.from(bars) }).catch(() => {});
    }).catch(e => log('memo: waveform extract failed:', e.message));

    return { id, card };
  }

  async function handleMemoResult(audioBlob: Blob, durationMs?: number) {
    if (!audioBlob) return;
    // Always render the placeholder card + enqueue the blob, regardless
    // of connectivity. Matches the "user gets immediate visual feedback"
    // UX spec and keeps ONE processing path (flushOutbox) whether we're
    // online or offline.
    const { card } = await renderMemoCard(audioBlob, durationMs);

    const offline = navigator.onLine === false || !backend.isConnected();
    if (offline) {
      if (card) memoCard.update(card, { status: 'queued' });
      status.setStatus('Audio queued — will transcribe when connected');
      return;
    }

    // Single transcribe path: flushOutbox iterates the queue serially
    // (for/await loop + isFlushing mutex), calls /transcribe per item,
    // routes to composer / chat based on autoSend setting, updates the
    // card. Rapid-fire memos all land here — mutex serializes them so
    // composer-append order matches record order, no duplicates.
    //
    // Earlier architecture had a second "live" transcribeChain that
    // raced with this: both paths fetched /transcribe for the same
    // blob, both appended, producing duplicates ("1 1 2 3 2 3" pattern
    // the user reported). Now there's only one path.
    flushOutbox().catch(() => {});
  }

  if (btnMemo) {
    // Tracks whether streaming was active when memo started, so we can
    // auto-resume streaming after memo completes. Native-app-ish: user
    // was in a voice-conversation flow, tapped memo for a one-shot aside,
    // expects to be back in the flow when the aside is done.
    let resumeStreamingAfterMemo = false;
    btnMemo.onclick = async () => {
      if (memoActive) return;
      // Stop streaming if active — mic is exclusive. Remember so we can
      // resume after memo completes (memoActive → false path).
      resumeStreamingAfterMemo = listening;
      if (listening) stopStreaming();
      // Prime the iOS AVAudioSession the same way streaming does. Plays a
      // tiny silent MP3 through the <audio> element which wakes the
      // session so subsequent getUserMedia delivers real audio samples.
      // Without this, memo capture on iOS 18.5 can return a non-empty
      // blob full of silence after the app has been backgrounded — the
      // "audio system needs streaming to initialize" symptom the user hit
      // after leaving the phone on the counter while brushing teeth.
      // MUST run synchronously inside this click gesture.
      unlock(player);
      audioSession.primeMediaSink();
      memoActive = true;
      composerInput.style.display = 'none';
      btnMemo.style.display = 'none';
      updateSendButtonState();
      composerSend.onclick = async () => {
        if (composerSend.disabled) return;
        composerSend.disabled = true;
        try {
          const { audioBlob, durationMs } = await memo.stop();
          exitMemoMode();
          await handleMemoResult(audioBlob, durationMs);
          // Auto-resume streaming if that's where we came from.
          if (resumeStreamingAfterMemo) { resumeStreamingAfterMemo = false; startStreaming(); }
        } finally {
          composerSend.disabled = false;
        }
      };
      const composerEl = composerInput.parentElement;
      // Insert the recording bar where the textarea was — before the actions row.
      const composerActionsEl = composerEl?.querySelector('.composer-actions') as HTMLElement | null;
      // Hide the entire actions row during recording — the send button gets
      // relocated into the memo bar (WhatsApp-style), so the row would just
      // be a redundant second row of icons. Without this, composer height
      // doubles to ~102px during memo. Restored in exitMemoMode().
      if (composerActionsEl) composerActionsEl.style.display = 'none';
      const ok = await memo.start({
        container: composerEl,
        insertBefore: composerActionsEl || composerSend,
        // Move the send button into the bar so it sits at the right edge of
        // the recording row, like WhatsApp. memo.ts relocates the node;
        // exitMemoMode reparents it back to .composer-actions-right.
        sendBtn: composerSend,
        onDone: (audioBlob) => {
          exitMemoMode();
          handleMemoResult(audioBlob);
          if (resumeStreamingAfterMemo) { resumeStreamingAfterMemo = false; startStreaming(); }
        },
        onCancel: () => {
          exitMemoMode();
          if (resumeStreamingAfterMemo) { resumeStreamingAfterMemo = false; startStreaming(); }
        },
      });
      if (!ok) {
        exitMemoMode();
        status.setStatus('Mic not available', 'err');
        resumeStreamingAfterMemo = false;
      }
    };
    // Esc to cancel, Enter to send memo on desktop
    document.addEventListener('keydown', (e) => {
      if (!memoActive) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        memo.stop();
        // Click the trash button to properly clean up the bar
        const trash = document.querySelector('.memo-trash') as HTMLButtonElement | null;
        if (trash) trash.click();
        else exitMemoMode();
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        composerSend.click();
      }
    });

    // Push-to-talk on the memo button. Press-and-hold past the threshold
    // → enter memo mode (start recording). Release at any point after
    // → auto-send (per the existing dictationAutoSend setting, which
    // routes the transcript to composer or chat). Lets the user record
    // a quick message without two distinct taps; lifting the finger is
    // the send signal. A short tap (release before threshold) falls
    // through to the existing click-to-toggle behavior.
    const PTT_HOLD_MS = 250;
    let pttHoldTimer: ReturnType<typeof setTimeout> | null = null;
    let pttArmed = false;          // hold passed threshold → memo started by us
    let pttSuppressClick = false;  // swallow the click that pointerup would synthesize
    const pttRelease = (e: Event) => {
      if (pttHoldTimer) { clearTimeout(pttHoldTimer); pttHoldTimer = null; }
      if (!pttArmed) return;
      pttArmed = false;
      pttSuppressClick = true;
      // Defer the send by one tick so any async memo.start() initialization
      // queued from the threshold-fire has a chance to wire composerSend.onclick.
      // composerSend.click() invokes whatever onclick btnMemo's async handler
      // assigned (which awaits memo.stop() → handleMemoResult). If onclick
      // isn't set yet (rare — memo.start barely begun), the click is a no-op
      // and the user has to tap composerSend manually; not great but not lost.
      e.preventDefault();
      e.stopPropagation();
      setTimeout(() => composerSend.click(), 0);
    };
    btnMemo.addEventListener('pointerdown', (e) => {
      // Only arm PTT if memo isn't already active (avoids double-start
      // if the user is mid tap-to-record session and presses again).
      if (memoActive) return;
      pttArmed = false;
      pttSuppressClick = false;
      pttHoldTimer = setTimeout(() => {
        pttHoldTimer = null;
        // Threshold passed and finger still down → start the memo by
        // synthesizing a click. The existing onclick handler kicks off
        // memo.start() and wires composerSend.onclick for the eventual
        // stop-and-send. The flag tells pointerup to auto-send instead
        // of treating the release as a tap.
        pttArmed = true;
        btnMemo.click();
        // Add a class so we can style "PTT recording in progress"
        // distinctly from a tap-started recording — useful so the
        // user knows lifting the finger will send.
        const bar = document.querySelector('.memo-bar');
        if (bar) bar.classList.add('memo-bar-ptt');
      }, PTT_HOLD_MS);
    });
    btnMemo.addEventListener('pointerup', pttRelease);
    btnMemo.addEventListener('pointercancel', pttRelease);
    btnMemo.addEventListener('pointerleave', pttRelease);
    // The pointerup synthesizes a click. If we already triggered a click
    // at threshold (PTT path), the second click would re-fire the memo
    // toggle handler. Eat it once.
    btnMemo.addEventListener('click', (e) => {
      if (pttSuppressClick) {
        pttSuppressClick = false;
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true);  // capture phase to beat the existing onclick
  }

  // ── Refresh button (full page reload for standalone PWA) ──
  // Previously did a transport-rebind which had a confusing mental model
  // ("why didn't it actually refresh?"). Renamed to "Refresh" + now
  // does a real location.reload() — same as hitting browser-refresh on
  // desktop. With the SSE-detach proxy fix, server-side agent runs
  // outlive the reload, so refreshing mid-conversation no longer kills
  // an in-flight reply (the next request on the same conversation
  // chains via previous_response_id and picks up the reply).
  const btnRefresh = document.getElementById('btn-refresh');
  if (btnRefresh) {
    btnRefresh.onclick = () => {
      try { tts.stop('refresh'); } catch {}
      try { player.pause(); player.src = ''; player.load(); } catch {}
      diag('refresh: location.reload()');
      location.reload();
    };
  }

  log('page loaded, UA:', navigator.userAgent);
}

// ─── Session resume (drawer tap) ────────────────────────────────────────────

/** Replay a transcript into the chat UI after the adapter resumes a session.
 *  Clears current chat + replyCache, re-renders the messages, and marks
 *  history as loaded so backfillHistory doesn't double-append. */
function replaySessionMessages(
  id: string,
  messages: any[],
  pagination?: { firstId: number | null; hasMore: boolean }
) {
  chat.clear();
  replyCache.clear();
  voice.cancelPendingFlush();
  pendingReply = null;
  historyLoaded = true;  // we just populated history ourselves; skip backfill
  // Tell the drawer which session is ACTUALLY on screen — covers edge
  // cases where the adapter's conversationName diverges from what the
  // user is reading (superseded tokens, failed resumes, boot paths).
  sessionDrawer.setViewed(id);
  // Refresh server-side session list — handleReplyFinal also refreshes
  // when a turn completes, but if the user switches sessions mid-flight
  // (which aborts the SSE stream client-side), response.completed never
  // arrives here even though the server keeps computing + persisting.
  // Refreshing on switch catches that case so a now-persisted-but-not-
  // yet-shown session appears in the drawer without a page reload.
  sessionDrawer.refresh();
  // Persist the session id into the chat snapshot so a page reload can
  // re-seed the drawer highlight to this session even though adapter
  // state (conversationName) resets to default on reload.
  chat.trackViewedSession(id);
  viewedSessionForLoadEarlier = id;
  const label = getAgentLabel();
  for (const m of messages) {
    renderHistoryMessage(m, label);
  }
  // Register pagination state AFTER messages land so the scroll listener
  // doesn't fire mid-render. hasMore=false (or missing) disables lazy-load.
  chat.setPaginationState(pagination?.firstId ?? null, !!pagination?.hasMore);
  chat.forceScrollToBottom();
}

/** Shared rendering for both initial replay (append) and load-earlier
 *  (prepend, batched). The caller owns scroll behavior + persist. */
function renderHistoryMessage(m: any, label: string, mode: 'append' | 'prepend' = 'append') {
  const raw = (m.content || '').trim();
  // Same stripper as the live delta path — hides Gemma reasoning-tag
  // leftovers ("thought" / "thinking" / "reasoning" bare words) from
  // historical replay.
  const text = stripReasoningLeak(raw);
  if (!text) return;
  // Hermes state.db stores timestamp as float UNIX seconds. chat.addLine's
  // formatTime passes through new Date(ts) which expects milliseconds, so
  // without the *1000 it'd render 1970. If ts is already >= 1e12 it's
  // probably ms already (openclaw / openai-compat backends), so pass
  // through unchanged.
  const rawTs = m.timestamp || m.created_at || m.at;
  const ts = typeof rawTs === 'number' && rawTs < 1e12 ? rawTs * 1000 : rawTs;
  const prepend = mode === 'prepend';
  if (m.role === 'assistant') {
    if (NO_REPLY_RE.test(text)) return;
    chat.addLine(label, text, 'agent', { markdown: true, timestamp: ts, prepend, batch: prepend });
  } else if (m.role === 'user') {
    chat.addLine('You', text, 's0', { timestamp: ts, prepend, batch: prepend });
  }
  // Tool role / system role: skip for now; UI has no slot for them.
}

/** Session id the chat is currently viewing — used by the load-earlier
 *  callback so it knows which session to fetch older messages for.
 *  Updated by replaySessionMessages. */
let viewedSessionForLoadEarlier: string | null = null;

async function loadEarlierHistory(beforeId: number) {
  const id = viewedSessionForLoadEarlier;
  if (!id) return;
  const result: any = await backend.loadEarlier(id, beforeId);
  const older = result.messages || [];
  if (!older.length) {
    chat.setPaginationState(null, false);
    return;
  }
  const label = getAgentLabel();
  chat.prependHistory(() => {
    // Iterate oldest→newest. Each prepend inserts at firstChild, so the
    // LAST call ends up topmost — which is what we want since older
    // messages should sit above newer ones that were already on screen.
    // (The returned `messages` array is chronological oldest→newest.)
    for (let i = older.length - 1; i >= 0; i--) {
      renderHistoryMessage(older[i], label, 'prepend');
    }
  });
  chat.setPaginationState(result.firstId ?? null, !!result.hasMore);
}

// ─── Session history backfill ────────────────────────────────────────────────

let historyLoaded = false;
/** In-flight backfill promise. The plain `historyLoaded` bool wasn't
 *  enough in practice — field logs showed triple-backfill runs on a
 *  single page load (same session key), and the only way that happens
 *  is concurrent entry between the sync guard and the fetchHistory
 *  await. The promise single-flight pattern also returns the same
 *  completion handle to overlapping callers so they await the same
 *  work rather than starting their own fetch. */
let backfillInFlight: Promise<void> | null = null;

async function backfillHistory() {
  if (historyLoaded) { diag('backfill: skip (already loaded)'); return; }
  if (backfillInFlight) { diag('backfill: awaiting in-flight run'); return backfillInFlight; }
  backfillInFlight = (async () => {
    historyLoaded = true;

    // Defensive dedupe: if the transcript already has content (e.g. restored
    // from the IDB snapshot), collect existing text to skip duplicates.
    // Agent bubbles store raw markdown in data-text; `.text` textContent is
    // rendered. Include both so backfill's raw-markdown text matches either.
    const transcriptEl = document.getElementById('transcript');
    const existingTexts = new Set();
    if (transcriptEl) {
      transcriptEl.querySelectorAll<HTMLElement>('.line').forEach(line => {
        const rendered = line.querySelector('.text')?.textContent?.trim();
        if (rendered) existingTexts.add(rendered);
        const raw = line.dataset.text?.trim();
        if (raw) existingTexts.add(raw);
      });
    }

    const messages = await backend.fetchHistory(50);
    if (!messages.length) return;
    log(`backfilling ${messages.length} history messages`);

    // Adapter already stripped adapter-specific conventions (openclaw's
    // "[voice]" prefix, internal system messages, etc.). Shell just displays.
    let appended = 0;
    for (const msg of messages) {
      const text = msg.text
        || (Array.isArray(msg.content) ? msg.content.find((c) => c?.type === 'text')?.text : '')
        || '';
      if (!text) continue;
      if (existingTexts.has(text.trim())) continue;
      const timestamp = msg.timestamp || msg.created_at || msg.at;

      if (msg.role === 'assistant') {
        if (NO_REPLY_RE.test(text)) continue;
        chat.addLine(getAgentLabel(), text, 'agent', { markdown: true, timestamp });
        appended++;
      } else if (msg.role === 'user') {
        chat.addLine('You', text, 's0', { timestamp });
        appended++;
      }
    }
    diag(`backfill: appended ${appended}/${messages.length} (${messages.length - appended} deduped)`);

    // Initial history backfill — always jump to latest regardless of
    // pinned state (user just loaded the app).
    chat.forceScrollToBottom();
  })();
  try { await backfillInFlight; }
  finally { backfillInFlight = null; }
}

// ─── Streaming indicator — shows partial text while agent is thinking ────────

let streamingEl = null;
let streamingIdleTimer = null;

/** Max time we'll leave a "thinking…" / streaming box on screen with no new
 *  events before assuming the reply is stuck. 90s is generous — tool calls
 *  (calendar scans, web fetches) can run long before any text arrives. */
const STREAMING_IDLE_TIMEOUT_MS = 90_000;

/** Create a tentative "the agent is working on it" bubble. Fired the instant
 *  the user sends a message, BEFORE any backend events arrive. Prevents the
 *  silent-chat problem where the agent jumps straight to tool calls without
 *  streaming text first — user would otherwise stare at a blank screen and
 *  wonder if anything happened.
 *
 *  On the first onDelta, `showStreamingIndicator` transitions this bubble
 *  into the real streaming reply (adopts a fresh replyId, populates text,
 *  wires the play-bar + TTS event stream). On onFinal with empty text or
 *  a 90s no-event timeout, `clearStreamingIndicator` removes it. */
function showThinking() {
  const transcriptEl = document.getElementById('transcript');
  if (!transcriptEl) return;
  // Defensive: if streamingEl ref got orphaned (DOM wiped by a clear()
  // elsewhere, or we somehow held a stale reference), drop it before
  // the guard check so the user still sees a fresh indicator on their
  // next send.
  if (streamingEl && !streamingEl.isConnected) streamingEl = null;
  if (streamingEl) return;  // already showing; don't stack
  // Also sweep any orphan streaming bubbles that escaped finalization —
  // rare but observed when an interrupt aborts a stream mid-flight,
  // leaving the prior bubble in the DOM while streamingEl got nulled by
  // the subsequent flow. Invariant: at most one streaming bubble visible.
  transcriptEl.querySelectorAll('.line.streaming').forEach(el => el.remove());
  // Use a temporary replyId so the bubble has a data-reply-id from the
  // start (needed for dedup / DOM lookup); will be swapped out by the
  // adapter's real id on first delta.
  const tempId = `r-pending-${Date.now()}`;
  streamingEl = chat.addLine(getAgentLabel(), '', 'agent streaming pending', {
    markdown: true,
    replyId: tempId,
  });
  if (streamingEl) {
    const dots = document.createElement('span');
    dots.className = 'thinking-dots';
    dots.textContent = 'sending…';
    streamingEl.appendChild(dots);
  }
  chat.autoScroll();
  if (streamingIdleTimer) clearTimeout(streamingIdleTimer);
  streamingIdleTimer = setTimeout(clearStreamingIndicator, STREAMING_IDLE_TIMEOUT_MS);
}

/** Activity signal from the backend — positive evidence that the agent
 *  has acknowledged our send and is actively working. Transitions the
 *  thinking bubble from "sending…" (optimistic, .pending class) to
 *  "thinking…" / "using <tool>…" (confirmed, bright dots). Fires on
 *  every incremental activity event; we just update the label, the
 *  streamingEl / replyId swap happens in showStreamingIndicator. */
function handleActivity({ working, detail, conversation }: any) {
  // Drop activity updates for off-screen conversations (user has switched
  // to a different session mid-stream; the old conversation's "thinking"
  // shouldn't render here).
  if (conversation && conversation !== sessionDrawer.getViewed()) return;
  if (!streamingEl) return;
  streamingEl.classList.remove('pending');
  const dots = streamingEl.querySelector('.thinking-dots');
  if (!dots || !working) return;
  if (dots.classList.contains('hidden')) return;  // text already populated
  // Friendly labels for common tools; generic "using X" for anything else.
  let label = 'thinking…';
  if (detail === 'streaming') label = 'thinking…';
  else if (detail === 'canvas.show') label = 'sharing card…';
  else if (detail && detail !== 'tool') label = `using ${detail}…`;
  else if (detail === 'tool') label = 'using tool…';
  dots.textContent = label;
  // Reset idle timer on every real signal — an active agent shouldn't
  // time out while it's visibly working.
  if (streamingIdleTimer) clearTimeout(streamingIdleTimer);
  streamingIdleTimer = setTimeout(clearStreamingIndicator, STREAMING_IDLE_TIMEOUT_MS);
}

/** Show or update the in-flight agent bubble. Called on onDelta events.
 *  If showThinking() already created a tentative bubble, this upgrades it
 *  in place — adopts the real replyId + populates text. Otherwise creates
 *  a fresh bubble (e.g. agent-initiated messages where there was no user
 *  send to trigger the thinking bubble). */
function showStreamingIndicator(partialText, replyId) {
  const transcriptEl = document.getElementById('transcript');
  if (!transcriptEl) return;

  // Drop the ref if it got orphaned from the DOM (see showThinking).
  if (streamingEl && !streamingEl.isConnected) streamingEl = null;

  if (!streamingEl) {
    // Sweep any stragglers before creating a new bubble — one streaming
    // indicator at a time, no exceptions.
    transcriptEl.querySelectorAll('.line.streaming').forEach(el => el.remove());
    streamingEl = chat.addLine(getAgentLabel(), partialText || '', 'agent streaming', {
      markdown: true,
      replyId,
    });
    if (streamingEl) {
      const dots = document.createElement('span');
      dots.className = 'thinking-dots';
      dots.textContent = 'thinking…';
      if (partialText) dots.classList.add('hidden');
      streamingEl.appendChild(dots);
    }
  } else {
    // Pending-thinking bubble exists — adopt real id + strip pending class.
    streamingEl.classList.remove('pending');
    streamingEl.dataset.replyId = replyId;
    if (partialText) {
      const textSpan = streamingEl.querySelector('.text');
      if (textSpan) textSpan.innerHTML = miniMarkdown(partialText);
      streamingEl.dataset.text = partialText;
      const dots = streamingEl.querySelector('.thinking-dots');
      if (dots) dots.classList.add('hidden');
    }
  }
  chat.autoScroll();

  // Safety net: if a reply gets stuck with no more events, auto-clear.
  if (streamingIdleTimer) clearTimeout(streamingIdleTimer);
  streamingIdleTimer = setTimeout(clearStreamingIndicator, STREAMING_IDLE_TIMEOUT_MS);
}

/** Promote the streaming bubble to its final form: update text, remove
 *  thinking dots, strip the .streaming class, open links in new tabs.
 *  Returns the bubble element (already in the DOM) or null if no
 *  streaming bubble existed. */
function finalizeStreamingBubble(finalText) {
  if (streamingIdleTimer) { clearTimeout(streamingIdleTimer); streamingIdleTimer = null; }
  if (!streamingEl) return null;
  const textSpan = streamingEl.querySelector('.text');
  if (textSpan) textSpan.innerHTML = miniMarkdown(finalText);
  streamingEl.dataset.text = finalText;
  const dots = streamingEl.querySelector('.thinking-dots');
  if (dots) dots.remove();
  streamingEl.classList.remove('streaming');
  streamingEl.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
  const el = streamingEl;
  streamingEl = null;
  return el;
}

function clearStreamingIndicator() {
  if (streamingIdleTimer) { clearTimeout(streamingIdleTimer); streamingIdleTimer = null; }
  if (streamingEl) {
    streamingEl.remove();
    streamingEl = null;
  }
  // Invariant: streamingTtsReplyId is the id of the current streamingEl.
  // When the bubble is gone, drop the id too (and any in-flight TTS for
  // it) so the next reply's first delta mints a fresh id. Forgetting
  // this caused multiple bubbles to end up sharing a stale id, which
  // made play-click route to the wrong reply via the activeReply match.
  if (streamingTtsReplyId) {
    try { tts.stop('stream-cleared'); } catch {}
    streamingTtsReplyId = null;
  }
}

/** Find the most-recent non-streaming agent bubble and attach a card.
 *  Falls back to the active streaming bubble if there's no finalized
 *  agent reply yet. */
function attachCardToLatestAgentBubble(card) {
  const el = document.getElementById('transcript');
  if (!el) return;
  const bubbles = Array.from(
    el.querySelectorAll('.line.agent[data-reply-id]:not(.streaming)')
  ) as HTMLElement[];
  const target = bubbles[bubbles.length - 1] || streamingEl;
  if (!target) {
    log('attachCard: no agent bubble to attach to — dropping card', card.kind);
    return;
  }
  attachCard(target, card);
}

// ─── Backend event handlers ─────────────────────────────────────────────────
// Normalized per-event handlers. Shell logic only — the backend adapter
// handles wire-format parsing. Events not surfaced by the adapter (agent
// lifecycle, heartbeat, etc.) don't reach us by design.

/** Streaming partial reply. `cumulativeText` is the full text so far.
 *  Adapter already drops user-echo prefix variants so we don't need to
 *  defensively filter them here. */
/** FIFO-queue state for Bug 3: when autoAdvanceOnNew=false (default),
 *  a new reply that arrives while TTS is still playing gets its bubble
 *  and chime as normal, but the actual speech is buffered here. When
 *  the current reply finishes (tts 'ended' or 'stopped'), drain kicks
 *  off playback of the deferred one.
 *
 *  Single-slot queue — if a 3rd reply arrives while #2 is deferred,
 *  the latest replaces (user isn't usefully served by infinite stacking
 *  on a bike). replyId + done flag let the drain decide whether we can
 *  start with full text (tts.speak) or need to stream. For MVP we only
 *  drain when done=true; pre-done drain would need chunk re-routing.
 */
let pendingReply: { replyId: string, text: string, done: boolean } | null = null;

function ttsActiveForStreaming() {
  return settings.get().tts && settings.get().ttsEngine !== 'local';
}

function shouldDeferReply() {
  return !settings.get().autoAdvanceOnNew && tts.isSpeaking() && ttsActiveForStreaming();
}

function drainPendingReply() {
  if (!pendingReply || !pendingReply.done) return;
  if (tts.isSpeaking()) return;  // something else started speaking; wait
  const p = pendingReply;
  pendingReply = null;
  if (ttsActiveForStreaming()) {
    tts.speak(p.text, { replyId: p.replyId });
  }
}

function handleReplyDelta({ replyId, cumulativeText, conversation }: any) {
  if (!cumulativeText) return;
  // Drop deltas for off-screen conversations. Server-side stream keeps
  // running; user can switch back later and the persisted reply will
  // appear via replaySessionMessages.
  if (conversation && conversation !== sessionDrawer.getViewed()) return;

  // FIFO-queue fast path: if a previous reply is still playing and
  // we're in FIFO mode, render the bubble + chime as usual but buffer
  // the speech. The existing bubble infra treats streamingTtsReplyId
  // staying null the same as TTS-off — visible text, no audio yet.
  if (pendingReply && pendingReply.replyId === replyId) {
    // Continuation of an already-buffered reply.
    showStreamingIndicator(cumulativeText, replyId);
    pendingReply.text = cumulativeText;
    return;
  }
  // First delta of a new reply-id. Two FIFO cases to handle here:
  //   (a) Nothing streaming and we're still speaking → defer.
  //   (b) Already streaming/deferring a prior reply AND a NEW replyId
  //       arrives → user sent another message. Latest wins: clear the
  //       pending buffer and let the new one go through the normal
  //       interrupt path. Prevents a 3rd reply from silently orphaning.
  const isNewReplyId = streamingTtsReplyId !== replyId
    && (!streamingEl || streamingEl.dataset.replyId !== replyId)
    && pendingReply?.replyId !== replyId;
  if (isNewReplyId && !streamingEl && shouldDeferReply()) {
    showStreamingIndicator(cumulativeText, replyId);
    pendingReply = { replyId, text: cumulativeText, done: false };
    playFeedback('receive');
    return;
  }
  if (isNewReplyId && pendingReply) {
    // 3rd-reply arrival: drop the queued 2nd, let this one run normally.
    diag(`fifo: dropping queued reply ${pendingReply.replyId} — newer ${replyId} arrived`);
    pendingReply = null;
  }

  // "First delta" is not just !streamingEl — showThinking() may have
  // already created a pending bubble (r-pending-<ts> id). That bubble
  // needs to adopt the real replyId AND trigger tts.beginReply the
  // same way a from-scratch bubble would. Without this, the else
  // branch fires with streamingTtsReplyId=null, which sets
  // dataset.replyId=undefined — later replies collide on empty ids
  // and play-click routing sends clicks from ANY bubble to the most
  // recent actively-streaming one. That's the regression symptom.
  const pendingShell = streamingEl
    && typeof streamingEl.dataset.replyId === 'string'
    && streamingEl.dataset.replyId.startsWith('r-pending-');
  const isFirstDelta = !streamingEl || pendingShell;

  if (isFirstDelta) {
    if (streamingTtsReplyId) {
      try { tts.stop('stream-reset'); } catch {}
      streamingTtsReplyId = null;
    }
    showStreamingIndicator(cumulativeText, replyId);
    // Gate the streaming-TTS pipeline on engine==='server'. Local TTS
    // can't chunk-stream; it degrades to one-shot speak() on final.
    if (settings.get().tts && settings.get().ttsEngine !== 'local') {
      tts.beginReply({ replyId });
      streamingTtsReplyId = replyId;
    }
  } else {
    showStreamingIndicator(cumulativeText, streamingTtsReplyId);
  }
  if (streamingTtsReplyId) tts.pushReplyText(cumulativeText);
}

/** Complete reply. `content` (if present) is the raw block array used to
 *  pull out image attachments. */
function handleReplyFinal({ replyId, text, content = [], conversation }: any) {
  // A completed turn means hermes has persisted this response to
  // response_store.db (+ state.db/sessions gets the derived entry). If
  // this was the first turn of a brand-new session, the drawer's
  // placeholder row needs to be replaced with the real row — trigger a
  // refresh. Background fetch will repopulate the cached list.
  // ALWAYS refresh the drawer, even when the reply belongs to an
  // off-screen conversation — that's the whole point of letting the
  // stream complete in the background: the user needs the row to find.
  sessionDrawer.refresh();

  // If the user switched to a different session mid-stream, swallow the
  // chat-bubble render here; the reply IS persisted server-side and
  // will appear via replaySessionMessages when they switch back. Side
  // effects above (drawer refresh) already fired.
  if (conversation && conversation !== sessionDrawer.getViewed()) {
    if (pendingReply?.replyId === replyId) pendingReply = null;
    return;
  }

  const imageBlocks = extractImageBlocks(content);

  if (NO_REPLY_RE.test(text)) {
    log('suppressed NO_REPLY from agent');
    clearStreamingIndicator();
    if (pendingReply?.replyId === replyId) pendingReply = null;
    return;
  }

  // FIFO-queue branch: this reply was deferred during streaming. Update
  // the bubble with the final text + mark the buffer done + try to
  // drain. No 'receive' chime — we already played it on the first
  // deferred delta. No tts calls — drainPendingReply owns that.
  if (pendingReply && pendingReply.replyId === replyId) {
    if (text) {
      let bubble = finalizeStreamingBubble(text);
      if (!bubble) {
        bubble = chat.addLine(getAgentLabel(), text, 'agent', { markdown: true, replyId });
      }
      try {
        const cards = parseCardsFromText(text);
        for (const c of cards) attachCard(bubble, c);
      } catch (e) { log('card parse err:', e.message); }
      for (const b of imageBlocks) attachCard(bubble, b);
      pendingReply.text = text;
      pendingReply.done = true;
      drainPendingReply();
      // New reply landed → advance the BT track pointer to it. Mirrors
      // "default to latest" UX: a fresh user interaction puts BT next/prev
      // in the most-recent context. User-driven prev navigation later
      // explicitly setTrackPointer to where they want it.
      setTrackPointer(replyId);
    } else {
      pendingReply = null;
    }
    return;
  }

  if (text) {
    let bubble = finalizeStreamingBubble(text);
    if (!bubble) {
      const fallbackId = streamingTtsReplyId || replyId;
      bubble = chat.addLine(getAgentLabel(), text, 'agent', { markdown: true, replyId: fallbackId });
    }
    // Advance BT track pointer to the new reply (this is the non-pending
    // path — matches the same behavior as the pending-drain block above).
    const finalizedId = bubble?.dataset.replyId || streamingTtsReplyId || replyId;
    if (finalizedId) setTrackPointer(finalizedId);
    playFeedback('receive');

    try {
      const cards = parseCardsFromText(text);
      for (const c of cards) attachCard(bubble, c);
    } catch (e) { log('card parse err:', e.message); }

    for (const b of imageBlocks) attachCard(bubble, b);

    if (settings.get().tts) {
      if (streamingTtsReplyId) {
        tts.endReply(text);
        streamingTtsReplyId = null;
      } else {
        const bubbleReplyId = bubble?.dataset?.replyId;
        tts.speak(text, { replyId: bubbleReplyId });
      }
    } else {
      // TTS output muted — don't synthesize the full reply (wastes
      // Aura quota + bandwidth for audio the user never hears). Do
      // precache the first chunk so if the user changes their mind
      // and clicks play, audio starts in ~500ms instead of ~3-5s.
      // Remaining chunks synthesize on demand inside playCached.
      const bubbleReplyId = bubble?.dataset?.replyId;
      if (bubbleReplyId) tts.precacheFirstChunk(bubbleReplyId, text).catch(() => {});
    }
  } else if (imageBlocks.length) {
    clearStreamingIndicator();
    for (const b of imageBlocks) attachCardToLatestAgentBubble(b);
  } else {
    clearStreamingIndicator();
  }
}

/** Tool-events — cards and similar side-channel data the agent emits.
 *  Currently just canvas.show; grows as backends add more. */
function handleToolEvent({ kind, payload, conversation }: any) {
  // Drop tool-event renders for off-screen conversations.
  if (conversation && conversation !== sessionDrawer.getViewed()) return;
  if (kind === 'canvas.show' && payload) {
    log('canvas.show event from agent');
    attachCardToLatestAgentBubble(payload);
  }
}

// ─── Go ─────────────────────────────────────────────────────────────────────

boot().catch(err => {
  console.error('SideKick boot failed:', err);
  document.body.textContent = `Boot error: ${err.message}`;
});
