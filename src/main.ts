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
import { unlock, getAudioCtx } from './ios/audio-unlock.ts';
import * as audioSession from './audio/session.ts';
import * as capture from './audio/capture.ts';
import * as fakeLock from './ios/fakeLock.ts';
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
import * as webrtcControls from './pipelines/webrtc/controls.ts';
import * as webrtcConnection from './pipelines/webrtc/connection.ts';
import * as webrtcDictation from './pipelines/webrtc/dictation.ts';
import * as webrtcDictate from './pipelines/webrtc/dictate.ts';
import * as webrtcSuppress from './pipelines/webrtc/suppress.ts';
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

let memoActive = false;  // true while voice-memo recording bar is shown

// releaseCaptureIfActive is defined as a closure inside boot() so it can
// close the WebRTC peer connection cleanly when slash-commands or other
// reset paths fire.
let releaseCaptureIfActive: () => void = () => {};

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
  // Hydrate localStorage settings BEFORE any UI wiring reads them. Earlier
  // settings.load() lived ~300 lines down in boot, after toolbar wiring,
  // which made btn-transport's sync() read DEFAULTS instead of the stored
  // value — the toggle would flip in storage but the highlight wouldn't
  // reflect it. Generally: any boot code that calls settings.get() before
  // this line was reading uninitialised defaults.
  settings.load();

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
  // + silent keepalive. BT taps map to play/pause handlers; in WebRTC mode
  // these toggle the active call (mic stream / talk) on or off.
  audioSession.init({
    onPlay: () => {
      // BT play: open or resume a call. If one is already open, no-op.
      // We click the unified composer mic so the BT gesture goes through
      // the same dispatch path as a tap (respects the user's three
      // toggles — call/PTT/auto-send).
      if (webrtcControls.isOpen()) return;
      const btnMicEl = document.getElementById('btn-mic');
      if (btnMicEl) btnMicEl.click();
    },
    onPause: () => {
      // BT pause: close the active call.
      if (webrtcControls.isOpen()) {
        void webrtcControls.closeIfOpen();
      }
    },
    onStop: () => {
      // BT explicit stop: same as pause for now — close the call.
      if (webrtcControls.isOpen()) {
        void webrtcControls.closeIfOpen();
      }
    },
    onForeground: () => {
      // No-op: WebRTC peer connection auto-recovers via ICE; classic-mode's
      // SR-recovery hop isn't needed.
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
      listening: webrtcControls.isOpen() && webrtcControls.currentMode() === 'stream',
      speaking: webrtcControls.isOpen() && webrtcControls.currentMode() === 'talk',
      modelLabel: (() => {
        const e = settings.getCurrentModelEntry?.();
        if (!e) return '';
        return (e.name || e.id).replace(/^openrouter\//, '').split('/').slice(-1)[0];
      })(),
    }),
    // Pocket-lock prev/next: no-ops with the per-turn replay machinery
    // gutted. Wired to () => {} so fakeLock.ts's button handlers don't
    // crash on undefined callbacks; CSS hides the buttons in the
    // post-replay world but the call sites still fire.
    onPrev: () => {},
    onNext: () => {},
  });
  const btnLock = document.getElementById('btn-lock');
  if (btnLock) btnLock.onclick = () => fakeLock.show();

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
  // Sidebar-top search button → opens the cmd+K palette. Lives next to
  // the hamburger as the rightmost icon in .sidebar-top-row (Gemini-style
  // header). Replaces the old inline magnifier that used to sit beside
  // the filter input.
  const sbSearch = document.getElementById('sb-search');
  if (sbSearch) sbSearch.onclick = (e) => { e.preventDefault(); cmdkPalette.open(); };

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

  // Settings
  settings.load();
  settings.applyVisuals();
  settings.hydrate({
    onThemeChange: () => theme.applyTheme(settings.get().theme),
    onVoiceChange: () => {
      // Voice change: takes effect on the next WebRTC talk-mode call
      // (server-side TTS provider reads its config). No client-side cache
      // to invalidate now that per-turn replay is gone.
    },
    onMicChange: () => {
      // If a WebRTC call is open, close it so the new device picks up on
      // the next open. (Live device-swap on a peer connection is finicky;
      // simpler to bounce.)
      if (webrtcControls.isOpen()) void webrtcControls.closeIfOpen();
    },
    onStreamingEngineChange: () => {
      // STT engine selection now lives entirely server-side under the
      // hermes voice-config. Client-side flip is a no-op for WebRTC.
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
    onAutoSendChange: () => {},
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

  // Global hotkeys. Alt+M toggles the WebRTC stream call; Alt+T toggles
  // talk mode. Esc closes an open settings or info panel.
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

    // Alt+M: toggle the unified composer mic. `e.code` survives Mac's
    // Alt+key → µ remapping. Fires even from within text inputs — the
    // intent to start voice input is explicit enough that composer
    // focus shouldn't eat it.
    if (e.altKey && e.code === 'KeyM') {
      e.preventDefault();
      document.getElementById('btn-mic')?.click();
      return;
    }

    // Alt+T: toggle Talk-mode WebRTC call (full-duplex with TTS).
    if (e.altKey && e.code === 'KeyT') {
      e.preventDefault();
      document.getElementById('btn-speak')?.click();
      return;
    }
  });
  draft.init({
    transcriptEl,
    onChange: updateSendButtonState,
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

  // The legacy <audio id="player"> element survives in the DOM as a
  // generic media-source anchor for the audio session; classic-mode TTS
  // playback was wired into it but is gone now. WebRTC creates its own
  // <audio> element on pc.ontrack inside connection.ts.
  const player = document.getElementById('player') as HTMLAudioElement;

  // Register card kinds — inline attachments on agent bubbles.
  [imageCard, youtubeCard, spotifyCard, linksCard, markdownCard, loadingCard]
    .forEach(registerCard);

  // Ambient clock + weather — floating pill in lower-right on desktop,
  // hidden via CSS on mobile (single media query).
  ambient.init();

  // Fast tooltips: native HTML `title` triggers a slow ~1.5-3s browser
  // tooltip. We render our own tooltip element directly under <body>
  // (NOT as a pseudo-element of the target) so it can't be clipped by
  // any ancestor stacking-context, transform, overflow:hidden, or
  // z-index ceiling. Position is computed from getBoundingClientRect
  // each time, with auto-flip above/below based on viewport edges.
  //
  // closest('[title]') matters: hovering over an SVG / path child of
  // a button lands the event on the child, which has no `title`.
  // Without the walk-up, those buttons fall back to the native
  // ~1.5s tooltip. closest() finds the button up the tree.
  const TOOLTIP_DELAY_MS = 300;
  let tipEl: HTMLDivElement | null = null;
  let tipTarget: HTMLElement | null = null;
  let tipShowTimer: number | null = null;
  function clearShowTimer() {
    if (tipShowTimer != null) {
      clearTimeout(tipShowTimer);
      tipShowTimer = null;
    }
  }
  function hideTip() {
    clearShowTimer();
    if (tipEl) { tipEl.remove(); tipEl = null; }
    tipTarget = null;
  }
  function showTip(target: HTMLElement, text: string) {
    if (tipEl) tipEl.remove();
    const el = document.createElement('div');
    el.className = 'app-tooltip';
    el.textContent = text;
    document.body.appendChild(el);
    const r = target.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    let top = r.top - er.height - 6;
    if (top < 4) {
      el.classList.add('below');
      top = r.bottom + 6;
    }
    let left = r.left + r.width / 2 - er.width / 2;
    if (left < 4) left = 4;
    if (left + er.width > window.innerWidth - 4) {
      left = window.innerWidth - 4 - er.width;
    }
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
    tipEl = el;
    tipTarget = target;
  }
  document.body.addEventListener('mouseover', (e) => {
    const t = (e.target as HTMLElement | null)?.closest?.('[title]') as HTMLElement | null;
    if (!t) return;
    if (t === tipTarget) return;  // already scheduled / shown
    const v = t.getAttribute('title');
    if (!v) return;
    // Suppress native tooltip while ours pends.
    t.setAttribute('data-tip', v);
    t.removeAttribute('title');
    clearShowTimer();
    tipShowTimer = window.setTimeout(() => {
      tipShowTimer = null;
      showTip(t, v);
    }, TOOLTIP_DELAY_MS) as unknown as number;
  }, true);
  document.body.addEventListener('mouseout', (e) => {
    const t = (e.target as HTMLElement | null)?.closest?.('[data-tip]') as HTMLElement | null;
    if (!t) return;
    const related = (e as MouseEvent).relatedTarget as Node | null;
    if (related && t.contains(related)) return;  // moving within the same tipped element
    const v = t.getAttribute('data-tip');
    if (v) { t.setAttribute('title', v); t.removeAttribute('data-tip'); }
    if (tipTarget === t || tipShowTimer != null) hideTip();
  }, true);
  // Hide tip on scroll/resize since the bounding rect we computed is stale.
  window.addEventListener('scroll', hideTip, true);
  window.addEventListener('resize', hideTip);
  // Hide tip on any pointerdown / touchstart — iOS synthesizes mouseover
  // from a tap, so a tap on (e.g.) the pocket-lock button schedules the
  // tooltip; by the time it fires 300ms later, the button's action has
  // launched (lockscreen overlay) and the tooltip ends up rendered on
  // top of it. Pointer / touch events fire BEFORE the synthesized mouse
  // events on tap, so killing the tooltip here lands ahead of any
  // schedule.
  window.addEventListener('pointerdown', hideTip, true);
  window.addEventListener('touchstart', hideTip, { capture: true, passive: true });

  // Drive the mic-button peak indicator on the composer mic (the
  // toolbar #btn-mic is gone; the composer mic is now the single
  // voice-input affordance). Smooth raw worklet peaks with a light
  // exponential filter so the CSS var eases between frames.
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
    onNotification: handleNotification,
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

  // ── Speak button (WebRTC TTS preference) ──────────────────────────────
  //   btn-speak = TTS-reply preference (settings.tts). Drives whether
  //               an open call ships TTS audio (talk mode) or just
  //               STT-only (stream mode).
  //
  // The unified composer mic owns the call open/close lifecycle —
  // see the composer-mic dispatch wiring further down. controls.ts
  // exports toggleCall / openCall / closeIfOpen for the dispatcher
  // to invoke.
  const btnSpeak = document.getElementById('btn-speak');

  webrtcControls.init({
    getSessionId: () => sessionDrawer.getViewed() || backend.getCurrentSessionId?.() || null,
    onStatus: (msg, kind) => status.setStatus(msg, kind ?? null),
  });

  // WebRTC data-channel events: parallel text path that surfaces
  // user-speech transcripts and assistant reply deltas as the call
  // proceeds.
  //
  // User finals are NOT immediately rendered as bubbles any more — the
  // bridge sends every is_final, but the PWA owns the dispatch trigger
  // (silence timer + commit-phrase) via webrtcDictation. The user
  // bubble renders once per dispatch (one utterance = one bubble), set
  // up below via setUserBubbleHandler.
  let dcAssistantStreamingId: string | null = null;
  // Streaming user bubble for live dictation. Created on first interim
  // of a new utterance; updated as interims/finals arrive; finalized
  // on dispatch (drop streaming class, set text to dispatched utterance).
  // Replaces the old composer-interim caption strip — the bubble lives
  // inline in chat so the user sees their words land in the conversation
  // surface as they speak.
  let dcUserStreamingId: string | null = null;
  // Joined is_final segments for the in-progress utterance. Mirrors
  // dictation.ts's buffer; we keep our own copy so the bubble can show
  // bufferedFinals + currentInterim without poking dictation internals.
  let dcUserBufferedFinals = '';
  function userBubbleEl(): HTMLElement | null {
    if (!dcUserStreamingId) return null;
    return document.querySelector(
      `.line[data-reply-id="${CSS.escape(dcUserStreamingId)}"]`,
    ) as HTMLElement | null;
  }
  function ensureUserBubble(initial: string): HTMLElement | null {
    if (!dcUserStreamingId) {
      dcUserStreamingId = `dc-u-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      chat.addLine('You', initial, 's0 streaming', {
        source: 'voice',
        replyId: dcUserStreamingId,
      });
    }
    return userBubbleEl();
  }
  function setUserBubbleText(text: string): void {
    const el = userBubbleEl();
    if (!el) return;
    const span = el.querySelector('.text') as HTMLElement | null;
    if (span) span.textContent = text;
  }
  webrtcDictation.setOnResetHandler(() => {
    // Call closed (or reopened) — drop any in-flight streaming state so
    // the next utterance starts a fresh bubble. If a streaming bubble
    // is still around at reset time, it means dispatch never fired for
    // it (otherwise setUserBubbleHandler would have cleared the id) —
    // i.e. the user toggled stream off mid-utterance. Remove the orphan
    // entirely; no agent reply is coming for it. Dispatched bubbles
    // already have dcUserStreamingId=null and are unaffected.
    const el = userBubbleEl();
    if (el) el.remove();
    dcUserStreamingId = null;
    dcUserBufferedFinals = '';
  });
  webrtcDictation.setUserBubbleHandler((text) => {
    // Dispatch fired — finalize whichever streaming bubble is in flight.
    // dictation gives us the post-commit-phrase-stripped utterance, which
    // may differ from our running display (which still includes the
    // commit word); use dictation's value as the source of truth.
    const el = userBubbleEl();
    if (el) {
      const span = el.querySelector('.text') as HTMLElement | null;
      if (span) span.textContent = text;
      el.classList.remove('streaming');
    } else {
      // No streaming bubble (e.g. dispatch fired with no preceding interim
      // — defensive). Render a plain user bubble so the utterance still
      // shows up in chat.
      chat.addLine('You', text, 's0', { source: 'voice' });
    }
    dcUserStreamingId = null;
    dcUserBufferedFinals = '';
    dcAssistantStreamingId = null;
  });
  webrtcConnection.setDataChannelListener((ev) => {
    if (ev.type === 'barge') {
      // Server-side VAD detected user voice during TTS. Cancel local
      // playback and clear the user-transcript suppression so the
      // user's words flow through the rest of the data-channel
      // pipeline. See docs/SIDEKICK_AUDIO_PROTOCOL.md.
      log('[webrtc] server-side barge fired — cancelling TTS playback');
      webrtcConnection.cancelRemotePlayback();
      webrtcSuppress.onBarge();
      return;
    }
    if (ev.type === 'listening') {
      // Bridge announced "STT pipe is hot" — fires at call-start AND
      // after every TTS-end transition (i.e. it's the user's turn
      // again in a multi-turn call). Plays the soft two-tone "your
      // turn" cue. Single source of truth: don't fire this anywhere
      // else on the client.
      try { playFeedback('listening'); } catch { /* ignore */ }
      // Visual pulse — adds the .listening class to the mic button so
      // the user can distinguish "we got your touch" (red filled, no
      // pulse) from "actually listening" (red filled + pulse). The
      // class clears with .active on stopVoice.
      const btn = document.getElementById('btn-mic');
      if (btn) btn.classList.add('listening');
      return;
    }
    if (ev.type !== 'transcript' || typeof ev.text !== 'string') return;
    if (ev.role === 'user') {
      // Half-duplex: while the agent is speaking, the iOS speakerphone
      // re-captures TTS output as mic input and Deepgram transcribes
      // it. We can't tell the difference between that and real user
      // speech from the transcript alone, so drop user transcripts
      // entirely while suppressing. The bridge-side VAD fires
      // {type:'barge'} when the user actually wants to interrupt; the
      // handler above clears suppression in that case.
      if (webrtcSuppress.isSuppressing()) return;
      if (!ev.is_final) {
        // Interim: upsert the streaming user bubble. Display = previously
        // is_finalized segments for this utterance + current interim.
        const display = (dcUserBufferedFinals + ' ' + ev.text).trim();
        if (!display) return;
        ensureUserBubble(display);
        setUserBubbleText(display);
        return;
      }
      // Final segment: append to our buffered-finals copy, update the
      // bubble to reflect the locked-in text, then feed the dictation
      // state machine so it can buffer for dispatch (silence/commit).
      dcUserBufferedFinals = (dcUserBufferedFinals + ' ' + ev.text).trim();
      ensureUserBubble(dcUserBufferedFinals);
      setUserBubbleText(dcUserBufferedFinals);
      webrtcDictation.handleUserFinal(ev.text);
      return;
    }
    if (ev.role === 'assistant') {
      // Assistant deltas: per-chunk over the data channel. Concatenate
      // into a single streaming bubble per assistant turn. The server
      // sends a final empty `is_final: true` envelope when the agent
      // run completes — that's the signal to drop the streaming class
      // (and its thinking-cursor) so the bubble stops blinking once
      // the reply is actually done.
      //
      // Suppression hooks: notify webrtcSuppress so it drops user
      // transcripts during the reply (kills iOS speakerphone-feedback
      // re-transcription). Barge-in is server-side now — the bridge
      // sends {type:'barge'} when its VAD detects user voice during
      // TTS; the data-channel handler above clears suppression.
      if (ev.is_final) {
        if (dcAssistantStreamingId) {
          const el = document.querySelector(
            `.line.agent[data-reply-id="${CSS.escape(dcAssistantStreamingId)}"]`,
          ) as HTMLElement | null;
          if (el) el.classList.remove('streaming', 'pending');
        }
        dcAssistantStreamingId = null;
        webrtcSuppress.onAssistantFinal();
        return;
      }
      webrtcSuppress.onAssistantDelta();
      if (!dcAssistantStreamingId) {
        // First delta of an assistant turn — the agent received our
        // dispatch and is now replying. Fires the 'send' chime here
        // (NOT at dispatch time in dictation.ts) so the user hears a
        // real time gap between 'commit' (over detected, local) and
        // 'send' (agent is replying, server-acknowledged). In WebRTC
        // mode the local dispatch is synchronous, so colocating the
        // two chimes there merged them into one tone.
        try { playFeedback('send'); } catch { /* feedback is best-effort */ }
        dcAssistantStreamingId = `dc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        chat.addLine(getAgentLabel(), ev.text, 'agent streaming', {
          markdown: true,
          replyId: dcAssistantStreamingId,
        });
        return;
      }
      const el = document.querySelector(
        `.line.agent[data-reply-id="${CSS.escape(dcAssistantStreamingId)}"]`,
      ) as HTMLElement | null;
      if (!el) {
        dcAssistantStreamingId = null;
        return;
      }
      const prev = el.dataset.text || '';
      const next = prev + ev.text;
      el.dataset.text = next;
      const textSpan = el.querySelector('.text') as HTMLElement | null;
      if (textSpan) textSpan.innerHTML = miniMarkdown(next);
    }
  });

  // Populate the mic picker once on boot. It needs prior getUserMedia
  // permission for labels to surface — until permission is granted, the
  // dropdown shows generic "Mic <id>" entries. Subsequent WebRTC calls
  // will get full labels on the next render.
  populateMicPicker().catch(() => {});

  // Release-all coordinator. Closes the active WebRTC call + tears down
  // any in-progress voice memo. External call sites assign through this
  // module-level handle so the closure references the right state.
  releaseCaptureIfActive = () => {
    if (webrtcControls.isOpen()) void webrtcControls.closeIfOpen();
    if (webrtcDictate.isActive()) void webrtcDictate.stop();
    if (memoActive) {
      memo.cancel();
      const bar = document.querySelector('.memo-bar');
      if (bar) bar.remove();
      memoActive = false;
      log('[mic-diag] memoActive=false (releaseCaptureIfActive)');
      // Textarea + btnMic stay visible during memo (bottom-row-only
      // memo bar UX), so no display:'' to reset here. Restore the
      // composer-actions row in case it was hidden during memo.
      const composerEl3 = document.querySelector('.composer') as HTMLElement | null;
      const actionsEl = composerEl3?.querySelector('.composer-actions') as HTMLElement | null;
      if (actionsEl) actionsEl.style.display = '';
    }
    if (capture.hasActive()) capture.release();
  };

  // Speak button visual state — reflects whether talk-mode is currently
  // active. Driven off webrtcControls; controls.ts already toggles
  // .active / .connecting on the button itself, so we only adjust the
  // .muted class for the icon-x overlay.
  function syncSpeakingButton() {
    const isTalk = webrtcControls.currentMode() === 'talk' && webrtcControls.isOpen();
    btnSpeak?.classList.toggle('muted', !isTalk);
  }
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
  // copied via cmd+shift+4 then cmd+C, or any tool that puts an image
  // on the clipboard), add it to the pending attachments via the same
  // path as the attach/camera buttons. Text paste falls through to the
  // default textarea behavior.
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
        voiceMemos.clearAll().catch(() => {});
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
      voiceMemos.clearAll().catch(() => {});
      historyLoaded = false;
      backend.newSession?.();
      chat.addSystemLine('New chat started');
      // Pin the viewed-session to the freshly-rotated conversationName.
      // Invariant: getViewed() mirrors the session on screen. The render
      // gates in handleReplyDelta/Final compare incoming `conversation`
      // against getViewed() — leaving it null here would drop the first
      // reply of a new chat (the conversation id IS truthy on the wire,
      // so `truthy !== null` would suppress every delta until the user
      // switched away and back).
      sessionDrawer.setViewed(backend.getCurrentSessionId?.() || null);
      // Re-render the session list so the old session row loses its
      // active highlight (new one isn't in response_store.db yet —
      // the optimistic placeholder row covers it).
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

  // ── Voice input — unified composer mic ────────────────────────────────
  // ONE button (#btn-mic) drives all four voice modes. The chevron menu
  // exposes three orthogonal toggles (PTT / call / auto-send) that
  // determine what happens when the user taps or holds the mic. See
  // the mic-mode dropdown wiring further down.
  const btnMic = document.getElementById('btn-mic');

  function exitMemoMode() {
    memoActive = false;
    log('[mic-diag] memoActive=false (exitMemoMode)');
    // Restore the composer-actions row + put the send button back in its
    // original DOM home (last child of .composer-actions-right). The bar
    // itself is removed by memo.cleanup(). Re-query each time since the
    // composer DOM is stable but the const lived in the onclick scope.
    // Note: textarea + btnMic stay visible during memo (bottom-row-only
    // memo bar UX), so no display:'' to reset here.
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
    // Clear voice-state classes on the mic button when memo dismisses.
    // .active is also flipped via voiceActive() polling indirectly, but
    // explicit removal here keeps the visual in sync without waiting.
    if (btnMic) {
      btnMic.classList.remove('active', 'listening');
    }
    updateSendButtonState();
  }

  /** Flush queued audio items — update the corresponding memo cards with transcripts. */
  async function flushOutbox() {
    const result = await queue.flush(
      async (text) => { backend.sendMessage(text); },
      async (blob, mimeType, id, autoSend) => {
        // Timeout scales with blob size: small memos under 1MB ≈ minute or
        // less of audio (Deepgram batch returns in 1-3s) get the snappy
        // 15s budget. Larger blobs get 60s — the upload alone for a 5MB
        // webm over Tailscale can take 5-10s, plus Deepgram batch latency
        // grows roughly with audio length. Earlier 15s flat ceiling
        // wedged 3-minute memos in permanent-retry: each attempt timed
        // out before Deepgram could respond, queue never drained.
        const timeoutMs = blob.size > 1_000_000 ? 60_000 : 15_000;
        // Per-user keyterm biasing for batch transcribe. Same IDB list the
        // WebRTC offer ships; bridge accepts repeated `?keyterms=…&keyterms=…`
        // and merges into the Deepgram spec like the streaming path does.
        // Without this, memo-mode transcription runs un-biased even if the
        // user has chips configured (was the case for "clawdian" miss).
        let kt: string[] = [];
        try {
          const { readList } = await import('./keyterms.ts');
          kt = (await readList()) || [];
        } catch {}
        const url = kt.length
          ? `/transcribe?${kt.map(t => 'keyterms=' + encodeURIComponent(t)).join('&')}`
          : '/transcribe';
        let res;
        try {
          res = await fetchWithTimeout(url, {
            method: 'POST', headers: { 'Content-Type': mimeType }, body: blob,
            timeoutMs,
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
          // Symptom: queued audio memos all fail with "deepgram 400
          // corrupt or unsupported data" on each retry — typically
          // blobs recorded while the iOS mic-perm dialog was up
          // (silent / partial). Without this guard the outbox grows
          // unbounded.
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

        // Routing depends on the per-memo autoSend flag captured at
        // record time (settings.micAutoSend at the moment startMemo()
        // was called). autoSend=true → append to composer (so any
        // already-typed text is preserved) and immediately submit;
        // autoSend=false → just append, leaving the user to review +
        // send manually. Both paths converge through composer.appendText
        // → composer.submit, which is the same codepath as clicking Send.
        if (card) card.remove();
        await voiceMemos.remove(id);
        composer.appendText(text);
        if (autoSend) {
          composer.submit();
        }
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

  // Periodic network-status refresh. Surfaces queued count + weak-signal
  // detection in the header. Only writes when there's no active WebRTC
  // call (controls.ts owns the call-status narrative).
  const WEAK_SIGNAL_MS = 8_000;
  setInterval(async () => {
    if (webrtcControls.isOpen()) return;
    try {
      const gwConnected = backend.isConnected();
      const summary = await queue.summary();
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
        });
      }
    } catch {}
  }, 2_000);

  /** Save blob to IDB + enqueue for retry + render a placeholder memo card
   *  in chat. Always runs on record stop, regardless of online/offline —
   *  gives the user immediate visual feedback during the quiet
   *  transcription window. Returns {id, card, rec}. autoSend is stored
   *  on the queue item so flushOutbox can route correctly even when the
   *  flush happens minutes later (periodic retry / reconnect). */
  async function renderMemoCard(audioBlob, durationMs, autoSend = false) {
    // Hard ceiling: the bridge accepts up to 25MB at /v1/transcribe and
    // the proxy mirrors that. webm voice is ~30KB/s so 25MB ≈ 14 min.
    // Anything larger gets DROPPED here with a status warning rather
    // than queued — a too-big blob in the outbox just retries forever
    // and blocks the channel for smaller subsequent memos. User can
    // re-record in shorter chunks. Threshold is intentionally a few
    // hundred KB below the 25MB limit so an upload-time encoding bump
    // doesn't push a borderline blob over.
    const MEMO_MAX_BYTES = 24 * 1024 * 1024;
    if (audioBlob.size > MEMO_MAX_BYTES) {
      const mb = (audioBlob.size / (1024 * 1024)).toFixed(1);
      const mins = Math.round((durationMs ?? 0) / 60000);
      log(`memo: too big (${mb}MB ≈ ${mins}min) — dropped, would block the queue`);
      status.setStatus(
        `Memo too long (${mins}m) — dropped. Try shorter chunks.`,
        'err',
      );
      try { playFeedback('error'); } catch {}
      return { id: null, card: null, rec: null };
    }

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
    await queue.enqueue({ id, type: 'audio', blob: audioBlob, mimeType: audioBlob.type, durationMs, autoSend });
    log('memo: queued audio blob (' + Math.round(audioBlob.size / 1024) + 'KB) autoSend=' + autoSend);

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

  async function handleMemoResult(audioBlob: Blob, durationMs?: number, autoSend = false, path = 'unknown') {
    // Diagnostic for the iOS PTT auto-send bug — echoes the captured
    // autoSend flag + which release path triggered this finish, so
    // future regressions are debuggable from the JS console without
    // having to instrument startMemo from scratch.
    log(`memo finish: path=${path} autoSend=${autoSend} blob=${audioBlob ? Math.round(audioBlob.size/1024)+'KB' : 'null'} live-setting=${settings.get().micAutoSend}`);
    if (!audioBlob) return;
    // Always render the placeholder card + enqueue the blob, regardless
    // of connectivity. Matches the "user gets immediate visual feedback"
    // UX spec and keeps ONE processing path (flushOutbox) whether we're
    // online or offline.
    const { card } = await renderMemoCard(audioBlob, durationMs, autoSend);

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

  // ── Cursor-aware dictation (call=true, autoSend=false) ─────────────
  // webrtcDictate is the live-streaming + cursor-aware injection module.
  // init() binds the textarea + wires its user-input/cursor listeners.
  webrtcDictate.init(composerInput);
  let dictateActive = false;
  webrtcDictate.setStateListener((opening, error) => {
    dictateActive = opening;
    if (btnMic) {
      btnMic.classList.toggle('active', opening);
      // Clear the "actually listening" pulse on stop. It's added by the
      // bridge's {type: 'listening'} envelope when STT goes hot; we
      // proactively remove on stop so the close transition reads
      // cleanly instead of waiting for a final paint.
      if (!opening) btnMic.classList.remove('listening');
    }
    if (error) {
      status.setStatus(`Dictate error: ${error}`, 'err');
    } else if (opening) {
      status.setStatus('Listening — speak; tap mic / Send / Esc to stop', 'live');
    } else {
      status.setStatus('');
    }
    updateSendButtonState();
  });

  // ── Unified composer-mic state + dispatch ──────────────────────────
  //
  // Two orthogonal toggles drive the four modes (gesture is detected at
  // press time — see the mic-button handler below for the tap-vs-hold
  // state machine):
  //   settings.micCall     false=memo (offline-first), true=live WebRTC
  //   settings.micAutoSend false=land in composer, true=auto-dispatch
  //
  // Decision matrix:
  //   call=false autoSend=false → memo → composer (current legacy)
  //   call=false autoSend=true  → memo → fire-and-forget on stop (NEW)
  //   call=true  autoSend=true  → live chat-bubble streaming (today's call)
  //   call=true  autoSend=false → cursor-aware dictation (NEW)
  //
  // Each primitive operation is idempotent: startVoice waits for the
  // state to settle before flipping. The unified click handler reads
  // toggles AT TAP TIME (not at boot) so flipping the menu mid-session
  // takes effect on the next tap without requiring a teardown.

  /** Start memo mode (recording bar + MediaRecorder → blob).
   *  Returns false if mic acquisition fails. autoSend determines whether
   *  the resulting transcript routes via composer or auto-dispatches —
   *  threaded into handleMemoResult / flushOutbox.
   *
   *  UI shape: only the BOTTOM row of the composer swaps to the waveform
   *  bar. The textarea above stays visible (existing typed text remains
   *  in view; on memo completion the transcript appends at the cursor
   *  for autoSend=false, or appends + sends together for autoSend=true).
   *  The send button is moved into the memo bar so it stays right-anchored. */
  async function startMemo(autoSend: boolean): Promise<void> {
    if (memoActive) return;
    if (dictateActive) await webrtcDictate.stop();
    if (webrtcControls.isOpen()) await webrtcControls.closeIfOpen();
    // iOS AVAudioSession prep: prepareForCapture before getUserMedia.
    unlock(player);
    audioSession.prepareForCapture();
    memoActive = true;
    log('[mic-diag] memoActive=true (startMemo)');
    updateSendButtonState();
    composerSend.onclick = async () => {
      if (composerSend.disabled) return;
      composerSend.disabled = true;
      try {
        const { audioBlob, durationMs } = await memo.stop();
        exitMemoMode();
        await handleMemoResult(audioBlob, durationMs, autoSend, 'composerSend.click');
      } finally {
        composerSend.disabled = false;
      }
    };
    const composerEl = composerInput.parentElement;
    const composerActionsEl = composerEl?.querySelector('.composer-actions') as HTMLElement | null;
    if (composerActionsEl) composerActionsEl.style.display = 'none';
    const ok = await memo.start({
      container: composerEl,
      insertBefore: composerActionsEl || composerSend,
      sendBtn: composerSend,
      onDone: (audioBlob) => {
        exitMemoMode();
        handleMemoResult(audioBlob, undefined, autoSend, 'memo.onDone');
      },
      onCancel: () => {
        exitMemoMode();
      },
    });
    if (!ok) {
      exitMemoMode();
      status.setStatus('Mic not available', 'err');
    }
  }

  /** Start cursor-aware live dictation (call=true, autoSend=false).
   *
   *  `initialCursor` is the textarea selectionStart captured at the
   *  user's gesture site (mic-button pointerdown / hotkey handler)
   *  BEFORE focus shifted off the textarea. Without it, the first
   *  interim's anchor capture reads selectionStart on a possibly-
   *  blurred textarea — which on iOS Safari can return 0 (text lands
   *  at start) or value.length (text lands at end), and the visible
   *  caret then jumps to whatever setCursor was given. See dictate.ts
   *  ensureAnchor for the full anchor-source priority chain. */
  async function startDictate(initialCursor: number | null = null): Promise<void> {
    if (dictateActive) return;
    if (memoActive) return;
    if (!navigator.onLine) {
      status.setStatus('Offline — using memo mode', null);
      await startMemo(false);
      return;
    }
    unlock(player);
    audioSession.prepareForCapture();
    try {
      await webrtcDictate.start({
        sessionId: sessionDrawer.getViewed() || backend.getCurrentSessionId?.() || null,
        initialCursor,
      });
    } catch (e: any) {
      diag('dictate start failed', e?.message);
      status.setStatus(`Dictate failed: ${e?.message ?? e}`, 'err');
    }
  }

  async function stopDictate(): Promise<void> {
    if (!dictateActive) return;
    await webrtcDictate.stop();
  }

  /** Start live chat-bubble streaming (call=true, autoSend=true). The
   *  existing webrtcControls + dictation.ts wiring handles the rest:
   *  silence/commit-phrase auto-dispatch, user/agent bubble rendering. */
  async function startCallStream(): Promise<void> {
    if (memoActive) return;
    if (dictateActive) await webrtcDictate.stop();
    if (webrtcControls.isOpen()) return;
    // openCall picks the mode per the user's #btn-speak preference at
    // open time — same behavior as the old toolbar mic, just invoked
    // from the composer.
    const mode: 'stream' | 'talk' = settings.get().tts ? 'talk' : 'stream';
    try {
      await webrtcControls.openCall(mode);
    } catch (e: any) {
      diag('call open failed', e?.message);
    }
  }

  async function stopCallStream(): Promise<void> {
    if (!webrtcControls.isOpen()) return;
    await webrtcControls.closeIfOpen();
  }

  /** Whether some voice path is currently active. Used by the click
   *  toggle to decide start vs stop. */
  function voiceActive(): boolean {
    return memoActive || dictateActive || webrtcControls.isOpen();
  }

  /** Stop whichever voice path is active. Idempotent / safe to call
   *  when nothing is running. */
  async function stopVoice(): Promise<void> {
    if (memoActive) {
      // Mid-memo stop fires send (release-to-send PTT semantics) by
      // clicking the composer-send. If the user wants to discard, they
      // hit the trash button or Esc.
      composerSend.click();
      return;
    }
    if (dictateActive) {
      await stopDictate();
      return;
    }
    if (webrtcControls.isOpen()) {
      await stopCallStream();
      return;
    }
  }

  /** Start whichever voice path matches the current toggles.
   *
   *  `initialCursor` (composer textarea selectionStart, captured at the
   *  gesture site BEFORE focus shifted) is plumbed only to the dictate
   *  path — it's the only mode that splices into the textarea at the
   *  user's caret. The other modes (memo, call-stream auto-send) don't
   *  care where the caret was. */
  async function startVoice(initialCursor: number | null = null): Promise<void> {
    const s = settings.get();
    if (s.micCall) {
      if (s.micAutoSend) await startCallStream();
      else await startDictate(initialCursor);
    } else {
      await startMemo(!!s.micAutoSend);
    }
  }

  /** Read the current composer cursor position. Called BEFORE focus
   *  shifts off the textarea (mic-button pointerdown, hotkey handler)
   *  so the value reflects the user's intended insertion point. Returns
   *  null if the textarea has never been focused / has no selection
   *  data — dictate.ts will fall back gracefully. */
  function captureComposerCursor(): number | null {
    try {
      const ss = composerInput.selectionStart;
      return (typeof ss === 'number') ? ss : null;
    } catch {
      return null;
    }
  }

  // ── Mic button — gesture-detected tap-vs-hold state machine ────────
  if (btnMic) {
    // Single gesture, mode auto-detected from press duration. No user
    // setting; the press itself reveals intent. State machine:
    //
    //   IDLE
    //     pointerdown → start recording, t0=now, state=RECORDING
    //
    //   RECORDING (mode pending)
    //     pointerup: dur = now - t0
    //       dur < TAP_THRESHOLD_MS → state=RECORDING_TOGGLE (keep running,
    //         next tap stops). Drag-to-discard NOT reachable here — the
    //         gesture surface ended on release; user must use the
    //         trash button on the memo bar to discard a toggled memo.
    //       dur ≥ TAP_THRESHOLD_MS → finalize (send/dispatch), state=IDLE
    //     pointercancel/leave-mid-press → treat as pointerup
    //
    //   RECORDING_TOGGLE
    //     pointerdown → finalize (send), state=IDLE
    //     pointerup → no-op (the click that started this state ALSO fires
    //       a pointerup; we ignore it once we've transitioned)
    //
    // While in RECORDING (HOLD path), the existing waveform-as-button
    // drag-to-discard gesture stays live: pointer-capture on the mic
    // button means pointermove/pointerup route here even when the
    // finger drifts onto the memo bar. Drag LEFT past the trash
    // bounding rect → discard-armed; release in red → discard.
    const TAP_THRESHOLD_MS = 200;

    type MicState = 'idle' | 'recording' | 'recording_toggle';
    let micState: MicState = 'idle';
    let pressStartedAt = 0;
    /** Time the gesture machine entered `recording_toggle`. A second
     *  pointerdown within TOGGLE_STOP_GUARD_MS of this is treated as
     *  an accidental double-tap (browser autoclick / fast user) and
     *  ignored — otherwise rapid double-clicks finalize a sub-second
     *  empty memo. Call mode dodges this because WebRTC handshake is
     *  still in flight on click 2, so its stopVoice no-ops. */
    let recordingToggleAt = 0;
    const TOGGLE_STOP_GUARD_MS = 500;
    /** True once we've classified the press as HOLD (release ≥ threshold).
     *  Distinct from micState so the drag-to-discard pointermove handler
     *  knows when the gesture surface is live. */
    let holdActive = false;
    /** Memo bar element — cached on press_down (HOLD path) so pointermove
     *  doesn't re-querySelector every frame. */
    let holdMemoBar: HTMLElement | null = null;
    /** True when the pointer is currently in the trash zone (HOLD only).
     *  Drives the red-state class swap; only transitions write to the DOM. */
    let holdDiscardArmed = false;
    /** Pointer ID currently captured for HOLD-mode drag-to-discard. */
    let capturedPointerId: number | null = null;

    /** Diagnostic: snapshot every relevant gesture-state variable at a
     *  decision site. Used to debug silent no-op press branches. */
    function diagMicState(label: string): void {
      const age = recordingToggleAt > 0 ? (performance.now() - recordingToggleAt).toFixed(0) : '-';
      log(
        '[mic-diag]', label,
        'micState=', micState,
        'memoActive=', memoActive,
        'dictateActive=', dictateActive,
        'webrtcOpen=', webrtcControls.isOpen(),
        'voiceActive=', voiceActive(),
        'recordingToggleAt_age=', age, 'ms',
        'holdActive=', holdActive,
        'capturedPointerId=', capturedPointerId,
      );
    }

    /** Trash-zone hit test: trash button's bbox + generous left-side
     *  margin so sliding off the bar leftward counts as discard. */
    function isOverTrashZone(clientX: number, clientY: number): boolean {
      if (!holdMemoBar) return false;
      const trash = holdMemoBar.querySelector('.memo-trash') as HTMLElement | null;
      if (!trash) return false;
      const r = trash.getBoundingClientRect();
      const barRect = holdMemoBar.getBoundingClientRect();
      const inV = clientY >= barRect.top - 8 && clientY <= barRect.bottom + 8;
      const inH = clientX <= r.right + 8;
      return inV && inH;
    }

    /** Resolve the memo bar element after startVoice's async setup
     *  completes (mic permission, MediaRecorder spin-up). Polls briefly
     *  to cover iOS getUserMedia latency. Only relevant for memo mode
     *  (call mode has no .memo-bar). */
    function pollForMemoBar(tries: number): void {
      if (settings.get().micCall) return;  // call mode — no memo bar
      const bar = document.querySelector('.memo-bar') as HTMLElement | null;
      if (bar) {
        bar.classList.add('memo-bar-ptt');
        holdMemoBar = bar;
      } else if (tries > 0) {
        setTimeout(() => pollForMemoBar(tries - 1), 30);
      }
    }

    let holdActivationTimer: ReturnType<typeof setTimeout> | null = null;

    /** Press-down: starts recording immediately (regardless of eventual
     *  tap-vs-hold classification). The release-time duration check
     *  decides whether to keep recording or stop. */
    btnMic.addEventListener('pointerdown', (e: PointerEvent) => {
      diagMicState('pointerdown ENTRY');
      if (holdActivationTimer) { clearTimeout(holdActivationTimer); holdActivationTimer = null; }
      // Stale-state guard: if the gesture machine thinks we're in
      // recording_toggle but no voice path is actually running, the
      // memo finalized externally (Enter-in-composer, memo bar's
      // own send button, etc) without our pointerdown firing. The
      // old code path called stopVoice → no-op → user perceived
      // "click did nothing" alternating pattern. Reset to idle and
      // fall through to the normal start path.
      if (micState === 'recording_toggle' && !voiceActive()) {
        log('[mic-diag] stale recording_toggle (voice not active) — resetting to idle');
        micState = 'idle';
        recordingToggleAt = 0;
      }
      if (micState === 'recording_toggle') {
        // Second press on a tap-toggled recording — stop now, BUT only
        // if enough time has passed since toggle-start. A press within
        // ~500ms of the toggle-start is almost certainly a stray
        // double-tap, not a deliberate stop. Without this guard, two
        // fast clicks fire start+stop in <1s and produce an empty
        // memo (the "memo requires two clicks" symptom).
        const age = performance.now() - recordingToggleAt;
        if (age < TOGGLE_STOP_GUARD_MS) {
          e.preventDefault();
          log('[mic-diag] BRANCH: double-tap guard SWALLOWED press, age=', age.toFixed(0), 'ms');
          return;
        }
        e.preventDefault();
        log('[mic-diag] BRANCH: recording_toggle → stopVoice (age=', age.toFixed(0), 'ms)');
        micState = 'idle';
        void stopVoice();
        return;
      }
      if (micState !== 'idle') {
        log('[mic-diag] BRANCH: micState !== idle → SILENT NO-OP (state=', micState, ')');
        return;
      }
      // Defensive: if voice somehow active without our state knowing
      // (race / external trigger), treat press as a stop request.
      if (voiceActive()) {
        e.preventDefault();
        log('[mic-diag] BRANCH: voiceActive defensive → stopVoice (memo=', memoActive, 'dict=', dictateActive, 'rtc=', webrtcControls.isOpen(), ')');
        void stopVoice();
        return;
      }
      log('[mic-diag] BRANCH: idle → start recording');
      pressStartedAt = performance.now();
      micState = 'recording';
      holdActive = false;
      holdDiscardArmed = false;
      holdMemoBar = null;
      capturedPointerId = e.pointerId;
      // Capture pointer so move/up route here even if finger drifts
      // onto the memo bar — needed for drag-to-discard during HOLD.
      try { btnMic.setPointerCapture(e.pointerId); } catch {}
      // Immediate visual feedback. startVoice() has multiple awaits
      // (closing prior call, MediaRecorder boot) so the .active class
      // would otherwise flip 100-300ms later — user perceives the
      // first click as a no-op. Set the class synchronously so the
      // red filled state appears on the same frame as the press.
      // The memo path's "actually-listening" pulse (.listening) still
      // fires later when MediaRecorder genuinely starts recording —
      // two-state visual remains correct.
      try { btnMic.classList.add('active'); } catch {}
      // Capture composer cursor BEFORE focus shifts to the mic button.
      // pointerdown fires while the textarea (if it was focused) still
      // has its selection state; reading later — after the implicit
      // focus shift / the async startVoice handshake — risks getting
      // 0 / value.length / null on iOS Safari, landing voice text at
      // the wrong location. See dictate.ts ensureAnchor for details.
      const initialCursor = captureComposerCursor();
      log('[mic] pointerdown — startVoice fired (state=recording, t0=', pressStartedAt.toFixed(0), ', initialCursor=', initialCursor, ')');
      void startVoice(initialCursor);
      try {
        status.setStatus('Listening — release after a moment to send, or tap to keep recording', 'live');
      } catch {}
      // Once the press has lasted long enough to qualify as HOLD, flip
      // holdActive so pointermove enables the drag-to-discard surface
      // and start polling for the memo bar. Recording itself started
      // on press_down — this boundary is purely visual / drag-zone
      // activation. Cleared on pointerup/cancel.
      holdActivationTimer = setTimeout(() => {
        holdActivationTimer = null;
        if (micState === 'recording') {
          holdActive = true;
          pollForMemoBar(10);
        }
      }, TAP_THRESHOLD_MS);
    });

    btnMic.addEventListener('pointermove', (e: PointerEvent) => {
      // Drag-to-discard surface only active during HOLD-confirmed recording
      // (the brief window between press_down and release_classified is
      // pre-classification; we'd rather not flicker the bar red during
      // a finger that's about to lift as a tap).
      if (!holdActive) return;
      if (!holdMemoBar) {
        holdMemoBar = document.querySelector('.memo-bar') as HTMLElement | null;
        if (!holdMemoBar) return;
      }
      const overTrash = isOverTrashZone(e.clientX, e.clientY);
      if (overTrash !== holdDiscardArmed) {
        holdDiscardArmed = overTrash;
        holdMemoBar.classList.toggle('discard-armed', overTrash);
      }
    });

    /** Press-up classifier: short → toggle (keep running); long → finalize. */
    const onPointerUp = (e: PointerEvent) => {
      diagMicState('pointerup ENTRY (' + e.type + ')');
      // Ignore pointerup events that don't correspond to a press we own.
      if (micState !== 'recording') {
        log('[mic-diag] pointerup IGNORED (state=', micState, ')');
        return;
      }

      const dur = performance.now() - pressStartedAt;
      const isCancel = e.type === 'pointercancel';
      try { btnMic.releasePointerCapture(e.pointerId); } catch {}
      capturedPointerId = null;

      log('[mic] pointerup — dur=', dur.toFixed(0), 'ms, classify=', dur < TAP_THRESHOLD_MS ? 'TAP' : 'HOLD');
      if (dur < TAP_THRESHOLD_MS && !isCancel) {
        // TAP → keep recording in toggle mode. Next tap stops it
        // (but see TOGGLE_STOP_GUARD_MS in pointerdown handler — too-
        // fast follow-up taps get ignored as accidental double-taps).
        micState = 'recording_toggle';
        recordingToggleAt = performance.now();
        try {
          status.setStatus('Recording — tap mic again to send', 'live');
        } catch {}
        // Drag-to-discard surface goes away (release happened); user
        // must use the trash button on the bar to discard manually.
        if (holdMemoBar) {
          holdMemoBar.classList.remove('discard-armed');
        }
        holdMemoBar = null;
        holdDiscardArmed = false;
        return;
      }

      // HOLD (or pointercancel mid-press) → finalize.
      micState = 'idle';
      const wasDiscard = (holdActive && holdDiscardArmed) || isCancel;
      holdActive = false;
      holdDiscardArmed = false;
      const barRef = holdMemoBar;
      holdMemoBar = null;
      e.preventDefault();
      e.stopPropagation();
      // Defer a tick so async startVoice's MediaRecorder / WebRTC
      // handshake settles before we ask the same primitive to stop.
      setTimeout(() => {
        if (wasDiscard && memoActive) {
          log('memo finish: path=hold-discard (gesture released over trash zone)');
          memo.cancel();
          exitMemoMode();
        } else {
          if (barRef) barRef.classList.remove('discard-armed');
          void stopVoice();
        }
      }, 0);
    };
    btnMic.addEventListener('pointerup', onPointerUp);
    btnMic.addEventListener('pointercancel', onPointerUp);
    const cancelHoldTimer = () => {
      if (holdActivationTimer) { clearTimeout(holdActivationTimer); holdActivationTimer = null; }
    };
    btnMic.addEventListener('pointerup', cancelHoldTimer);
    btnMic.addEventListener('pointercancel', cancelHoldTimer);

    // The btnMic.onclick handler is intentionally absent: gestures are
    // dispatched entirely by the pointerdown / pointerup state machine
    // above. A click handler here would race with the synthetic click
    // browsers fire after pointerup and re-stop a just-tap-toggled
    // recording. Keyboard activation (Enter/Space on focused button)
    // is handled below with explicit handlers.
    btnMic.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      // Keyboard tap = same semantics as a quick tap: toggle.
      if (micState === 'recording_toggle' || voiceActive()) {
        micState = 'idle';
        void stopVoice();
      } else if (micState === 'idle') {
        micState = 'recording_toggle';
        // Reading composer cursor here is best-effort: the user is
        // tabbed onto the mic button so the textarea is blurred. On
        // browsers that preserve selectionStart across blur (most
        // desktops) we get the right value; on ones that don't, we
        // fall back to whatever ensureAnchor() can read at first
        // interim. Either way better than nothing.
        void startVoice(captureComposerCursor());
      }
    });

    // Esc / Enter while memo bar is up.
    document.addEventListener('keydown', (e) => {
      if (!memoActive) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        memo.stop();
        const trash = document.querySelector('.memo-trash') as HTMLButtonElement | null;
        if (trash) trash.click();
        else exitMemoMode();
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        composerSend.click();
      }
    });
  }

  // ── Mic-mode chevron menu (PTT / Call / Auto-send toggles) ─────────
  // Three iOS-style toggle rows. State persists in settings; reads on
  // every dispatch, writes on every flip. No teardown needed.
  const btnMicMode = document.getElementById('btn-mic-mode') as HTMLButtonElement | null;
  const micModeMenu = document.getElementById('mic-mode-menu') as HTMLElement | null;
  const micModeWrap = document.querySelector('.mic-mode-wrap') as HTMLElement | null;

  function applyMicModeUi(): void {
    const s = settings.get();
    if (micModeMenu) {
      micModeMenu.querySelectorAll<HTMLButtonElement>('button.mic-toggle-row').forEach(b => {
        const key = b.dataset.toggle as 'micCall' | 'micAutoSend' | undefined;
        if (!key) return;
        const on = !!(s as any)[key];
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.classList.toggle('on', on);
        // Tooltip — pulls the hotkey live from settings so a rebind in
        // the settings panel reflects here on next menu open. Mac/iOS
        // get the ⌘ glyph for native feel; everywhere else the literal.
        const hk = key === 'micCall' ? s.hotkeyCallMode : s.hotkeyAutoSend;
        const isMac = /(Mac|iPhone|iPad)/i.test(navigator.platform);
        const prettyHk = isMac
          ? hk.replace(/Cmd/gi, '⌘').replace(/Shift/gi, '⇧').replace(/Alt/gi, '⌥').replace(/Ctrl/gi, '⌃').replace(/\+/g, '')
          : hk;
        const desc = key === 'micCall'
          ? 'Call mode — full-duplex WebRTC voice (vs. push-to-record memo)'
          : 'Auto-send — dispatch on end-of-utterance (vs. drafting into composer)';
        b.title = `${desc} · ${prettyHk}`;
      });
    }
    // Mic button tooltip + a data-mode attribute on the wrap so CSS can
    // hint at the current mode (e.g. accent the chevron when call is on).
    if (micModeWrap) {
      const mode = s.micCall
        ? (s.micAutoSend ? 'call-auto' : 'dictate')
        : (s.micAutoSend ? 'memo-auto' : 'memo');
      micModeWrap.dataset.mode = mode;
    }
    if (btnMic) {
      const what = s.micCall
        ? (s.micAutoSend ? 'live chat' : 'live dictation')
        : (s.micAutoSend ? 'memo (auto-send)' : 'voice memo');
      btnMic.title = `Tap or hold — ${what}`;
    }
  }
  applyMicModeUi();

  // Single source of truth for "flip a mic toggle" — used by BOTH the
  // menu-click handler AND the global hotkey handler. Prior code had
  // two independent paths reading `!s.X` snapshots taken BEFORE
  // settings.set() flipped the value, which made the status pill text
  // and the menu visuals drift out of sync (the visuals re-read live
  // state via applyMicModeUi but the pill text used the stale snapshot).
  // Reading the post-flip value via settings.get() after set() removes
  // the anticorrelation entirely. Side-effects (end-call-on-call-off)
  // also live here so menu + hotkey behave identically.
  function flipMicSetting(key: 'micCall' | 'micAutoSend'): void {
    const cur = !!(settings.get() as any)[key];
    const next = !cur;
    settings.set(key, next);
    applyMicModeUi();
    const label = key === 'micCall' ? 'Call mode' : 'Auto-send';
    // Read POST-flip value off settings, not the captured snapshot —
    // keeps the pill text honest if anything else mutated state in
    // between (or if a future caller passes its own pre-flip value).
    const live = !!(settings.get() as any)[key];
    status.setStatus(`${label}: ${live ? 'on' : 'off'}`, null);
    // Closing call-mode WHILE a call is open should end the call —
    // otherwise the WebRTC peer keeps streaming and the user has to
    // click the mic to actually stop. Same intent for menu + hotkey.
    if (key === 'micCall' && !next && voiceActive()) {
      void stopVoice();
    }
  }

  function setMicModeMenuOpen(open: boolean): void {
    if (!micModeMenu || !btnMicMode) return;
    if (open) {
      micModeMenu.removeAttribute('hidden');
      micModeMenu.setAttribute('aria-hidden', 'false');
      btnMicMode.setAttribute('aria-expanded', 'true');
    } else {
      micModeMenu.setAttribute('hidden', '');
      micModeMenu.setAttribute('aria-hidden', 'true');
      btnMicMode.setAttribute('aria-expanded', 'false');
    }
  }

  if (btnMicMode && micModeMenu) {
    btnMicMode.onclick = (e) => {
      e.stopPropagation();
      const open = btnMicMode.getAttribute('aria-expanded') === 'true';
      setMicModeMenuOpen(!open);
    };
    micModeMenu.querySelectorAll<HTMLButtonElement>('button.mic-toggle-row').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        const key = b.dataset.toggle as 'micCall' | 'micAutoSend' | undefined;
        if (!key) return;
        // Single canonical path — same as the hotkey. flipMicSetting
        // updates the setting, refreshes menu visuals, sets the status
        // pill text from the post-flip value, and runs side effects
        // (end-call-on-call-off). Menu stays open so the user can flip
        // multiple toggles in one pass (iOS Control Center pattern);
        // tap outside to close.
        flipMicSetting(key);
      };
    });
    // Click outside closes the menu (capture so chat-bubble handlers
    // that stopPropagation can't strand us with a stuck-open menu).
    document.addEventListener('click', (e) => {
      if (!micModeMenu || micModeMenu.hasAttribute('hidden')) return;
      const t = e.target as Node;
      if (micModeWrap && micModeWrap.contains(t)) return;
      setMicModeMenuOpen(false);
    }, true);
  }

  // Send-button intercept — when dictate is active, clicking Send (or
  // pressing Enter to fire it) should send whatever's in the composer
  // AND close the dictate stream. Capture phase so we run alongside
  // sendTypedMessage rather than racing it.
  composerSend.addEventListener('click', () => {
    if (dictateActive) void stopDictate();
  }, true);

  // Esc closes dictate (matches the memo Esc-cancel UX). Doesn't
  // interfere with the existing memoActive Esc handler — that only
  // fires when memo is recording.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!dictateActive) return;
    e.preventDefault();
    void stopDictate();
  });

  // ── Global hotkeys (user-configurable in settings) ──────────────────
  // Three actions, three hotkey strings stored in settings. Matcher
  // accepts both Cmd (metaKey) and Ctrl (ctrlKey) for cross-platform
  // editing — Mac users see Cmd in defaults, Windows/Linux users can
  // overwrite with Ctrl. preventDefault + stopPropagation on match so
  // we override browser defaults (Cmd+Shift+C is DevTools "inspect" by
  // default, Cmd+Shift+D is "Bookmark all tabs" in Chrome, etc) AND
  // claim the event before any later document-level listener can run.
  //
  // Registered in CAPTURE phase (third arg `true`) so we run BEFORE any
  // other document-level keydown handler that might preventDefault or
  // stopPropagation us (e.g. the debug-panel Ctrl+Shift+D handler at
  // boot, or any future addition). Field reports of "⌘⇧D does nothing
  // regardless of cursor" pointed at exactly this scenario — handler
  // ordering / phase gymnastics. Capture-phase first listener with
  // stopPropagation gives the global hotkeys deterministic priority.
  document.addEventListener('keydown', (e) => {
    // Skip when typing in editable fields, except for the hotkey-capture
    // inputs themselves which handle their own keydown (those have
    // .hotkey-input class).
    const t = e.target as HTMLElement | null;
    if (t) {
      if (t.classList.contains('hotkey-input')) return;
      // Modifier-key combos (Cmd/Ctrl + Shift + key) aren't normal
      // typing — fire them everywhere INCLUDING input fields, so the
      // user can hit Cmd+Shift+D from inside the composer to toggle
      // mic without leaving the textarea. Without this, Chrome's
      // Cmd+Shift+D (bookmark all tabs) wins via browser default.
      const isShortcut = (e.metaKey || e.ctrlKey) && e.shiftKey;
      if (!isShortcut && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || (t as any).isContentEditable)) return;
    }
    const s = settings.get();
    // Diagnostic: every Cmd/Ctrl+Shift+<letter> keydown logs what we saw
    // vs the three configured bindings. Lets us see whether the handler
    // fires at all for ⌘⇧D and (if so) why no match. Cheap; only triggers
    // for shortcut-shaped combos so it doesn't spam normal typing.
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.length === 1) {
      log('[hotkey] keydown',
        'meta=', e.metaKey, 'ctrl=', e.ctrlKey, 'shift=', e.shiftKey,
        'alt=', e.altKey, 'key=', JSON.stringify(e.key),
        'bindings=', { call: s.hotkeyCallMode, auto: s.hotkeyAutoSend, mic: s.hotkeyToggleMic });
    }
    const matches = (combo: string): boolean => {
      if (!combo) return false;
      const parts = combo.split('+').map(p => p.trim().toLowerCase()).filter(Boolean);
      let needMeta = false, needCtrl = false, needAlt = false, needShift = false;
      let key = '';
      for (const p of parts) {
        if (p === 'cmd' || p === 'meta') needMeta = true;
        else if (p === 'ctrl') needCtrl = true;
        else if (p === 'alt') needAlt = true;
        else if (p === 'shift') needShift = true;
        else key = p;
      }
      // Cross-platform: if combo says Cmd, allow either metaKey OR ctrlKey
      // (so a "Cmd+Shift+C" binding works for Windows/Linux users typing Ctrl).
      const modifierOK =
        (needMeta ? (e.metaKey || e.ctrlKey) : !e.metaKey) &&
        (needCtrl ? (e.ctrlKey || e.metaKey) : (needMeta || !e.ctrlKey)) &&
        (needAlt ? e.altKey : !e.altKey) &&
        (needShift ? e.shiftKey : !e.shiftKey);
      if (!modifierOK) return false;
      const eventKey = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
      return eventKey === key;
    };
    // claim() is the standard "we owned this event" sequence: cancel the
    // browser default (bookmark, devtools, downloads, etc) AND stop any
    // later document-level listener from re-handling the same keydown.
    const claim = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (matches(s.hotkeyCallMode)) {
      claim();
      flipMicSetting('micCall');
      return;
    }
    if (matches(s.hotkeyAutoSend)) {
      claim();
      flipMicSetting('micAutoSend');
      return;
    }
    if (matches(s.hotkeyToggleMic)) {
      claim();
      // Toggle voice via startVoice/stopVoice directly. NOT btn.click()
      // (the new mic gesture machine listens to pointer events, not
      // clicks — synthetic clicks are ignored) and NOT touching the
      // gesture machine's internal `micState` (out-of-scope from this
      // listener). The gesture machine's pointerdown handler has a
      // `if (voiceActive()) { stopVoice(); return; }` defensive branch
      // that auto-syncs state when the user next touches the mic — so
      // hotkey-started voice gets stopped correctly by a subsequent
      // tap, and vice versa.
      log('[hotkey] toggleMic — voiceActive=', voiceActive());
      if (voiceActive()) {
        void stopVoice();
      } else {
        // Capture composer cursor BEFORE the rest of the hotkey path
        // (which may not shift focus, but reading at the gesture site
        // is the canonical pattern — same as the pointerdown handler).
        // If textarea was focused when the hotkey fired, this is the
        // user's caret; if focus was elsewhere, it's the last-known
        // selection state, which is still a reasonable insertion point.
        void startVoice(captureComposerCursor());
      }
      return;
    }
  }, true);

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
      try { void webrtcControls.closeIfOpen(); } catch {}
      try { player.pause(); player.src = ''; player.load(); } catch {}
      diag('refresh: location.reload()');
      location.reload();
    };
  }

  log('page loaded, UA:', navigator.userAgent);
}

// ─── Session resume (drawer tap) ────────────────────────────────────────────

/** Replay a transcript into the chat UI after the adapter resumes a session.
 *  Clears current chat, re-renders the messages, and marks history as
 *  loaded so backfillHistory doesn't double-append. */
function replaySessionMessages(
  id: string,
  messages: any[],
  pagination?: { firstId: number | null; hasMore: boolean }
) {
  chat.clear();
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
 *  defensively filter them here. With per-turn replay machinery gutted,
 *  the bubble is purely a text surface: TTS is owned by the WebRTC
 *  talk-mode track on the server side and arrives as audio independently. */
function handleReplyDelta({ replyId, cumulativeText, conversation }: any) {
  if (!cumulativeText) return;
  // Drop deltas for off-screen conversations. Server-side stream keeps
  // running; user can switch back later and the persisted reply will
  // appear via replaySessionMessages.
  if (conversation && conversation !== sessionDrawer.getViewed()) return;
  showStreamingIndicator(cumulativeText, replyId);
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
    return;
  }

  const imageBlocks = extractImageBlocks(content);

  if (NO_REPLY_RE.test(text)) {
    log('suppressed NO_REPLY from agent');
    clearStreamingIndicator();
    return;
  }

  if (text) {
    let bubble = finalizeStreamingBubble(text);
    if (!bubble) {
      bubble = chat.addLine(getAgentLabel(), text, 'agent', { markdown: true, replyId });
    }
    playFeedback('receive');

    try {
      const cards = parseCardsFromText(text);
      for (const c of cards) attachCard(bubble, c);
    } catch (e) { log('card parse err:', e.message); }

    for (const b of imageBlocks) attachCard(bubble, b);
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

/** Push notification handler — cron output, /background results,
 *  scheduled reminders. Backends that support out-of-band push (today:
 *  hermes-gateway via /api/sidekick/notifications) call this; others
 *  never fire it. v1: append a styled system row in the targeted chat
 *  if it's currently being viewed. Off-screen chats get a no-op for
 *  now (a future iteration adds a drawer-side unread badge). Browser
 *  Push API / APNS / Web Push integration is a separate sprint. */
function handleNotification({ chatId, kind, content }: any) {
  // Off-screen chat — drop for v1. The drawer doesn't yet have an
  // unread-badge surface; refresh on switch will pick up the message
  // via the next listSessions / resumeSession round-trip.
  if (chatId && chatId !== sessionDrawer.getViewed()) {
    log(`notification (off-screen) chat=${chatId} kind=${kind}`);
    return;
  }
  const label = kind ? `notification — ${kind}` : 'notification';
  const text = content ? `(${label}) ${content}` : `(${label})`;
  chat.addSystemLine(text);
}

// ─── Go ─────────────────────────────────────────────────────────────────────

boot().catch(err => {
  console.error('SideKick boot failed:', err);
  document.body.textContent = `Boot error: ${err.message}`;
});
