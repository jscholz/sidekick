/**
 * @fileoverview Parley — main entry point. Wires all modules together.
 * No logic lives here — just imports + initialization + cross-module callbacks.
 */

import { loadConfig, getConfig, gwWsUrl, getAppName, applySkinning, onConfigUnreachable } from './config.ts';
import { log, diag, setDebugElement } from './util/log.ts';
import { apiUrl, isLocalShell } from './apiBase.ts';
import { showReconnectModal } from './reconnectModal.ts';
import { mountDevPill, isDevMode } from './util/devMode.ts';
import {
  waitForSwActivation,
  initPassiveUpdateDetector,
  installForceUpdateConsoleHook,
} from './swLifecycle.ts';
import { handleNotification, handleUserMessage } from './backendEvents.ts';
import { initAppTooltip } from './util/tooltip.ts';
import { initScrollDiag } from './scrollDiag.ts';
import {
  initModelCapabilities,
  canAttachFiles,
  fetchModelCaps,
  getVisionFallbackModel,
} from './modelCapabilities.ts';
// streamingIndicator.ts removed — Crack A: rendering is projection-driven.
import {
  initSessionResume,
  replaySessionMessages,
  loadEarlierHistory,
  loadLaterHistory,
  loadGapHistory,
  jumpToLatest,
  drillToMessageInViewedSession,
  prewarmPinnedWindows,
  prewarmActivityWindows,
} from './sessionResume.ts';
import { initNotifications } from './notifications/index.ts';
import * as badge from './notifications/badge.ts';
import { loadMutes } from './notifications/mutes.ts';
import { initVisibilityReporting } from './notifications/visibility.ts';
import * as status from './status.ts';
import { toast } from './toast.ts';
import * as settings from './settings.ts';
import * as setupWizard from './setupWizard.ts';
import * as sessionPins from './sessionPins.ts';
import * as sessionIdentity from './sessionIdentity.ts';
import * as headphones from './audio/shared/headphones.ts';
import * as vadRouting from './audio/shared/vadRouting.ts';
import * as theme from './theme.ts';
import * as wakeLock from './wakeLock.ts';
import * as chat from './chat.ts';
import * as backend from './backend.ts';
import * as conversations from './conversations.ts';
import * as sessionDrawer from './sessionDrawer.ts';
import * as switchCtl from './switchController.ts';
import * as cmdkPalette from './cmdkPalette.ts';
import * as hotkeysHelp from './hotkeysHelp.ts';
import { initPinDrawer, openAllDocs } from './pins/drawer.ts';
import { initCapturePill, hotkeyToggleMeetingCapture } from './capture/pill.ts';
import { initMeetingsIndex } from './capture/meetingsIndex.ts';
import { getCaptureState } from './capture/recorder.ts';
import { initTranscriptHighlight } from './transcriptHighlight.ts';
import * as inAppBanner from './notifications/inAppBanner.ts';
import * as approvalActions from './notifications/approvalActions.ts';
import { installExternalLinkHandler } from './native/externalLinks.ts';
import * as activityStore from './notifications/activityStore.ts';
import { attachSliderTouchAll } from './sliderTouch.ts';
import { createDrawer } from './Drawer.ts';
import * as clickFreezeDiag from './clickFreezeDiag.ts';
import * as remoteControl from './remoteControl.ts';
import * as multiSelect from './multiSelect.ts';
import * as agentSettingsMod from './agentSettings.ts';
import { primeAudio, getSharedAudioCtx } from './audio/shared/platform.ts';
import { cancelReplyTts } from './audio/turn-based/tts.ts';
import * as ttsModule from './audio/turn-based/tts.ts';
import * as replyNavigator from './audio/turn-based/replyNavigator.ts';
import * as replyPlayer from './audio/turn-based/replyPlayer.ts';
import * as audioSession from './audio/shared/session.ts';
import * as capture from './audio/shared/capture.ts';
import * as fakeLock from './ios/fakeLock.ts';
import { setMicPeakListener } from './audio/shared/micMeter.ts';
import { attachCard } from './cards/attach.ts';
import { registerCard } from './cards/registry.ts';
import * as ambient from './ambient.ts';
import { playFeedback, warmFeedback, primeFeedback } from './audio/shared/feedback.ts';
import * as memo from './audio/shared/memo.ts';
import * as turnbased from './audio/turn-based/turnbased.ts';
import * as handsfree from './audio/shared/handsfree.ts';
import * as queue from './queue.ts';
import * as voiceMemos from './voiceMemos.ts';
import * as memoCard from './memoCard.ts';
import * as attachments from './attachments.ts';
import * as draft from './draft.ts';
import * as composer from './composer.ts';
import * as composerDrafts from './composerDrafts.ts';
import * as questionPopup from './questionPopup.ts';
import * as selectToQuote from './selectToQuote.ts';
import * as docStore from './rightDrawer/docStore.ts';
import { selectDocTab } from './rightDrawer/docTabs.ts';
import * as slashCommands from './slashCommands.ts';
import * as webrtcControls from './audio/realtime/controls.ts';
import * as webrtcConnection from './audio/realtime/realtime.ts';
import * as webrtcDictation from './audio/realtime/dictation.ts';
import * as webrtcDictate from './audio/realtime/dictate.ts';
import * as browserDictate from './audio/streaming/browserDictate.ts';
import * as webrtcSuppress from './audio/realtime/suppress.ts';
import * as bgTrace from './bgTrace.ts';
import * as transcriptStore from './transcript/store.ts';
import { bindTranscriptPipeline } from './transcript/index.ts';
import { flushScrollPosition } from './chatScrollPositions.ts';
import { setStayAliveHint as setProxyStayAliveHint } from './proxyClient.ts';
import * as listenReply from './listenReplyState.ts';
import * as handlers from './backendEventHandlers.ts';
import * as memoOutbox from './memoOutbox.ts';
import { createVoiceController } from './voiceController.ts';

// Card kind modules
import imageCard from './cards/kinds/image.ts';
import videoCard from './cards/kinds/video.ts';
import audioCard from './cards/kinds/audio.ts';
import youtubeCard from './cards/kinds/youtube.ts';
import spotifyCard from './cards/kinds/spotify.ts';
import linksCard from './cards/kinds/links.ts';
import markdownCard from './cards/kinds/markdown.ts';
import loadingCard from './cards/kinds/loading.ts';

// ─── State ──────────────────────────────────────────────────────────────────

/** Restore pending memo cards from IndexedDB through the transcript
 *  MODEL (writer migration 2026-07-13): register each record in the
 *  memoCard registry and upsert its decoration into the chat it was
 *  RECORDED in (rec.chatId). Legacy records without a chatId land in
 *  the currently-focused chat, matching the old float-to-current
 *  behavior. Idempotent — addDecoration upserts by key. */
async function restoreMemoCards() {
  try {
    const memos = await voiceMemos.getAll();
    for (const rec of memos) {
      const chatId = rec.chatId ?? switchCtl.focusedId() ?? backend.getCurrentSessionId?.() ?? null;
      memoCard.registerRec(rec, rec.chatId ?? null);
      if (chatId) {
        transcriptStore.addDecoration(chatId, {
          key: `memo:${rec.id}`, kind: 'memo', memoId: rec.id, timestamp: rec.timestamp || Date.now(),
        });
      }
    }
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

/** Remove DOM elements whose `data-platform` attribute doesn't
 *  match the current runtime. Single source of truth for platform-
 *  specific UI gating. Replaces ad-hoc CSS class gates that
 *  specificity wars could leak through.
 *
 *  Supported values (single-value only for now — multi-value
 *  semantics deferred until a real second case justifies the
 *  parser; see the design discussion 2026-05-10 for context):
 *    - 'cap'      → only when running inside Cap WKWebView
 *    - 'pwa'      → only when NOT in Cap (Safari standalone, Chrome, …)
 *    - 'desktop'  → hover + fine pointer (mouse-having devices)
 *    - 'mobile'   → not-desktop
 *
 *  Removed via el.remove() rather than display:none so they can't
 *  tab-focus, fire events, or be announced by AT. Platform is
 *  fixed at boot — no toggle needed. */
function applyPlatformGates(): void {
  const isCap = document.documentElement.classList.contains('capacitor-app');
  const isDesktop = typeof window !== 'undefined'
    && window.matchMedia?.('(hover: hover) and (pointer: fine)').matches === true;
  document.querySelectorAll<HTMLElement>('[data-platform]').forEach(el => {
    const want = el.dataset.platform || '';
    let visible = true;
    if (want === 'cap')          visible = isCap;
    else if (want === 'pwa')     visible = !isCap;
    else if (want === 'desktop') visible = isDesktop;
    else if (want === 'mobile')  visible = !isDesktop;
    if (!visible) el.remove();
  });
}

/** Format a hotkey combo string ("Cmd+Shift+C") for tooltip display
 *  ("⌘⇧C"). Same convention used in the static HTML title attributes
 *  in index.html (e.g. `Send · ⏎`). Lower-cases input first so user-
 *  entered casing variations ("CMD+SHIFT+c", "cmd+Shift+C") all
 *  normalize the same way. Single-character keys uppercased; named
 *  keys (Enter, Escape, etc) left as-is. */
function formatHotkey(combo: string): string {
  if (!combo) return '';
  const parts = combo.split('+').map(p => p.trim().toLowerCase()).filter(Boolean);
  let out = '';
  let key = '';
  for (const p of parts) {
    if (p === 'cmd' || p === 'meta') out += '⌘';
    else if (p === 'ctrl') out += '⌃';
    else if (p === 'alt' || p === 'option') out += '⌥';
    else if (p === 'shift') out += '⇧';
    else key = p;
  }
  if (!key) return out;
  if (key === 'enter') return out + '⏎';
  if (key === 'escape' || key === 'esc') return out + '⎋';
  if (key === 'space') return out + '␣';
  if (key === 'tab') return out + '⇥';
  // Single-character keys: uppercase. Multi-char (F1, ArrowUp): leave as-is.
  return out + (key.length === 1 ? key.toUpperCase() : key);
}

/** True when any call mode is active. Wake-lock + a few other
 *  decisions key off this. Predicate centralised so adding new call
 *  modes (e.g. handsfree) doesn't require auditing every site that
 *  asks "are we in a call?" */
function isInCall(): boolean {
  return turnbased.getState() !== 'idle' || webrtcControls.isOpen() || webrtcControls.isReconnecting();
}

/** Acquire/release the 'setting'-keyed wake-lock based on whether a
 *  call is active AND the user's wakeLock toggle. Idempotent: the
 *  ref-counted holders set in wakeLock.ts no-ops when state matches.
 *
 *  Pre-fix: the lock was acquired on boot if settings.wakeLock=true,
 *  then never released — the phone stayed awake outside calls, draining
 *  battery. Now the lock is gated on isInCall(), so toggling the setting
 *  outside a call is a no-op until the next call starts.
 *
 *  Called from:
 *    - boot (settings.wakeLock=true + already in call after reload)
 *    - settings onWakeLockChange (user toggles)
 *    - webrtcControls onCallStateChange (open/close, mode change)
 *    - turnbased onState (idle ↔ armed/committing/playing/cooldown)
 *
 *  The 'memo' / 'streaming' keys are managed independently in capture.ts. */
function evaluateWakeLock(): void {
  if (settings.get().wakeLock && isInCall()) {
    void wakeLock.acquire('setting');
  } else {
    void wakeLock.release('setting');
  }
}

/** Toggle the composer send button between idle (grey) and active (green).
 *  Sendable = memo recording in progress, typed text, draft content, or
 *  a pending voice transcript ready to send. */
/** Put the caret in the reply box, cursor at the end of whatever draft
 *  is already there (focus() alone can land it at position 0 in some
 *  browsers, which makes Enter-then-type silently prepend). Returns
 *  false when the composer is absent or read-only — the caller then
 *  leaves the keystroke alone rather than claiming it for a no-op. */
function focusComposer(): boolean {
  const input = document.getElementById('composer-input') as HTMLTextAreaElement | null;
  if (!input || readOnlyComposer || input.disabled) return false;
  input.focus();
  const end = input.value.length;
  try { input.setSelectionRange(end, end); } catch { /* not all inputs support it */ }
  return true;
}

function updateSendButtonState() {
  const send = document.getElementById('composer-send') as HTMLButtonElement | null;
  const input = document.getElementById('composer-input') as HTMLTextAreaElement | null;
  if (!send) return;
  const sendable = !readOnlyComposer
    && (memoActive
      || (input?.value?.trim().length ?? 0) > 0
      || draft.hasContent()
      || attachments.hasPending());
  send.classList.toggle('active', sendable);
  send.disabled = !sendable;
  // Same choke point, same question ("what's in the box?"): the clear ✕
  // is gated on composer content, so every path that re-evaluates the
  // send button must re-evaluate it too. Programmatic writes to
  // composerInput.value (slash commands, dictation, rescue) don't fire
  // an `input` event, and this is the one call they all already make.
  syncComposerEditButtons();
}

/** Gate the composer's clear (✕) and restore (↩) controls on the state
 *  that makes each meaningful — content in the box, and an un-spent undo
 *  buffer for the bound chat respectively. Neither adds chrome at rest
 *  (Jonathan, 2026-08-30). Module-level so updateSendButtonState can
 *  reach it; queries the DOM per call, like its neighbour. */
function syncComposerEditButtons(): void {
  const input = document.getElementById('composer-input') as HTMLTextAreaElement | null;
  const clearBtn = document.getElementById('composer-clear') as HTMLButtonElement | null;
  const restoreBtn = document.getElementById('composer-restore') as HTMLButtonElement | null;
  if (clearBtn) clearBtn.hidden = !(input?.value ?? '');
  if (restoreBtn) restoreBtn.hidden = !composerDrafts.hasClearedText(composerDrafts.boundTo());
  // The pair overlays the composer's top-right corner, and a <textarea>
  // cannot reflow around a child — so the field reserves right-hand room
  // ONLY while one of them is actually showing. Padding permanently would
  // cost ~9% of line width on a phone for a rarely-used control.
  try {
    const occupied = !!((clearBtn && !clearBtn.hidden) || (restoreBtn && !restoreBtn.hidden));
    document.body.classList.toggle('has-composer-edit', occupied);
  } catch { /* non-browser */ }
}

/** Whether the composer is currently in read-only mode — set true
 *  when the user is viewing a non-parley chat (telegram/slack/etc).
 *  Cross-platform send isn't supported (the gateway's parley adapter
 *  always builds SessionSource(platform=PARLEY), so a send to a
 *  telegram chat_id would create a duplicate parley session rather
 *  than reaching telegram). Disabling input + send button is the
 *  honest affordance. */
let readOnlyComposer = false;

function setComposerReadOnly(readOnly: boolean, source: string = 'parley') {
  readOnlyComposer = readOnly;
  const input = document.getElementById('composer-input') as HTMLTextAreaElement | null;
  if (input) {
    input.disabled = readOnly;
    if (readOnly) {
      input.placeholder = `View only — sent via ${source}`;
      input.classList.add('readonly');
    } else {
      // Must match the index.html placeholder. setComposerReadOnly(false)
      // is called whenever switching to a parley chat, so this is the
      // source of truth at runtime (not the HTML attribute, which gets
      // overwritten on first call). Stay in sync if you change one.
      input.placeholder = 'Type / for commands';
      input.classList.remove('readonly');
    }
  }
  updateSendButtonState();
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

// ─── Offline-first send queue (field 2026-07-21) ────────────────────────────
// Sends are never GATED on backend.isConnected(): it mirrors the SSE
// EventSource state, which flaps constantly on spotty mobile links even
// while a plain POST would succeed (the walking-with-phone case). Every
// composer/draft send is attempted immediately; a CONNECTIVITY-class
// failure (fetch network error — the gateway never answered) keeps the
// optimistic bubble `.pending` and parks the send here until the stream
// channel reconnects (onStatus(true) → flushQueuedSends). An ANSWERED
// rejection (`Parley HTTP <status>` from the proxy) is a real refusal
// → the existing `.failed` Retry affordance, exactly as before.
// In-memory by design: it rides the same lifetime as the pendingSends
// store the bubbles live in — a reload drops both together, so a queued
// send can never outlive (and double-post behind) its visible bubble.
type QueuedSend = {
  chatId: string | null;
  messageId: string;
  text: string;
  sendOpts: Record<string, any>;
  flushes: number;
};
const queuedSends: QueuedSend[] = [];
/** A flush re-attempts a queued send at most this many times before
 *  giving up and surfacing the `.failed` Retry affordance — a
 *  genuinely-unreachable send must not sit silently `.pending` forever. */
const QUEUED_SEND_MAX_FLUSHES = 3;
let queuedSendFlushInFlight = false;

// Backoff timer for queued sends. The reconnect handler (onStatus(true)
// → flushQueuedSends) only covers failures where the SSE channel ALSO
// dropped; a POST can network-fail while the stream stays up (server
// blip, half-open link — the retry-keeps-attachments shape), and with
// no reconnect transition ever firing, the queued send would sit
// `.pending` forever. The timer retries with backoff (1s→2s→4s) while
// the channel is CONNECTED — three misses exhaust the flush budget
// (~7s) and surface the `.failed` Retry affordance. While DISCONNECTED
// it just re-arms without attempting: the budget must not burn on a
// dead link (the walking case queues indefinitely until reconnect,
// which is the point).
let queuedSendRetryTimer: ReturnType<typeof setTimeout> | null = null;
let queuedSendRetryDelayMs = 1000;
const QUEUED_SEND_RETRY_MAX_DELAY_MS = 8000;

function scheduleQueuedSendRetry(): void {
  if (queuedSendRetryTimer != null || queuedSends.length === 0) return;
  queuedSendRetryTimer = setTimeout(() => {
    queuedSendRetryTimer = null;
    if (!backend.isConnected()) {
      scheduleQueuedSendRetry();   // safety-net re-arm; reconnect flush is primary
      return;
    }
    queuedSendRetryDelayMs = Math.min(queuedSendRetryDelayMs * 2, QUEUED_SEND_RETRY_MAX_DELAY_MS);
    void flushQueuedSends().then(() => {
      if (queuedSends.length === 0) queuedSendRetryDelayMs = 1000;
      else scheduleQueuedSendRetry();
    });
  }, queuedSendRetryDelayMs);
}

/** Shared send-failure surface: status line + flip the optimistic bubble
 *  to `.failed` (renders the Retry button that restores the composer). */
function failSendBubble(chatId: string | null, messageId: string, msg: string): void {
  diag(`sendMessage failed: ${msg}`);
  status.setStatus(`Send failed: ${msg}`, 'err');
  if (chatId) transcriptStore.markPendingSendFailed(chatId, messageId);
}

/** Connectivity-class = the request never got an answer (fetch network
 *  error/abort). proxyClient prefixes ANSWERED rejections with
 *  "Parley HTTP <status>" — those mean the gateway is reachable and
 *  refused the send; retrying on reconnect can't fix them. */
function isConnectivitySendError(e: unknown): boolean {
  return !/^Parley HTTP \d/.test(String((e as Error)?.message ?? e ?? ''));
}

/** Has the server's user_message echo for this send already landed?
 *  The flush uses this to skip re-POSTing a send whose ORIGINAL POST
 *  actually reached the gateway but whose 202 was lost to the dying
 *  link — the echo arrives with the reconnect ring replay, before the
 *  flush runs. Checked via the echo record (inflight/durable), not the
 *  pendingSend's absence: a session switch/new-chat clearAll() also
 *  drops pendingSends, and that must NOT silently discard a queued
 *  message that never reached the server. */
function sendEchoSeen(chatId: string | null, messageId: string): boolean {
  if (!chatId) return false;
  const s = transcriptStore.peekState(chatId);
  if (!s) return false;
  return s.inflight.some((e: any) => e.type === 'user_message' && e.message_id === messageId)
    || s.durable.some((d: any) => d.parley_id === messageId);
}

/** Offline-first send dispatch. Fire the POST now; classify a failure as
 *  connectivity (→ queue for reconnect, bubble stays `.pending`) or an
 *  answered refusal (→ `.failed` Retry affordance). Never throws. */
function sendOrQueueMessage(
  chatId: string | null,
  messageId: string,
  text: string,
  sendOpts: Record<string, any>,
): void {
  Promise.resolve()
    .then(() => backend.sendMessage(text, sendOpts))
    .catch((e: unknown) => {
      const msg = (e as Error)?.message || String(e);
      if (!isConnectivitySendError(e)) {
        failSendBubble(chatId, messageId, msg);
        return;
      }
      diag(`send queued (offline): chat=${chatId} msg=${messageId} — ${msg}`);
      queuedSends.push({ chatId, messageId, text, sendOpts, flushes: 0 });
      scheduleQueuedSendRetry();
      // Passive signal only — the interaction already committed (bubble
      // is on screen `.pending`, composer cleared). Never gates anything.
      status.setStatus('Offline — message queued', 'err');
    });
}

/** Re-POST queued sends. Fired on every disconnected→connected
 *  transition (onStatus in boot()). Sequential + single-flight so two
 *  rapid status flips can't double-send the same message. */
async function flushQueuedSends(): Promise<void> {
  if (queuedSendFlushInFlight || queuedSends.length === 0) return;
  queuedSendFlushInFlight = true;
  try {
    const batch = queuedSends.splice(0);
    for (const q of batch) {
      if (sendEchoSeen(q.chatId, q.messageId)) continue;   // original POST landed
      try {
        await backend.sendMessage(q.text, q.sendOpts);
      } catch (e: unknown) {
        const msg = (e as Error)?.message || String(e);
        q.flushes += 1;
        if (isConnectivitySendError(e) && q.flushes < QUEUED_SEND_MAX_FLUSHES) {
          queuedSends.push(q);   // still unreachable — hold for the next reconnect
        } else {
          failSendBubble(q.chatId, q.messageId, msg);
        }
      }
    }
  } finally {
    queuedSendFlushInFlight = false;
    // Items can remain after a flush (requeued connectivity misses or
    // pushes that raced the batch splice) — keep the backoff loop alive
    // so they can't strand `.pending` when no reconnect ever fires.
    scheduleQueuedSendRetry();
  }
}

// ─── Boot ───────────────────────────────────────────────────────────────────

async function boot() {
  // ── Boot-phase timing (temporary instrumentation, #171 follow-up) ──
  // Pinpoints which boot phase eats wall-clock on a cold CAP relaunch.
  // Surfaces via log() → disk relay (/tmp/parley-debug/latest.log) when
  // dev mode / ?debug-relay=1 is on. perfNow() is relative to navigation
  // start, so the first mark also shows pre-boot bundle parse/eval time.
  const perfNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const __bootT0 = perfNow();
  const bootMark = (label: string) => {
    log(`[boot-timing] ${label} +${Math.round(perfNow() - __bootT0)}ms (since-nav ${Math.round(perfNow())}ms)`);
  };
  bootMark('start');

  // Platform gating runs FIRST so settings.load() and downstream
  // wiring see the post-gate DOM. Otherwise settings.ts's
  // `document.getElementById('set-reset-server')` returns the
  // about-to-be-removed button and attaches a click handler to a
  // dead reference — works (because removal detaches listeners
  // automatically) but the order is confusing to read.
  applyPlatformGates();

  // Hydrate settings BEFORE any UI wiring reads them. Earlier
  // settings.load() lived ~300 lines down in boot, after toolbar wiring,
  // which made btn-transport's sync() read DEFAULTS instead of the stored
  // value — the toggle would flip in storage but the highlight wouldn't
  // reflect it. Generally: any boot code that calls settings.get() before
  // this line was reading uninitialised defaults.
  // Async now: yaml-backed settings come from /api/parley/config; the
  // remaining per-device keys are read from localStorage in the same
  // call. Built-in DEFAULTS are the offline / proxy-down fallback.
  await settings.load();
  bootMark('settings.load done');
  // First-run model gate — fire-and-forget probe; on a fresh trial
  // install (stub echo LLM) it opens the setup wizard. Fail-open:
  // errors mean no gate, never a locked UI.
  void setupWizard.init();
  // Pinned-session order rides the synced `pinnedSessions` setting, so
  // hydrate it from the snapshot settings.load() just pulled — before
  // the drawer's first render reads sessionPins.isPinned()/topPinned().
  sessionPins.hydrate();
  // Per-session identity (nickname + voice) rides the synced
  // `sessionIdentities` setting — hydrate from the same snapshot before
  // the drawer's first render reads nicknameFor()/voiceFor().
  sessionIdentity.hydrate();

  // Load config from server (keys, gateway info). In the CAP local-asset
  // shell the app boots from bundled assets and only reaches the backend
  // over the network — so if the saved host is down, surface a dismissible
  // reconnect prompt instead of stranding the user. loadConfig() falls back
  // to the last-good cached snapshot when present (boot continues); it only
  // throws on a truly cold first-launch-offline, where we show the prompt
  // over a bare shell.
  if (isLocalShell()) onConfigUnreachable(() => showReconnectModal());
  try {
    await loadConfig();
  } catch (e: any) {
    if (isLocalShell()) {
      log(`boot: config unreachable and no cache (${e?.message || e}); awaiting reconnect`);
      showReconnectModal();
      return;
    }
    throw e;
  }
  bootMark('loadConfig done');
  const cfg = getConfig();
  // Apply per-install skinning (app name, subtitle, theme color) before the
  // rest of the UI renders so branding is consistent from boot.
  applySkinning();

  // Debug panel — Ctrl+Shift+D on desktop, triple-tap header on mobile
  setDebugElement(document.getElementById('debug'));
  // Dev-mode pill + long-press toggle on the version label. Renders
  // a "DEV" badge next to "v0.473" when localStorage.dev_mode='1'.
  // See src/util/devMode.ts for the rationale (unmissable transparency).
  mountDevPill();
  // Fallback version label for runtimes where the service worker
  // can't deliver a version string — Capacitor's WKWebView blocks SW
  // registration, so #app-version stays at the "—" default forever
  // and the long-press surface is a tiny invisible target. Also a
  // back-stop for browsers where SW takes a long time to respond.
  // Wait briefly, then if still empty, write a generic label so the
  // long-press hit area is visibly a real button.
  setTimeout(() => {
    const vEl = document.getElementById('app-version');
    if (vEl && (vEl.textContent === '—' || vEl.textContent?.trim() === '')) {
      vEl.textContent = (window as any).Capacitor ? 'cap' : 'live';
    }
  }, 2500);
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
  // localStorage.parley_bg_trace=1. Noop when not enabled. Install
  // before audioSession/capture touch anything so we catch the first
  // transitions. Getters are lazy — each poll reads live state, no
  // eager construction.
  bgTrace.install({
    getStream: () => capture.getActiveStream(),
    getAudioCtx: () => getSharedAudioCtx(),
    getKeepaliveEl: () => audioSession.getKeepaliveEl(),
  });
  // Expose dump() globally when tracing is enabled so the bench-test
  // protocol can grab the buffer from devtools with `parleyBgTrace()`
  // and paste it into a bug report.
  if (bgTrace.isEnabled()) {
    (window as any).parleyBgTrace = () => bgTrace.dump();
  }

  // Background audio session — Media Session (lock-screen + BT headset tap)
  // + silent keepalive. BT taps map to play/pause handlers; in WebRTC mode
  // these toggle the active call (mic stream / talk) on or off.
  audioSession.init({
    onPlay: () => {
      // BT play priority order:
      //   1. If a TTS reply is paused mid-stream, resume it (per-reply
      //      replay nav — pairs with onPause below).
      //   2. Otherwise, if a WebRTC call isn't open, open one via the
      //      mic button (respects user's call/PTT/auto-send toggles).
      if (ttsModule.isPaused()) {
        void ttsModule.resumeReplyTts();
        return;
      }
      if (webrtcControls.isOpen()) return;
      const btnMicEl = document.getElementById('btn-mic');
      if (btnMicEl) btnMicEl.click();
    },
    onPause: () => {
      // BT pause priority order:
      //   1. If a TTS reply is currently playing, pause it (per-reply
      //      replay nav — "truck driving by, lemme pause" UX).
      //   2. Otherwise close any open WebRTC call.
      if (ttsModule.getActiveReplyId() && !ttsModule.isPaused()) {
        ttsModule.pauseReplyTts();
        return;
      }
      if (webrtcControls.isOpen()) {
        void webrtcControls.closeIfOpen('mediasession-pause');
      }
    },
    onStop: () => {
      // BT explicit stop: same as pause for now — close the call.
      if (webrtcControls.isOpen()) {
        void webrtcControls.closeIfOpen('mediasession-stop');
      }
    },
    onForeground: () => {
      // No-op: WebRTC peer connection auto-recovers via ICE; classic-mode's
      // SR-recovery hop isn't needed.
    },
    // BT track-skip / lock-screen skip → per-reply replay within the
    // current chat. Skip-forward = next agent reply (re-synth via /tts
    // if not cached); skip-back = previous agent reply (cache hit on
    // anything already played this session). Replaces the earlier
    // chat-navigation wiring: move a pointer back and forward over
    // agent replies, generating them if needed.
    onNextTrack: () => { void replyNavigator.playNext(); },
    onPrevTrack: () => { void replyNavigator.playPrev(); },
    // seekto: reserved for a future "seek inside the current TTS reply"
    // feature (skip 30s into a long answer). Not wired today.
    onSeekTo: (_seconds: number) => { /* reserved */ },
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
  if (btnLock) btnLock.onclick = () => {
    // Pocket-lock only makes sense when audio is actually live —
    // otherwise the user is staring at a locked screen with nothing
    // happening, and the unlock-swipe affordance is just confusing.
    // Gate on voiceActive() (memo || dictate || webrtc || listen) OR a
    // live meeting capture (field ask 2026-07-09: pocketing the phone
    // mid-meeting is exactly what capture is FOR).
    if (!voiceActive() && !getCaptureState().active) {
      try { status.setStatus('Start a call or recording first', 'err'); } catch {}
      return;
    }
    // iOS pocketlock waveform fix (2026-05-01): force the audio prime
    // INSIDE the lock-button click gesture so the shared AudioContext
    // is created + resumed while the gesture is still live. fakeLock's
    // mic-meter wiring (attachMicAnalyserWhenReady → getMicAnalyser)
    // needs getSharedAudioCtx() to be non-null — without primeAudio
    // here, the shared context stays null on iOS until some other
    // gesture (memo/send) touches audio. Idempotent: primeAudio no-ops
    // if already primed + route is fresh.
    try { primeAudio(player); } catch { /* defensive */ }
    fakeLock.show();
  };

  const defaultDrawerWidthPx = () => Math.max(320, Math.min(Math.round(window.innerWidth * 0.24), 420));
  // Drag ceiling = a user-tunable % of the window (settings → Display → Panel
  // max width, default 60%). No absolute px cap: on a wide external monitor the
  // old min(60vw, 900px) capped panels at ~900px (~35% of a 2560px display), so
  // they never read as a main column. Floor at 320px so a tiny window still
  // permits a usable panel.
  const maxDrawerWidthPx = () =>
    Math.max(320, Math.round(window.innerWidth * (settings.get().panelMaxWidthPct / 100)));

  // Sidebar — always visible (48px rail), expands on hamburger. Holds
  // new-chat, sessions list (if backend supports it), and info/settings
  // at the bottom. Desktop: expand state persists across reload and shifts
  // body content right (Gemini-style). Mobile: overlay-style, never
  // persisted (taps outside collapse it so the chat reclaims focus).
  // Sidebar (left drawer) — open/close/swipe/resizer/click-outside/
  // Escape/persistence all wired through the unified Drawer module.
  // Same chrome the pin drawer uses; only the side + body class +
  // resizer CSS-var differ.
  const sidebarHandle = createDrawer({
    id: 'sidebar',
    side: 'left',
    bodyClass: 'sidebar-expanded',
    prefKey: 'parley.sidebar.expanded',
    toggleIds: ['sb-toggle', 'sb-toggle-mobile'],
    excludeSwipeWhenTargetIn: ['#pin-drawer'],
    resizer: {
      handleId: 'sidebar-resizer',
      cssVar: '--sidebar-width',
      widthPrefKey: 'parley.sidebarWidth.v3',
      defaultWidthPx: defaultDrawerWidthPx(),
      minWidthPx: 260,
      maxWidthPx: maxDrawerWidthPx,  // getter: tracks the setting live
    },
    onOpen: () => sessionDrawer.refresh(),  // fresh data on open
  });
  void sidebarHandle;  // currently no caller needs the handle externally

  // Capture-phase pointerdown logger for click-freeze diagnosis. Pure
  // observation, but it installs timers/listeners, so keep it strictly
  // behind explicit diagnostics instead of taxing phone PWAs in normal use.
  if (new URLSearchParams(location.search).get('click_diag') === '1'
      // legacy name, predates Parley rename — dev toggle, not worth migrating
      || localStorage.getItem('parley_click_diag') === '1') {
    clickFreezeDiag.init();
  }

  // Mobile: strip native `title` attributes from all buttons so taps
  // don't surface the system tooltip popup (iOS especially). aria-label
  // covers accessibility. No-op on desktop. Idempotent.
  void (async () => {
    const { installMobileTooltipSuppression } = await import('./util/mobileTooltips.ts');
    installMobileTooltipSuppression();
  })();

  // Lockscreen + BT-headset remote-control receiver. Cap forwards
  // MPRemoteCommandCenter callbacks via custom events; PWA uses the
  // Media Session API. Both feed the same dispatcher (stop = end call,
  // play/pause = TTS reply pause/resume).
  remoteControl.init();

  // Drop a chat we're navigating AWAY from if it's an empty placeholder
  // — 0 messages on the backend AND no unsent draft text AND no
  // pending attachments. Mirrors the new-chat rotation cleanup below
  // (search "Background cleanup: drop any OTHER stale 0-msg") but
  // triggered on navigation rather than rotation. Fire-and-forget so
  // the chat-switch UX doesn't wait on the IDB write or the proxy
  // round-trip; refresh paints the drawer once the deletes settle.
  // Drafts + attachments are intentional user investment — those rows
  // survive even with 0 backend messages.
  function cleanupAbandonedChat(leavingId: string | null): void {
    if (!leavingId) return;
    if (draft.hasContent() || attachments.hasPending()) return;
    // In-flight skip: if the user just sent a message and hermes hasn't
    // yet persisted (post-turn append_to_transcript), `cached.messageCount`
    // is still 0 — the cleanup heuristic below would treat this as an
    // unsent orphan and wipe the local IDB row. On switch-back,
    // resumeSession.hydrate(id) recreates the row with default 'New chat',
    // erasing the snippet we stamped on send AND (post-reply, after
    // inflight cache drops) leaving the transcript empty. Field bug
    // 2026-05-11 — TEST #1 + TEST #4 in /tmp/real-timer-flow.mjs.
    //
    // Signal: proxyClient.sendMessage stamps the IDB title with the
    // user's first message snippet. If the title is anything other than
    // the 'New chat' placeholder, the user sent SOMETHING — never
    // auto-clean. Async IDB read, fire-and-forget the rest of the work
    // so the switch UI isn't blocked.
    void (async () => {
      const local = await conversations.get(leavingId).catch(() => null);
      if (local && local.title && local.title !== 'New chat') {
        diag(`navigate-away: skipping cleanup of ${leavingId} — IDB title=${JSON.stringify(local.title)} indicates user content`);
        return;
      }
      cleanupAbandonedChatInner(leavingId);
    })();
  }

  function cleanupAbandonedChatInner(leavingId: string): void {
    // CONTRACT (post-v0.383 unification, 2026-05-03):
    // Auto-cleanup is LOCAL-IDB-ONLY. backend.deleteSession is reserved
    // for explicit user actions (menu delete, multi-select bulk).
    //
    // Replaces the pre-unification rule "refuse if id contains ':'":
    // post-IDB-schema-v2 EVERY id is prefixed (mintChatId stamps
    // `parley:`; cross-device hydrate carries the gateway prefix),
    // so the old gate would refuse every cleanup. The new rule keys
    // off whether the SERVER knows about the row, not the id shape:
    //   - cached row not in sessions list  → server never registered;
    //                                        local-only orphan, drop it.
    //   - cached row found, messageCount=0 → real-but-empty (e.g. a
    //                                        send aborted before any
    //                                        message landed); also a
    //                                        local-only orphan from
    //                                        the user's perspective.
    //   - otherwise                        → server owns the lifecycle,
    //                                        refuse to auto-clean.
    //
    // Pre-fix this called backend.deleteSession on bare ids; the
    // plugin's un-prefixed DELETE fallback wiped real sessions whose
    // chat_id matched a bare local-IDB orphan and accidentally deleted
    // it. This path now NEVER touches the backend.
    const cached = sessionDrawer.getCachedSessions().find(s => s.id === leavingId);
    const serverKnowsRow = !!cached && cached.messageCount > 0;
    if (serverKnowsRow) return;
    diag(`navigate-away: dropping local-only orphan ${leavingId}`);
    void conversations.remove(leavingId)
      .catch((e: any) => diag(`navigate-away cleanup failed: ${e?.message}`))
      .then(() => sessionDrawer.scheduleRefresh());
  }

  // (Sidebar resizer is now handled inside the createDrawer call
  // above — single chrome module for both drawers.)

  // Bulk-select panel — appears when the user shift-clicks 2+ drawer
  // rows. Reads stats from the cached session list (no extra fetch);
  // delete fires the same `backend.deleteSession` cascade individual
  // row deletes do.
  multiSelect.init({
    getSessions: () => sessionDrawer.getCachedSessions() as any,
    // Route bulk delete through sessionDrawer's atomic path so it picks
    // up recentlyDeleted, the switchController epoch bump, optimistic/
    // viewed clears, and IDB cache patch — same race protections as the
    // row-menu delete.
    // Pre-refactor this called backend.deleteSession directly and missed
    // every one of those surfaces (latent bug; tests didn't exercise the
    // race for bulk).
    deleteOne: (id: string) => sessionDrawer.deleteSessionFromUI(id),
    onClear: () => sessionDrawer.clearMultiSelect(),
  });

  // Session list inside the sidebar — renders when backend supports browsing.
  sessionDrawer.init({
    // sessionDrawer's onResumeCb passes inflight as the 4th arg and (for
    // drill navigations) targetMessageId as the 5th; replaySessionMessages
    // orders targetMessageId before inflight, so adapt the slots here.
    // The switch token rides through — replaySessionMessages refuses to
    // paint if it has been superseded (invariant #1).
    onResume: (tok: switchCtl.SwitchToken, messages: any[], pagination?: any, inflight?: any[], targetMessageId?: string) =>
      replaySessionMessages(tok, messages, pagination, targetMessageId, inflight),
    onBeforeSwitch: cleanupAbandonedChat,
    onMultiSelectChange: (ids: string[]) => multiSelect.update(ids),
    // Stale-foreground recovery: if the session the user is currently
    // viewing gets deleted out from under them (menu delete, bulk wipe,
    // backend nuke), drop the ghost transcript and rotate to a fresh
    // chat surface so they can keep going.
    onSessionGone: () => {
      diag('reset history: viewed session disappeared from server');
      const viewed = switchCtl.viewedId();
      if (viewed) transcriptStore.clearAll(viewed);
      draft.dismiss();
      voiceMemos.clearAll().catch(() => {});
      historyLoaded = false;
      backend.newSession?.();
      chat.addSystemLine('The session you were viewing was deleted. Started a fresh chat.');
    },
  });
  // Cache-first sidebar paint (Path B). loadAdapter() is a local dynamic
  // import (no network) — once it resolves, capabilities() reports
  // sessionBrowsing and refresh() renders the IDB session-list cache
  // immediately, then revalidates from the server in the background.
  // Without this, the first sidebar paint waited on backend.connect()'s
  // SSE handshake — the bulk of the ~10s relaunch stall.
  void backend.loadAdapter().then(() => sessionDrawer.refresh());
  // A cache-first boot may paint synced-pref-backed drawer state (pin
  // order, per-session nicknames) from a slightly stale snapshot. When the
  // background settings revalidation lands, re-hydrate those stores and
  // repaint so a change made on another device catches up without a reload.
  window.addEventListener('parley:settings-changed', () => {
    sessionPins.hydrate();
    sessionIdentity.hydrate();
    sessionDrawer.scheduleRefresh();
  });
  // Cmd+K palette — instant session filter + debounced messages_fts
  // search. Resume hits funnel through replaySessionMessages so behavior
  // matches a normal drawer tap.
  cmdkPalette.init({
    onResume: replaySessionMessages,
    onBeforeSwitch: cleanupAbandonedChat,
    // Wrapped so the const drillToChatMessage (declared further down)
    // is resolved at call time, not at init time — avoids TDZ. cmd+K
    // message hits ROUTE through drillToChatMessage so they get the
    // around-window fetch when the target is below the initial tail.
    // Without this wiring the cmd+K bug 2026-06-23 surfaces: search
    // matches an old message ("pareto" months ago); clicking the hit
    // calls resumeSession (tail only); target isn't in the loaded
    // page; scrollIntoView silently no-ops and the user sees "click
    // did nothing." Routed through drillToChatMessage, the same path
    // pin clicks + activity opens use, click-jump is reliable.
    onDrillToMessage: (chatId, msgId) => drillToChatMessage(chatId, msgId),
  });
  // Cmd+/ (mac) / Ctrl+/ (other) → keyboard-shortcut reference modal.
  // Pure UI; binds a document-level keydown listener and renders a
  // lazy <dialog> on first open. No deps on backend/proxy state.
  hotkeysHelp.init();
  const composerHotkeysHint = document.getElementById('composer-hotkeys-hint') as HTMLButtonElement | null;
  if (composerHotkeysHint) {
    const isAppleHost = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');
    const helpCombo = isAppleHost ? '⌘/' : 'Ctrl+/';
    const modKey = composerHotkeysHint.querySelector<HTMLElement>('[data-hotkey-mod]');
    if (modKey) modKey.textContent = isAppleHost ? '⌘' : 'Ctrl';
    composerHotkeysHint.title = `Keyboard shortcuts · ${helpCombo}`;
    composerHotkeysHint.setAttribute('aria-label', `Keyboard shortcuts · ${helpCombo}`);
    composerHotkeysHint.onclick = () => hotkeysHelp.open();
  }
  // Pin drawer — right-side surface aggregating pinned messages across
  // every chat. Click handler reuses the cmdk drill-to-message path:
  // resumeSession to fetch + render, then targetMessageId so the
  // replaySessionMessages scrolls + flashes the pinned bubble.
  //
  // Shared by pin drawer + in-app notification banner — both drill
  // into a chat from an out-of-chat surface and want the same
  // resume + replay + scroll-to behavior.
  const drillToChatMessage = async (
    chatId: string, msgId: string | null,
    opts: { validateExists?: boolean } = {},
  ): Promise<boolean> => {
    // #241 instrumentation: capture the chatId/msgId the surface (pin /
    // activity / banner) actually handed in, alongside the live view state,
    // so a field repro of "pin opens the WRONG session" tells us whether the
    // pin carried a stale chatId (data-model bug) or the render diverged from
    // a correct chatId (server/race). Pair with the [chat-resume] enter and
    // `sessionDrawer: resumed` render-side logs.
    diag(`[drill #241] invoked chatId=${chatId} msgId=${msgId ?? '∅'} `
      + `viewed=${switchCtl.viewedId() ?? '∅'} optimistic=${switchCtl.optimisticId() ?? '∅'}`);
    if (opts.validateExists) {
      // Stale-link guard for activity items. The cheap path: the session
      // is in the drawer's already-loaded list — then it exists, skip the
      // server probe entirely so the drill stays instant (drillTo blanks
      // the transcript + spins synchronously). Only when the chat is NOT
      // in the cached list (rare — stale link to a deleted session, or a
      // brand-new chat the list hasn't picked up yet) do we pay a server
      // round-trip to distinguish "deleted" from "not-yet-listed". This
      // removes the ~1MB blocking fetchSessionMessages that used to gate
      // EVERY activity jump with no feedback (field 2026-05-29).
      const bare = (x: string) => String(x || '').replace(/^parley:/, '');
      const known = sessionDrawer.getCachedSessions()
        .some((s: any) => bare(s.id) === bare(chatId));
      if (!known) {
        try {
          const probe: any = await backend.fetchSessionMessages(chatId);
          const hasContent = (probe.messages || []).length > 0 || (probe.inflight || []).length > 0;
          if (!hasContent) {
            diag(`drill: ${chatId} has no durable/inflight messages; dropping stale activity link`);
            status.setStatus('That activity item no longer has a session.', 'err');
            return false;
          }
        } catch (e: any) {
          diag(`drill: validation fetch ${chatId} failed: ${e?.message ?? e}`);
          status.setStatus('Could not open that activity item.', 'err');
          return false;
        }
      }
    }
    // Route through the drawer's cache-first resume() — same path a
    // sidebar row click uses — so the drill is atomic + cacheable: the
    // target row highlights synchronously, the transcript paints from IDB
    // cache first, and the server reconcile follows. drillTo also fires
    // onBeforeSwitch (cleanupAbandonedChat) internally, so we don't call
    // it here. Replaces the old fully-server-gated resumeSession + replay
    // that left the highlight flickering for 3-13s over a high-latency
    // link over high-latency connections.
    // Same-session jump (the chat is ALREADY on screen): do NOT re-resume.
    // resume() double-renders + its in-flight dedup keys only on chat id,
    // so a rapid second jump to a different target in the same session was
    // dropped (bubble never appeared) and deep jumps fired redundant
    // concurrent ~1MB fetches. Route straight to a single bounded around
    // fetch (or an in-DOM scroll when the bubble is already rendered).
    const bare = (x: string) => String(x || '').replace(/^parley:/, '');
    if (msgId && bare(switchCtl.viewedId() || '') === bare(chatId)) {
      try {
        await drillToMessageInViewedSession(chatId, msgId);
        return true;
      } catch (e: any) {
        diag(`drill: same-session drill ${chatId} failed: ${e?.message ?? e}`);
        return false;
      }
    }
    try {
      await sessionDrawer.drillTo(chatId, msgId ?? undefined);
      return true;
    } catch (e: any) {
      diag(`drill: drillTo ${chatId} failed: ${e?.message ?? e}`);
      return false;
    }
  };
  // In-app notification banner — when a notification envelope arrives
  // for a chat OTHER than the currently-viewed one, show a top-of-
  // viewport toast. Tap → same drill path as the pin drawer (resume +
  // replay + scroll to data-message-id = parley_id).
  const approvalCommandForAction = (action: inAppBanner.ApprovalAction): string => {
    if (action === 'approve_session') return '/approve session';
    if (action === 'deny') return '/deny';
    return '/approve';
  };
  const sendApprovalAction = async (
    chatId: string,
    action: inAppBanner.ApprovalAction,
    msgId: string | null,
  ): Promise<void> => {
    const cmd = approvalCommandForAction(action);
    await drillToChatMessage(chatId, msgId);
    const userMessageId = `umsg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    transcriptStore.addPendingSend(chatId, {
      messageId: userMessageId,
      text: cmd,
      source: 'text',
      sentAt: Date.now(),
    });
    const failBubble = (msg: string) => {
      diag(`approval action failed: ${msg}`);
      status.setStatus(`Approval action failed: ${msg}`, 'err');
      transcriptStore.markPendingSendFailed(chatId, userMessageId);
    };
    try {
      // chatId pinned at tap time: without it sendMessage targets the
      // module-level active chat, so switching sessions while the
      // drill above is in flight routed /approve into the wrong chat
      // (field bug 2026-06-12, CAP).
      const p = backend.sendMessage(cmd, { userMessageId, chatId });
      if (p && typeof (p as any).catch === 'function') {
        (p as Promise<unknown>).catch((e) => failBubble((e as Error)?.message || String(e)));
      }
    } catch (e: any) {
      failBubble(e?.message || String(e));
    }
  };
  initPinDrawer({
    onPinClick: (chatId, msgId) => { void drillToChatMessage(chatId, msgId); },
    onActivityOpen: (chatId, msgId) => drillToChatMessage(chatId, msgId, { validateExists: true }),
    onApprovalAction: (chatId, action, msgId) => { void sendApprovalAction(chatId, action, msgId); },
    // Doc reader "Open chat" (2026-08-26: "a link from the meeting
    // recording doc to the companion session so the user can ask
    // questions about it") — same drill path as a pin jump, no target
    // message: land on the session's tail.
    onOpenChat: (chatId) => { void drillToChatMessage(chatId, null); },
  });
  // Meeting-capture pill + entry points (mic menu item, ?capture=start,
  // capture_control envelopes) — app-global chrome, survives session
  // switches by construction (capture plan §3.4/§3.6).
  //
  // openChat is a purpose-built OPTIMISTIC landing (walking-test spec
  // 2026-07-10): the minted meeting session is EMPTY by construction,
  // so fetch-first paths (drill/resume spinners) are pure friction.
  // Paint the clean shell instantly — status line, focused composer,
  // zero spinners — and let the start-message arrive via SSE like any
  // live envelope. backend.resumeSession is fired in the BACKGROUND
  // purely to flip the adapter's active-chat send pointer (it does so
  // synchronously at call, before its fetch — proxyClient.ts) and to
  // reconcile anything that raced ahead.
  const openMeetingSession = (chatId: string) => {
    // Supersede any in-flight switch/resume so its continuation can't
    // repaint the prior chat over the fresh shell (same discipline as
    // the new-chat handler above).
    switchCtl.invalidate();
    switchCtl.setOptimistic(null);
    const prev = switchCtl.viewedId();
    if (prev && prev !== chatId) {
      chat.saveCurrentScrollPosition();
      flushScrollPosition(prev);
      chat.trackViewedSession(null);
    }
    // Pointer flip + background reconcile (no await — see above).
    void backend.resumeSession?.(chatId).catch(() => { /* SSE covers the rows */ });
    const transcriptEl = document.getElementById('transcript');
    if (transcriptEl) {
      transcriptEl.querySelectorAll('.line.system').forEach((el) => el.remove());
      transcriptEl.classList.remove('transcript-loading');
      chat.clearEdgeLoader();
    }
    sessionDrawer.setViewed(chatId);
    chat.trackViewedSession(chatId);
    // Same pagination-leak fix as new-chat: the minted meeting session
    // has no history — stale hasMore/cursors from the previous chat
    // would arm a bogus top edge loader on the fresh shell.
    chat.setPaginationState(null, false, null, false);
    chat.addSystemLine('Recording started — the live transcript lands in Docs; ask anything here.');
    composerInput.focus();
  };
  initCapturePill({ openChat: openMeetingSession });
  initMeetingsIndex();
  // #243 — warm each pinned message's deep around-window into
  // drillWindowCache in the background so the FIRST click on a pin is a
  // cache hit instead of paying the cold ?around= round trip (the
  // "ages"-long spinner on a slow link). `parley:pins-changed` fires on
  // boot hydrate, pin-add, and cross-device sync, so one listener covers
  // every trigger; prewarmPinnedWindows dedups already-warm windows so the
  // repeat fires are cheap. initPinDrawer's synchronous localStorage
  // hydrate already dispatched the boot event before this listener
  // attached, so kick once directly to cover pins restored from cache.
  window.addEventListener('parley:pins-changed', () => { void prewarmPinnedWindows(); });
  // Cold CAP boot: localStorage is empty, so the boot kick below sees
  // listAllPins()==[] and warms nothing; pins then arrive FROM THE SERVER.
  // On a fresh install the server snapshot lands via either the boot
  // refreshFromServer (fires `parley:pins-changed` only when the diff
  // actually applies) or the cross-device `pins_changed` stream envelope
  // (proxyClient → `parley:server-pins-changed`, which the store turns
  // into a DEBOUNCED refresh). Listening on the raw server event too gives
  // prewarm an independent, earlier trigger that doesn't depend on the
  // store's diff/debounce timing landing a `pins-changed` we don't miss —
  // so pins warm in the background instead of staying cold until the first
  // manual drill (field report: CAP fresh install, all 4 pins loaded only
  // on the first click). Redundant fires are cheap: prewarmedPinKeys skips
  // already-warm windows and prewarmRunning/prewarmDirty single-flights the
  // run, so an extra kick that sees no new pins is a no-op.
  window.addEventListener('parley:server-pins-changed', () => { void prewarmPinnedWindows(); });
  void prewarmPinnedWindows();
  // Same fix for the activity tray: a cron/agent_reply row click drills via
  // the bounded ?around= window centered on the item's (often DEEP)
  // messageId, so the FIRST click pays the cold round trip and the message
  // appears ~20s late (field report, CAP 2026-06-15). Warm each activity
  // item's around-window in the background so the click is a cache hit. The
  // (chatId, messageId) is known at ingest, well before the click.
  // `parley:activity-changed` fires on boot hydrate + every local mutation;
  // `parley:server-activity-changed` is the cross-device reconcile (mirror
  // of the pins pattern). prewarmActivityWindows shares fetchAroundWindowOnce
  // + drillWindowCache with the pin prewarm and the live drill, so redundant
  // fires + pin/activity overlap are deduped and never double-fetch.
  window.addEventListener('parley:activity-changed', () => { void prewarmActivityWindows(); });
  window.addEventListener('parley:server-activity-changed', () => { void prewarmActivityWindows(); });
  void prewarmActivityWindows();
  inAppBanner.init({
    onOpen: (chatId, msgId) => { void drillToChatMessage(chatId, msgId); },
    onAction: (chatId, action, msgId) => { void sendApprovalAction(chatId, action, msgId); },
  });
  // Capacitor shell: target=_blank anchors are dead in WKWebView — hand
  // off-origin links to the native Browser sheet. No-op in the PWA.
  installExternalLinkHandler();
  // Transcript approval cards fire through the registry (the reconciler
  // can't import the shell). A card whose tray record lost its chat id
  // falls back to the chat on screen — the card is rendered inside it.
  approvalActions.setApprovalActionHandler((chatId, action, msgId) => {
    const cid = chatId || switchCtl.focusedId() || null;
    if (!cid) { status.setStatus('No chat to send the approval to', 'err'); return; }
    void sendApprovalAction(cid, action, msgId);
  });
  // Sidebar-top search button → opens the cmd+K palette. Lives next to
  // the hamburger as the rightmost icon in .sidebar-top-row (Gemini-style
  // header). Replaces the old inline magnifier that used to sit beside
  // the filter input.
  const sbSearch = document.getElementById('sb-search');
  if (sbSearch) sbSearch.onclick = (e) => { e.preventDefault(); cmdkPalette.open(); };

  // Range-slider drag-from-track behavior (iOS thumb hit-test fix).
  // Wires every <input type=range> currently in the DOM. Settings panel
  // sliders are static; the call-mode menu's barge slider is also static
  // by build time. Re-call after dynamic DOM additions if any new
  // sliders show up later.
  attachSliderTouchAll(document);
  // Re-wire after agent-declared rows render (model picker, future
  // schema-driven sliders). attachSliderTouchAll is idempotent.
  window.addEventListener('agent-schema-loaded', () => attachSliderTouchAll(document));

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

  // Settings — first load() ran above in boot(); this is a redundant
  // resync left for safety in case anything mutated `current` between
  // boot's load and now (e.g. a backend.connect() that called
  // settings.set()).
  await settings.load();
  bootMark('settings.load #2 done');
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
      if (webrtcControls.isOpen()) void webrtcControls.closeIfOpen('mic-change');
    },
    onStreamingEngineChange: () => {
      // Engine flip — re-evaluate UI affordances. Local engine hides
      // btn-call (realtime+speak mode disappears); server restores it.
      // The actual engine selection happens at dictate.start() time
      // via browserDictate.pickStreamingProvider() — no in-flight state
      // to migrate here, just the UI. The applyMicModeUi function is
      // declared inside setupComposerActions further below; defer the
      // call to the rebroadcast event so wiring order doesn't matter.
      window.dispatchEvent(new CustomEvent('parley:engine-changed'));
    },
    onWakeLockChange: () => {
      // Wake-lock is scoped to active calls — see evaluateWakeLock()
      // for the model. Toggling the setting outside a call is a no-op
      // (stays released); inside a call the toggle takes effect
      // immediately. Pre-fix: the lock was engaged on boot regardless of
      // call state, draining battery outside calls.
      evaluateWakeLock();
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
  // / resume whenever any key is held. The 'setting' key is acquired only
  // during active calls (see evaluateWakeLock); on boot we evaluate once
  // so a call-in-progress reload re-acquires correctly. The 'memo' and
  // 'streaming' keys are owned by capture.ts and acquire/release per
  // capture session independently.
  wakeLock.watchVisibility();
  evaluateWakeLock();

  // Chat
  const transcriptEl = document.getElementById('transcript');
  const chatRestored = await chat.init(transcriptEl);
  bootMark('chat.init done');
  chat.onLoadEarlier(loadEarlierHistory);
  chat.onLoadLater(loadLaterHistory);
  chat.onJumpToLatest(jumpToLatest);
  // Inline gap placeholder (#227): the reconciler renders a tappable `…`
  // row at a spliced-window discontinuity and dispatches parley:load-gap
  // with the numeric fill cursor (afterId). Fetch the page after it and
  // hand it to fillGap, which closes the gap once the runs connect.
  document.addEventListener('parley:load-gap', (ev) => {
    const detail = (ev as CustomEvent).detail || {};
    const afterId = typeof detail.afterId === 'number' ? detail.afterId : null;
    if (afterId == null) return;
    loadGapHistory(afterId).catch(() => {});
  });
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

    // Enter (no modifiers, not already typing): jump into the composer
    // for the session you're on. Completes the keyboard loop — ↑/↓ pick
    // a session (sessionDrawer's document listener, which is live
    // precisely when focus is OUTSIDE a text field), Enter drops into
    // the reply box, Esc comes back out. His framing, 2026-08-27:
    // "pressing enter while in session focus should take to composer in
    // that session."
    //
    // Enter is a heavily-overloaded key, so this yields rather than
    // competes: anything focusable that DOES something with Enter keeps
    // it (buttons, links, summary/details, menu items), and any open
    // overlay keeps it too — a dialog's default action must not be
    // hijacked into "go type a message". We also only claim when the
    // composer actually took focus.
    if (e.key === 'Enter' && !inText
        && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const interactive = t?.closest?.('button, a[href], summary, [role="button"], [role="menuitem"], [role="option"], select');
      // Selectors verified against the real markup — my first pass
      // guessed `.cmdk-overlay` / `.confirm-dialog`, neither of which
      // exists, which would have silently let Enter jump to the composer
      // out from under the search palette and the delete confirmation.
      const overlayOpen = !!document.querySelector(
        '#settings.on, #info-panel:not(.hidden), .hotkeys-help-dialog,'
        + ' dialog[open], .cmdk-dialog, .sk-confirm-overlay',
      );
      if (!interactive && !overlayOpen && focusComposer()) {
        e.preventDefault();
        return;
      }
    }

    // Esc from the composer: step back out to the session list, so ↑/↓
    // resume moving between sessions. The inverse of Enter above; keeps
    // the loop closed without needing a modifier in either direction.
    // Only fires for the composer itself — Esc inside the session
    // filter, a hotkey-capture field or a dialog input belongs to those.
    // Transcript-highlight mode keeps focus ON the composer while ↑/↓
    // walk the bubbles, and its own Esc means "exit highlight" (which
    // re-focuses the composer). Stepping out to the sidebar here would
    // fight that handler — it runs after this one and would pull focus
    // straight back, having flashed the sidebar open on the way. In
    // highlight mode Esc stays theirs; a second Esc then lands here.
    if (e.key === 'Escape' && t?.id === 'composer-input'
        && !document.querySelector('.transcript-highlight')
        && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (sessionDrawer.focusList()) {
        e.preventDefault();
        return;
      }
    }

    // `/`: focus the inline session filter. Skip when an input/textarea
    // is already focused so it doesn't hijack a literal slash typed into
    // the composer or the cmd+K palette. (cmdkPalette.init wires its
    // own cmd+K handler at document level.)
    if (e.key === '/' && !inText && !e.metaKey && !e.ctrlKey && !e.altKey) {
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

    // Alt+T: toggle TTS-replies preference (talk vs stream mode). Routes
    // through flipMicSetting so the menu UI + connection-cycling logic
    // stays the single source of truth (see flipMicSetting in this file).
    if (e.altKey && e.code === 'KeyT') {
      e.preventDefault();
      flipMicSetting('tts');
      return;
    }
  });
  // Per-bubble TTS playback UX (loading bar, played-ratio bar,
  // play/pause/replay button, scrub). Subscribes to tts.ts events
  // and updates DOM by replyId. Delegated click + pointerdown live
  // here too — chat.ts:addLine just emits the DOM, replyPlayer owns
  // all interaction.
  if (transcriptEl) {
    replyPlayer.init({
      transcriptEl,
      // Per-session voice: per-bubble replay/play acts on the viewed
      // session's bubbles, so prefer that session's assigned voice.
      resolveVoice: () =>
        sessionIdentity.voiceFor(switchCtl.viewedId() || '') ?? settings.get().voice,
    });
  }

  // Bridge TTS state → Listen state only for auto-playbacks that Listen
  // explicitly owns. Manual per-bubble replay and unrelated incoming
  // replies must not transition Listen out of an active capture state.
  // Each handler is scoped to the owned replyId — a stale event for a
  // superseded reply (different replyId) is ignored so it can't steal or
  // drop ownership of the reply Listen actually owns.
  const ownsReply = (p: any): boolean => listenReply.ownsReply(p);
  ttsModule.on('play-start', (p: any) => { if (ownsReply(p)) { try { turnbased.notifyReplyPlayback(true);  } catch {} } });
  ttsModule.on('resumed',    (p: any) => { if (ownsReply(p)) { try { turnbased.notifyReplyPlayback(true);  } catch {} } });
  ttsModule.on('paused',     (p: any) => {
    if (ownsReply(p)) {
      try { turnbased.notifyReplyPlayback(false); } catch {}
      listenReply.releaseOwnership();
    }
  });
  ttsModule.on('ended',      (p: any) => {
    if (ownsReply(p)) {
      try { turnbased.notifyReplyPlayback(false); } catch {}
      listenReply.releaseOwnership();
    }
  });
  ttsModule.on('stopped',    (p: any) => {
    if (ownsReply(p)) {
      try { turnbased.notifyReplyPlayback(false); } catch {}
      listenReply.releaseOwnership();
    }
  });

  // Local/turn-based playback as suppression EVIDENCE. Unscoped by
  // replyId on purpose — this is "is the speaker producing agent audio
  // right now", which is true regardless of which surface owns the
  // reply. It is the only playback signal that exists in stream mode:
  // the bridge has no TTS track there, so suppress's arming policy is
  // 'playback-only' and a manual per-bubble play tap during a stream
  // call is the one thing that can legitimately shut the mic gate.
  // Start/end are authoritative here (the client owns the player), so
  // these bound themselves without a heartbeat.
  const playbackEvidence = (active: boolean) => {
    try { webrtcSuppress.onPlaybackState(active, 'local'); } catch { /* noop */ }
  };
  ttsModule.on('play-start', () => playbackEvidence(true));
  ttsModule.on('resumed',    () => playbackEvidence(true));
  ttsModule.on('paused',     () => playbackEvidence(false));
  ttsModule.on('ended',      () => playbackEvidence(false));
  ttsModule.on('stopped',    () => playbackEvidence(false));

  draft.init({
    transcriptEl,
    onChange: updateSendButtonState,
    onScroll: chat.autoScroll,
    onFlush: (text) => {
      // Pre-mint a user_message_id and surface the bubble optimistically
      // via the store. The server's user_message envelope echo dedups
      // by the same id; once it arrives, the pendingSend clears and
      // the bubble's .pending class flips off via projection.
      const userMessageId = `umsg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const chatId = resolveOrMintSendChatId();
      if (chatId) {
        transcriptStore.addPendingSend(chatId, {
          messageId: userMessageId, text, source: 'voice', sentAt: Date.now(),
        });
      }
      // Offline-first: same queued dispatch as the composer path — a
      // draft flushed while the link is down stays `.pending` and POSTs
      // on reconnect (field 2026-07-21). Previously this was a bare
      // sendMessage whose offline rejection went unhandled.
      sendOrQueueMessage(chatId, userMessageId, text, chatId
        ? { voice: true, userMessageId, chatId }
        : { voice: true, userMessageId });
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
  [imageCard, videoCard, audioCard, youtubeCard, spotifyCard, linksCard, markdownCard, loadingCard]
    .forEach(registerCard);

  // Ambient clock + weather — mounted in the right-drawer rail.
  // Renders in compact mode (vertical stack: clock above, temp/icon
  // below) so it fits the 48px rail column. When the user clicks the
  // widget, the drawer expands (drawer.toggle); CSS adapts the
  // widget's layout to the wider content area. Hidden via @media
  // on mobile (rail itself is hidden there).
  const ambientMount = document.getElementById('ambient-mount');
  if (ambientMount) {
    ambient.init({
      mount: ambientMount,
      isExpanded: () => document.body.classList.contains('pin-drawer-open'),
      onClick: () => {
        // Click the rail's pin-toggle to open/close the drawer.
        document.getElementById('btn-pin-drawer-rail')?.click();
      },
    });
  } else {
    ambient.init();  // fallback to legacy floating pill
  }

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
  // Custom tooltip — replaces the native ~1.5s tooltip with a styled,
  // viewport-aware bubble that hides on iOS tap. See util/tooltip.ts.
  initAppTooltip();

  // TEMPORARY: scroll-jump diagnostic (field report 2026-06-16). Inert
  // unless localStorage 'sk-scroll-diag' === '1'. Remove once diagnosed.
  initScrollDiag();

  // Crack A: transcript pipeline. Wires store mutations → projection
  // → reconciler for the active chat. From here on, every SSE
  // envelope / send / resume goes through `transcriptStore.*` and the
  // DOM follows automatically. Has to fire BEFORE the SSE wiring
  // below (or events would land on a no-op subscriber).
  bindTranscriptPipeline({
    transcriptEl: () => document.getElementById('transcript'),
    getFocusedChatId: () => switchCtl.focusedId(),
  });

  // Session-resume rendering — drives the transcript on chat switch /
  // resume / load-earlier. Needs composer-ro callback + a hook to flip
  // the historyLoaded flag in main.ts.
  initSessionResume({
    setComposerReadOnly,
    setHistoryLoaded: () => { historyLoaded = true; },
  });

  // Web Push (Phase 3a) — currently a no-op init seam; subscribe is
  // user-gesture driven from the settings panel (lands in 3b). Wired
  // here so the import is established + 3b can rely on a single
  // boot-time hook.
  initNotifications().catch((e) => log('[notifications] init failed:', e?.message ?? e));
  // Pre-load the per-chat mute set so the sidebar 3-dots menu shows
  // the right label ("Mute notifications" vs "Unmute notifications")
  // on first open. Soft-fails on 503 / network — mutes module returns
  // false from isMuted() until next successful load.
  loadMutes().catch((e) => log('[mutes] load failed:', e?.message ?? e));
  // Visibility reporting — the proxy's push-dispatch gate uses this
  // to distinguish "user is foregrounded + viewing chat X" from "SSE
  // attached but tab is backgrounded." Wire to the sessionDrawer's
  // getFocused accessor so the reported chat_id follows the
  // clicked row immediately, even while its transcript fetch is pending.
  initVisibilityReporting(() => switchCtl.focusedId());

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
  // Tool events including canvas.show flow through the regular SSE
  // stream; the shell subscribes via onToolEvent below.
  bootMark('pre backend.connect');
  // The session-landing block below (deliberate-target resolve → boot
  // resume → most-recent fallback) is a BOOT concern: it decides where a
  // fresh page load lands. onStatus(true) fires on EVERY disconnected→
  // connected transition, and re-running the landing on a reconnect could
  // yank the view — worst case, a freshly-minted (still server-unknown)
  // new chat resumes empty and the most-recent fallback repaints the
  // PREVIOUS session over it (the exact "new chat fell back" class,
  // field 2026-07-21). Reconnect reconciliation of the active chat is
  // the adapter's job (ring replay + epoch-guarded onResume), so the
  // landing runs exactly once.
  let sessionLandingRan = false;
  await backend.connect({
    onStatus: async (connected) => {
      if (connected) {
        bootMark('onStatus connected');
        status.setStatus('Gateway: connected', 'ok');
        // For backends that browse sessions (hermes), resume the adapter's
        // default conversation on boot. If it's empty (fresh install),
        // replaySessionMessages is a no-op and the user gets the blank
        // welcome. For backends without session browsing (openclaw),
        // fall back to the existing history backfill path.
        // First-connect only — see sessionLandingRan above.
        if (backend.capabilities().sessionBrowsing && !sessionLandingRan) {
          sessionLandingRan = true;
          // URL-driven chat selection: `?chat=X` (or `?chat=X&msg=Y`)
          // overrides whatever was last viewed. Used by the iOS push
          // notification click path — service-worker navigates the
          // window to `/?chat=X&msg=Y` and we hydrate that chat + scroll
          // to that message. Previously, the notification content could
          // be unreachable after navigating to a chat from a banner. The companion fix is the hermes
          // plugin persisting notifications to a parley-owned sibling
          // table so the msg is in the transcript by the time we land.
          let urlChatId: string | null = null;
          let urlMsgId: string | null = null;
          try {
            const qs = new URLSearchParams(location.search);
            const c = qs.get('chat');
            if (c) urlChatId = c;
            const m = qs.get('msg');
            if (m) urlMsgId = m;
          } catch { /* malformed URL — fall through to default */ }

          // Prefer the session id persisted alongside the restored chat
          // snapshot — that's the session whose transcript is ACTUALLY on
          // screen after reload. Falls back to the adapter's
          // conversationName ('parley-main' default) for the fresh
          // install path where no snapshot existed.
          const restoredSid = chat.getRestoredViewedSessionId();
          // Landing priority (no deep-link target):
          //   urlChatId  — a ?chat= deep link / notification tap (highest)
          //   restoredSid — the session on screen at last reload, so a
          //                 plain reload keeps your place (continuity wins)
          //   pinnedTop  — the top pinned session as the "home base" on a
          //                truly fresh open (no snapshot to restore)
          //   getCurrentSessionId() — adapter default ('parley-main')
          // The user controls the home-base landing purely by which pin
          // sits at index 0 (drag-reorder); there's no separate default-
          // session state.
          const pinnedTop = sessionPins.topPinned();
          // A DELIBERATE landing target — one the user (or a deep link)
          // actually chose, as opposed to the adapter's bare default. When
          // such a target exists but still ON-DISK we must honor it even if
          // its boot resume comes back EMPTY (cold radio, a chat you just
          // opened that's still empty, a transient server hiccup). #239
          // residual #225: without this the empty-resume fall-through below
          // yanks you to sessions[0] — the most-recently-active (often the
          // busy agent) chat — instead of where you actually were.
          const deliberateSid = urlChatId || restoredSid || pinnedTop || null;
          const sid = deliberateSid || backend.getCurrentSessionId?.();
          let bootRendered = false;
          // ── Authority gate (UX_DETERMINISM_PLAN §5 Phase 1.1) ───────
          // This whole block is a PROGRAMMATIC navigation, and it runs
          // late by construction: sessionDrawer.init and its sessions
          // fetch happen before backend.connect, so on a slow radio the
          // drawer is painted and tappable for seconds before
          // onStatus(connected) gets us here. If the user has already
          // chosen a chat in that window, that choice is the newest
          // intent and boot has nothing left to decide — abandon the
          // restore AND the most-recent fallback rather than race them.
          // switchCtl.begin() would refuse a 'boot'/'fallback' origin
          // anyway (that is the safety net, and it also covers a tap
          // that lands mid-await); this check is the readable intent,
          // and it keeps us from firing the resume fetches at all.
          // Field 2026-09-06: without it, boot's begin() took the newer
          // generation 3s after his tap and repainted a different chat
          // under him.
          const userAlreadyNavigated = switchCtl.hasUserNavigated();
          if (userAlreadyNavigated) {
            diag('boot: user already navigated, restore abandoned');
          }
          // Consume the deep-link params on EVERY path that settles the
          // landing (including the abandoned one) so a later reload
          // doesn't re-drill and the address bar stays clean.
          const clearUrlParams = () => {
            if (!urlChatId && !urlMsgId) return;
            try {
              const cleaned = new URL(location.href);
              cleaned.searchParams.delete('chat');
              cleaned.searchParams.delete('msg');
              history.replaceState({}, '', cleaned.toString());
            } catch { /* noop */ }
          };
          // Hoisted out of the try below so the fallback can ask whether
          // boot's own switch is still the live one.
          let bootTok: switchCtl.SwitchToken | null = null;
          // #204 (field 2026-06-12, CAP): resumeSession NEVER throws —
          // failures come back as `result.error` with an empty
          // transcript, so the try/catch around the boot resume was
          // dead code and an errored fetch (radio not up yet at cold
          // launch) silently left the cached snapshot on screen with
          // nothing retrying. Retry with backoff before giving up.
          const resumeWithRetry = async (sessionId: string): Promise<any> => {
            let result: any = await backend.resumeSession(sessionId);
            for (let attempt = 1; attempt <= 2 && result?.error; attempt++) {
              const delay = 1000 * 2 ** (attempt - 1);
              diag(`boot: resume ${sessionId} failed (${result.error}) — retry ${attempt}/2 in ${delay}ms`);
              await new Promise((r) => setTimeout(r, delay));
              result = await backend.resumeSession(sessionId);
            }
            if (result?.error) diag(`boot: resume ${sessionId} still failing after retries: ${result.error}`);
            return result;
          };
          if (sid && !userAlreadyNavigated) {
            // Seed the drawer highlight immediately — before
            // resumeSession's network fetch resolves — so it doesn't
            // briefly flash the placeholder row. ONLY when we're
            // resuming the same chat the snapshot was for; otherwise
            // we'd trick replaySessionMessages into the merge-existing
            // path (since switchCtl.viewedId() === id), which
            // would skip chat.clear() and leave the prior chat's
            // snapshot DOM merged on top of the URL-target chat's
            // fresh fetch. Without this, tapping a push notification
            // opened the right chat but the notification row wasn't
            // visible until a sidebar click forced a clear-and-repopulate. The fix: leave viewed
            // pointing at the snapshot's chat (or null) so
            // replaySessionMessages sees sameSession=false and runs
            // the clear+repopulate branch for URL-driven switches.
            if (!urlChatId && restoredSid) {
              sessionDrawer.setViewed(restoredSid);
            }
            try {
              // Boot restore is a switch (from nothing) — mint a real
              // switch token so a user click landing DURING the slow
              // boot fetch supersedes it and this paint refuses.
              //
              // A ?chat= landing is 'deep-link': the OS opened the URL,
              // but a human tapped the notification behind it, so it
              // carries user authority. Everything else here (last-viewed
              // snapshot, top pin, adapter default) is 'boot' — the app
              // guessing, and refusable.
              bootTok = switchCtl.begin(sid, urlChatId ? 'deep-link' : 'boot', urlMsgId ?? undefined);
              // Refused: a user navigation slipped in between the
              // synchronous guard above and here. Leave the pane exactly
              // as the user's switch left it — no paint, no resume, no
              // fetch. Falls through to the fallback block, which asks
              // the same question again and also declines.
              if (!bootTok) {
                diag(`boot: restore of ${sid} refused — user navigated first`);
              } else {
                const result: any = await resumeWithRetry(sid);
                const messages = result.messages || [];
                if (messages.length) {
                  // Pass urlMsgId as targetMessageId so the existing
                  // pin-drawer-jump scroll-to machinery kicks in: it
                  // walks the rendered transcript for a matching
                  // data-message-id and scrolls it to the viewport top.
                  // If the target isn't in the initial page,
                  // drillToOlderMessage paginates back until found.
                  replaySessionMessages(
                    bootTok, messages,
                    { firstId: result.firstId ?? null, hasMore: !!result.hasMore },
                    urlMsgId ?? undefined,
                    result.inflight,
                  );
                  bootRendered = true;
                }
                // Release the optimistic claim (mirrors resume()'s finally):
                // the paint committed viewed; leaving optimistic set would
                // just be a stale pointer for the next click to overwrite.
                switchCtl.clearOptimisticIfCurrent(bootTok);
              }
            } catch (e: any) {
              diag(`boot: resume ${sid} failed: ${e.message}`);
            }
          }
          clearUrlParams();
          // Boot-UX: if nothing got rendered above
          // (no snapshot, OR snapshot's session no longer exists, OR
          // adapter's activeChatId points to an unsent stub), pick the
          // most recent existing session and show it. Avoids the
          // "selected stub but body shows another chat" divergence and
          // gives the user a sane landing state on fresh installs that
          // already have history (cross-device, cross-platform).
          if (!bootRendered && !userAlreadyNavigated) {
            try {
              const sessions = await backend.listSessions(50);
              // Re-ask AFTER the await, synchronously with the begin()
              // below: a tap that lands during the list fetch must win.
              // When boot minted a token, "still ours" is just "nothing
              // superseded it"; when it didn't (no sid, or the restore
              // was refused), fall back to the authority flag.
              const stillOurs = bootTok ? switchCtl.isCurrent(bootTok) : !switchCtl.hasUserNavigated();
              if (!stillOurs) {
                diag('boot: most-recent fallback abandoned — user navigated');
              } else if (sessions.length > 0) {
                // #239 residual #225: if the deliberate target (urlChatId /
                // restoredSid / pinnedTop) STILL EXISTS in the session list,
                // land on IT even though its resume came back empty — an
                // empty transcript is a valid state, not a reason to abandon
                // the chat the user was on. Only fall to most-recent when the
                // deliberate target is GONE (deleted) or there was none at
                // all (genuine fresh install with existing history).
                const chosen = deliberateSid
                  ? sessions.find((s: any) => String(s.id) === String(deliberateSid))
                  : undefined;
                const target = chosen || sessions[0];
                diag(chosen
                  ? `boot: empty resume, staying on deliberate target: ${target.id}`
                  : `boot: no rendered session, picking most recent: ${target.id}`);
                // The fallback INHERITS the authority of the landing it
                // is completing. Staying on a deliberate ?chat= target
                // whose resume came back empty is still the user's
                // deep-link intent (#239 residual #225) and must not be
                // refused by the deep-link's own begin() a few lines up;
                // a bare most-recent guess is the app guessing, i.e.
                // 'fallback'. Either way the stillOurs check above has
                // already established that no user navigation is pending.
                const fallbackOrigin: switchCtl.NavOrigin =
                  chosen && urlChatId ? 'deep-link' : 'fallback';
                const fallbackTok = switchCtl.begin(target.id, fallbackOrigin);
                if (!fallbackTok) {
                  diag(`boot: fallback to ${target.id} refused — user navigated first`);
                } else {
                  const result: any = await resumeWithRetry(target.id);
                  replaySessionMessages(
                    fallbackTok,
                    result.messages || [],
                    { firstId: result.firstId ?? null, hasMore: !!result.hasMore },
                    undefined,
                    result.inflight,
                  );
                  switchCtl.clearOptimisticIfCurrent(fallbackTok);
                }
              }
            } catch (e: any) {
              diag(`boot: most-recent fallback failed: ${e.message}`);
            }
          }
        } else if (!backend.capabilities().sessionBrowsing) {
          await backfillHistory();
        }
        bootMark('resume/replay done');
        await memoOutbox.flushOutbox();
        // Offline-first: re-POST sends queued while the link was down.
        // Fire-and-forget — the flush marks its own failures.
        void flushQueuedSends();
        if (settings.refreshModels) settings.refreshModels().catch(() => {});
        // Eager schema fetch so consumers depending on agent settings
        // (currently the composer attach-button vision-gate) have data
        // from page load — without this, agentSettings.getCurrentValue
        // ('model') returns undefined until the user opens the Settings
        // panel, leaving image-upload UI greyed even on vision-capable
        // models. Fires the agent-schema-loaded event the gate listens
        // for. Errors silently — the existing on-panel-open path still
        // re-tries.
        agentSettingsMod.load().catch(() => {});
        // Refresh the slash-command catalog from the agent. Cheap
        // (one ~50-row JSON), fires on every (re)connect so plugin-
        // installed commands and registry updates land without a page
        // reload. No-op silently if the agent doesn't implement
        // /v1/commands.
        slashCommands.refresh().catch(() => {});
      } else {
        status.setStatus('Gateway: disconnected');
      }
    },
    onDelta: handlers.handleReplyDelta,
    onFinal: handlers.handleReplyFinal,
    onToolEvent: handlers.handleToolEvent,
    onActivity: handlers.handleActivity,
    onNotification: handleNotification,
    onUserMessage: handleUserMessage,
    onSessionChanged: () => {
      // Adapter has already updated its local state (IDB title etc).
      // Re-render the drawer so the new title surfaces immediately
      // — without this the user only sees it on next list poll.
      // Coalesced: a turn can fire multiple session_changed envelopes
      // and each individually-rendered drawer is wasted work + flicker.
      sessionDrawer.scheduleRefresh();
    },
    // Crack A: tool envelopes go straight into the store. The
    // projection + reconciler decide where the activity row lands —
    // anchored to the in-flight turn's user_message id. Settings
    // (agentActivity off/summary/full) read by the reconciler at
    // each render.
    onToolCall: (e) => {
      if (!e?.conversation) return;
      transcriptStore.appendInflight(e.conversation, {
        type: 'tool_call', chat_id: e.conversation,
        call_id: e.callId, tool_name: e.toolName,
        args: e.args, started_at: e.startedAt,
      });
    },
    onToolResult: (e) => {
      if (!e?.conversation) return;
      transcriptStore.appendInflight(e.conversation, {
        type: 'tool_result', chat_id: e.conversation,
        call_id: e.callId, tool_name: e.toolName,
        result: e.result, duration_ms: e.durationMs,
      });
    },
    // Adapter-driven reconcile: hermes-gateway fires this when its
    // persistent SSE channel has been down long enough that the
    // server's replay ring may have rolled over. Re-render the active
    // chat from the freshly-fetched transcript via the same path the
    // drawer-click resume uses (clear + replay) — clearing also
    // sidesteps live-vs-history dedupe, since any half-rendered bubble
    // is wiped before the new transcript paints.
    onResume: (e: any) => {
      if (!e?.conversation) return;
      // Epoch guard: this is a BACKGROUND reconcile of a chat whose SSE
      // channel was down. If focus has since moved to another chat (or a
      // switch is in flight), painting e.conversation's transcript would
      // clobber what's now on screen. replaySessionMessages would also
      // commit setViewed(e.conversation), hijacking the view. Only
      // reconcile while the user is still looking at this chat.
      if (switchCtl.focusedId() !== e.conversation) return;
      const messages = Array.isArray(e.messages) ? e.messages : [];
      const pagination = {
        firstId: e.firstId ?? null,
        hasMore: !!e.hasMore,
      };
      // View token, not a switch: this repaints the chat already on
      // screen and must lose to any user navigation that lands between
      // here and the paint (replaySessionMessages re-checks).
      replaySessionMessages(switchCtl.viewTokenFor(e.conversation), messages, pagination, undefined, undefined, { preserveScrollIfLive: true });
    },
    // Adapter-relayed new-session announcement. The legacy hermes adapter
    // surfaces these from the proxy's drawer-events SSE; other adapters
    // leave the callback unfired and the drawer waits for the next list
    // poll to pick up new sessions. The drawer paints a synthetic
    // "pending" row so the just-created chat is visible in the list
    // before listSessions catches up.
    onSessionStarted: (e: any) => sessionDrawer.handleSessionAnnounced(e),
  });
  // Show/hide the sessions section inside the sidebar based on the
  // active backend's capabilities (sidebar itself is always visible).
  sessionDrawer.applyCapabilities();

  // Crack A: no more showThinking() — the projection emits an
  // activity row the moment the first tool_call envelope lands, and
  // a streaming assistant bubble on the first reply_delta. The user
  // sees their pending bubble until the agent acks; the gap is small.
  // Turn boundaries are projection-driven (activity row key derives
  // from the user_message id), so no explicit freeze call either.

  // Any user-initiated send is also a signal that the network is
  // responsive — take that opportunity to retry queued audio blobs
  // stuck in the outbox. Triggered the right fix for the case where
  // /transcribe fails on mobile mid-memo, gateway stays connected, and
  // without this the queue just sits (reconnect-only retries don't
  // fire when the WS never dropped). Mutex in queue.flush keeps this
  // idempotent if two triggers overlap.
  backend.onSend(() => { memoOutbox.flushOutbox().catch(() => {}); });

  // Hide settings rows whose feature isn't supported by the active backend.
  // E.g. openai-compat doesn't expose a model catalog → hide the model row.
  const caps = backend.capabilities();
  if (!caps.models) {
    const rowModel = document.getElementById('row-model');
    if (rowModel) rowModel.style.display = 'none';
  }

  // ── WebRTC controls ───────────────────────────────────────────────────
  // The TTS-reply preference (settings.tts) lives as a toggle in the
  // mic-mode menu — see flipMicSetting('tts') below. The unified
  // composer mic owns the call open/close lifecycle; controls.ts
  // exports toggleCall / openCall / closeIfOpen for the dispatcher
  // to invoke.
  webrtcControls.init({
    getSessionId: () => {
      // #2/#3 diag: when this resolves null on a cold-boot-straight-to-call,
      // the offer ships conv_name=null → bridge mints its own id → reply
      // lands as a notification, not the transcript. Log which component
      // is missing so the device log shows whether viewedId() simply hadn't
      // committed yet. Correlate with [rtc-diag] + [reply-diag].
      const vid = switchCtl.viewedId();
      const cur = backend.getCurrentSessionId?.() || null;
      const resolved = vid || cur || null;
      diag('[rtc-diag] getSessionId resolved=', resolved ?? '∅',
        'viewedId=', vid ?? '∅', 'getCurrentSessionId=', cur ?? '∅',
        'focusedId=', switchCtl.focusedId() ?? '∅');
      return resolved;
    },
    onStatus: (msg, kind) => status.setStatus(msg, kind ?? null),
    // Wake-lock follows call lifecycle — connected/closing/failed/idle
    // transitions all need re-evaluation. evaluateWakeLock is idempotent.
    onCallStateChange: (state) => {
      evaluateWakeLock();
      // A new call attempt supersedes a stale "Call dropped" banner.
      if (state === 'requesting-mic' || state === 'connecting' || state === 'connected') {
        hideCallDroppedBanner();
      }
    },
    // Network dropped a connected call (not a user hangup) — show a
    // distinct banner with one-tap reconnect. See showCallDroppedBanner.
    onCallDropped: (reason) => showCallDroppedBanner(reason),
    // Dictation opens the WebRTC peer from btn-mic; recovery visuals
    // (pulsing-amber reconnecting) belong on the mic then, not btn-call.
    // Same discriminator syncCallButtonVisual uses for .active. Lazy
    // closure: dictateActive is declared later in this scope but state
    // transitions only fire after a user opens a voice path.
    isMicOwnedCall: () => dictateActive,
    // Ending a call must never destroy buffered speech (field bug
    // 2026-08-30). Fires on every terminal state, before the dictation
    // machine is reset; drains anything un-sent into the composer draft
    // of the chat the utterance was spoken into. Lazy closure — same
    // pattern as isMicOwnedCall above, only ever invoked post-boot.
    onRescueBufferedSpeech: (reason) => rescueBufferedSpeech(reason),
  });

  // ── Call-dropped banner ───────────────────────────────────────────────
  // Raised by onCallDropped above when the network tears down a connected
  // call. Reconnect reopens a call on the current chat (toggleCall, since
  // the dropped call is already closed by the time we're here); dismiss
  // just hides it. The banner self-hides whenever a new call starts so a
  // stale "dropped" message can't linger over a live call.
  const callDroppedBanner = document.getElementById('call-dropped-banner');
  function showCallDroppedBanner(reason: string) {
    if (!callDroppedBanner) return;
    log('[call-dropped-banner] show, reason=', reason);
    callDroppedBanner.hidden = false;
  }
  function hideCallDroppedBanner() {
    if (callDroppedBanner) callDroppedBanner.hidden = true;
  }
  document.getElementById('call-dropped-reconnect')?.addEventListener('click', () => {
    hideCallDroppedBanner();
    void webrtcControls.toggleCall();
  });
  document.getElementById('call-dropped-dismiss')?.addEventListener('click', hideCallDroppedBanner);

  // Tell proxyClient to KEEP the SSE channel open while a WebRTC call
  // is active, even when the tab goes hidden. The long-lived SSE
  // connection is what tells iOS "this tab is doing real work, don't
  // suspend its JS" — without it, the WebRTC peer's ICE consent
  // freshness pings stop firing in background and the call drops after
  // ~5 minutes. Field bug 2026-05-24: locked-screen call survived
  // ~6 minutes, then died; relay log showed `visibilitychange hidden
  // → close stream channel` immediately after the lock, followed by
  // `[webrtc] data channel close` six minutes later. The keepalive
  // is bounded to call duration, so battery cost is limited to active
  // calls which are already power-on by nature.
  setProxyStayAliveHint(() => webrtcControls.isOpen() || webrtcControls.isReconnecting());

  // WebRTC data-channel events: parallel text path that surfaces
  // user-speech transcripts and assistant reply deltas as the call
  // proceeds.
  //
  // User finals are NOT immediately rendered as bubbles any more — the
  // bridge sends every is_final, but the PWA owns the dispatch trigger
  // (silence timer + commit-phrase) via webrtcDictation. The user
  // bubble renders once per dispatch (one utterance = one bubble), set
  // up below via setUserBubbleHandler.

  // Streaming user bubble for live dictation. Pending send is added
  // on first interim, text updated as interims/finals arrive, cleared
  // by the server's user_message echo (or the reset handler if the
  // call closes mid-utterance). Pre-minted userMessageId rides
  // through the dispatch envelope so the server's echo dedups against
  // the same key.
  let dcUserMessageId: string | null = null;
  let dcUserBufferedFinals = '';
  // The chat the CURRENT utterance is addressed to, captured when its
  // bubble id is minted. Everything about this utterance (its pending
  // bubble, and — since 2026-08-30 — its rescue into a composer draft)
  // must go here, not to whatever chat happens to be on screen when the
  // network finally gives up. Same "addressed, not pointed" rule as
  // sends (hardening invariant #3); the pre-existing reset handler read
  // currentChatId() and would have orphaned a bubble on a mid-call
  // chat switch.
  let dcUserChatId: string | null = null;
  // The trailing INTERIM (not yet is_final) segment the streaming user
  // bubble is showing. The dictation buffer only ever sees is_finals,
  // so without this the rescue loses the last half-sentence — which is
  // exactly the "dropped mid-sentence" half of the complaint. Cleared
  // when the segment's final lands (the final supersedes it) and on
  // dispatch.
  let dcUserLastInterim = '';
  // (messageId, chatId) of the LAST utterance handed to the bridge.
  // Only read by the dispatch-failed rescue, which runs after the bubble
  // handler has already cleared the live per-utterance state.
  let lastDispatchedBubble: { id: string; chatId: string | null } | null = null;
  // Per-window tally of what the half-duplex gate did to user
  // transcripts. Field 2026-08-27: without this, "the bridge sent
  // transcripts and the client ate them" and "the bridge sent nothing"
  // produce byte-identical client logs. Flushed as ONE line when the
  // pipe reopens.
  //
  // Two windows, two OUTCOMES since 2026-08-28:
  //   window* — the reply window (agent genuinely speaking): DROPPED,
  //             same as ever.
  //   drain*  — the post-barge speaker-drain grace: DELIVERED. The
  //             bridge's own gate now covers the speaker tail
  //             (tts_bridge.HALT_TAIL_GRACE_S), so anything arriving
  //             here is real user speech. The counter stays because it
  //             is the line that caught the bug — a non-zero drain
  //             count used to mean "his words were eaten"; now it means
  //             "his words made it", and a REGRESSION would show up as
  //             the wording flipping back.
  const dcGateDrops = {
    windowInterims: 0, windowFinals: 0, drainInterims: 0, drainFinals: 0,
  };
  function logGateDropsIfAny(where: string): void {
    const { windowInterims, windowFinals, drainInterims, drainFinals } = dcGateDrops;
    if (windowInterims + windowFinals + drainInterims + drainFinals === 0) return;
    log(`[dictation] gate reopened (${where}) — dropped during TTS window: `
      + `${windowInterims} interim/${windowFinals} final; `
      + `delivered during barge drain: ${drainInterims} interim/${drainFinals} final`
      + (windowFinals > 0 ? ' — FINALS WERE DROPPED (real speech may be lost)' : ''));
    dcGateDrops.windowInterims = 0; dcGateDrops.windowFinals = 0;
    dcGateDrops.drainInterims = 0; dcGateDrops.drainFinals = 0;
  }
  function currentChatId(): string | null {
    // View state FIRST (hardening invariant #3: sends are addressed,
    // not pointed). focusedId() flips synchronously at the row click;
    // the adapter's pointer only re-aims when the switch's server
    // fetch starts, so a send committed in the click's own task read
    // the OLD chat from the pointer (same-tick variant of the
    // /approve-into-wrong-session class — pinned by send-during-switch
    // variant 2). The pointer remains as the fallback for surfaces
    // with no view state (fresh boot, stub backend without browsing).
    return switchCtl.focusedId() ?? backend.getCurrentSessionId?.() ?? null;
  }
  /** Resolve the chatId for a fresh send. On a fresh PWA the user's
   *  first action (typed send, voice send, slash command) lands BEFORE
   *  backend.newSession has been called — `currentChatId()` returns
   *  null and the optimistic-bubble path can't route. Pre-mint a chat
   *  via backend.newSession's synchronous prefix (it sets activeChatId
   *  via mintChatId before its first await). Also pin sessionDrawer +
   *  chat to the new id so subsequent envelopes route correctly. */
  function resolveOrMintSendChatId(): string | null {
    const existing = currentChatId();
    if (existing) return existing;
    void backend.newSession?.();
    const fresh = backend.getCurrentSessionId?.() ?? null;
    if (fresh) {
      sessionDrawer.setViewed(fresh);
      chat.trackViewedSession(fresh);
    }
    return fresh;
  }

  function ensureUserBubble(initial: string): void {
    const chatId = currentChatId();
    if (!dcUserMessageId) {
      dcUserMessageId = `umsg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      dcUserChatId = chatId;
      if (chatId) {
        transcriptStore.addPendingSend(chatId, {
          messageId: dcUserMessageId, text: initial, source: 'voice', sentAt: Date.now(),
        });
      }
      return;
    }
    // Heal a swept pendingSend. handleReplyFinal defensively clears ALL
    // pendingSends for the chat on reply_final ("whole turn ack'd") —
    // but an utterance the user is STILL speaking when a reply lands
    // keeps its dcUserMessageId here while its pendingSend is gone, so
    // every subsequent interim updated a nonexistent row and the live
    // caption went invisible for the rest of the utterance (field
    // 2026-08-27: streaming captions never rendered all ride). Re-add
    // under the same id so the echo still dedups.
    if (chatId) {
      const st = transcriptStore.getState(chatId);
      if (!st.pendingSends.find(p => p.messageId === dcUserMessageId)) {
        transcriptStore.addPendingSend(chatId, {
          messageId: dcUserMessageId, text: initial, source: 'voice', sentAt: Date.now(),
        });
      }
    }
  }
  function setUserBubbleText(text: string): void {
    if (!dcUserMessageId) return;
    const chatId = currentChatId();
    if (chatId) transcriptStore.updatePendingSend(chatId, dcUserMessageId, text);
  }
  function getOrMintUserMessageId(): string {
    if (!dcUserMessageId) {
      dcUserMessageId = `umsg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      dcUserChatId = currentChatId();
    }
    return dcUserMessageId;
  }
  /** Tear down the streaming ("phantom") user bubble for the in-flight
   *  utterance and forget the per-utterance state. Addressed to
   *  dcUserChatId, so a mid-call chat switch can't leave the bubble
   *  stranded in a chat we no longer point at. */
  function clearStreamingUserBubble(): void {
    if (dcUserMessageId) {
      const chatId = dcUserChatId ?? currentChatId();
      if (chatId) transcriptStore.clearPendingSend(chatId, dcUserMessageId);
    }
    dcUserMessageId = null;
    dcUserChatId = null;
    dcUserBufferedFinals = '';
    dcUserLastInterim = '';
  }
  /** Everything the user has SPOKEN but the client has not SENT:
   *  the dictation machine's finalised segments plus the trailing
   *  interim. Draining is what keeps the rescue idempotent and
   *  double-send-proof — dispatchNow() empties the dictation buffer
   *  before it writes to the bridge, and the bubble handler below
   *  clears the interim on the same edge, so an utterance that went out
   *  normally leaves nothing here to rescue. */
  function drainUnsentSpeech(): string {
    const buffered = webrtcDictation.takeBufferedText();
    const interim = dcUserLastInterim.trim();
    dcUserLastInterim = '';
    if (!interim) return buffered;
    if (!buffered) return interim;
    // Interims are per-SEGMENT partials; earlier segments are already in
    // the buffer as finals, so this is an append. The endsWith guard is
    // defensive against an engine that re-sends a segment it already
    // finalised (would otherwise duplicate the tail).
    if (buffered.endsWith(interim)) return buffered;
    return `${buffered} ${interim}`;
  }
  /** Park rescued speech in the composer of the chat it was spoken
   *  into, durably (IDB-backed drafts), and tell the user it happened.
   *  Never sends: a rescue is text the user did NOT commit, so it lands
   *  for review — same rule the cross-chat listen-turn recovery
   *  already follows. */
  function rescueSpokenText(text: string, reason: string, addressedTo: string | null): void {
    const trimmed = (text || '').trim();
    if (!trimmed) return;
    const chatId = addressedTo ?? currentChatId();
    log(`[voice-rescue] reason=${reason} chars=${trimmed.length} chat=${chatId ?? '∅'}`);
    if (!chatId) {
      // No chat to address (shouldn't happen — a call always has one) —
      // still better to show the text than to eat it.
      const ta = document.getElementById('composer-input') as HTMLTextAreaElement | null;
      if (ta) {
        ta.value = ta.value.trim() ? `${ta.value.replace(/\s+$/, '')}\n\n${trimmed}` : trimmed;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
      // No toast when the text lands in the composer he is looking at:
      // the text appearing IS the notification, and the banner sat over
      // the composer it was pointing at (his note, 2026-08-31: "it
      // actually overshadowed the composer, and it's just annoying...
      // users will figure it out pretty quick").
      return;
    }
    const visible = composerDrafts.appendDraft(chatId, trimmed);
    // A toast survives ONLY for the invisible case: the rescue landed in
    // a DIFFERENT chat's draft, so there is nothing on screen to notice.
    // Silence there would be the old bug wearing a smile.
    if (!visible) {
      const lead = reason === 'dispatch-failed' ? "Couldn't send" : 'Call ended';
      toast(`${lead} — saved what you said as a draft in that chat`);
    }
  }
  /** Terminal-call rescue. Wired to webrtcControls.onRescueBufferedSpeech
   *  and run before dictation.reset() on every path that ends a call.
   *  Jonathan field bug 2026-08-30: reconnect gave up in the car and
   *  several minutes of dictation were deleted with no trace. */
  function rescueBufferedSpeech(reason: string): void {
    const text = drainUnsentSpeech();
    const addressedTo = dcUserChatId ?? currentChatId();
    // Always clear the phantom bubble, even with nothing to rescue — a
    // rescued utterance must not ALSO leave a dangling streaming bubble
    // in the transcript.
    clearStreamingUserBubble();
    if (!text) return;
    rescueSpokenText(text, reason, addressedTo);
  }
  webrtcDictation.setOnResetHandler(() => {
    // Call closed mid-utterance — drop the in-flight pending send if
    // it never made it through dispatch. The TEXT is not lost here:
    // controls.ts drains it into the composer (rescueBufferedSpeech)
    // immediately before invoking reset().
    clearStreamingUserBubble();
    dcGateDrops.windowInterims = 0; dcGateDrops.windowFinals = 0;
    dcGateDrops.drainInterims = 0; dcGateDrops.drainFinals = 0;
  });
  // A dispatch the bridge refused (dead channel) used to vanish: the
  // buffer was already empty and a pending bubble was already on
  // screen. Clean the bubble up and route the text to the composer.
  webrtcDictation.setDispatchFailedHandler((text) => {
    const chatId = lastDispatchedBubble?.chatId ?? null;
    if (chatId && lastDispatchedBubble?.id) {
      transcriptStore.clearPendingSend(chatId, lastDispatchedBubble.id);
    }
    lastDispatchedBubble = null;
    clearStreamingUserBubble();
    rescueSpokenText(text, 'dispatch-failed', chatId);
  });
  webrtcDictation.setUserBubbleHandler((text) => {
    // Dispatch fired — pendingSend gets the final text; the server's
    // user_message echo will clear it shortly. If we never rendered
    // an interim (e.g. silence-commit on empty utterance), mint a
    // pendingSend here so the bubble exists at all.
    const id = getOrMintUserMessageId();
    const chatId = currentChatId();
    if (chatId) {
      const state = transcriptStore.getState(chatId);
      if (state.pendingSends.find(p => p.messageId === id)) {
        transcriptStore.updatePendingSend(chatId, id, text);
      } else {
        transcriptStore.addPendingSend(chatId, {
          messageId: id, text, source: 'voice', sentAt: Date.now(),
        });
      }
    }
    // Remember what this dispatch claimed so the dispatch-FAILED hook
    // (fired microseconds later, after dcUserMessageId is nulled) can
    // still take the phantom bubble back down.
    lastDispatchedBubble = { id, chatId };
    dcUserMessageId = null;
    dcUserChatId = null;
    dcUserBufferedFinals = '';
    // The utterance left the client: its interim is spoken-for. Not
    // clearing this is how the same half-sentence would be both sent
    // AND rescued into the composer on the next call teardown.
    dcUserLastInterim = '';
  });
  webrtcDictation.setUserMessageIdProvider(getOrMintUserMessageId);
  webrtcConnection.setDataChannelListener((ev) => {
    if (ev.type === 'listening') {
      // Bridge announced "STT pipe is hot" — fires at call-start AND
      // after every TTS-end transition (i.e. it's the user's turn
      // again in a multi-turn call). Plays the soft two-tone "your
      // turn" cue. Single source of truth: don't fire this anywhere
      // else on the client.
      log('[bubble-diag] listening envelope received from bridge');
      // The call is only USABLE at the first `listening` — that is the
      // moment he is waiting for, not connectionstate=connected. One
      // breakdown line per open; no-op on later rounds' listening.
      webrtcConnection.logOpenTiming('first-listening');
      try { playFeedback('listening'); } catch { /* ignore */ }
      // Authoritative "TTS audio done" signal — flips the realtime
      // BargeWindow's playback gate off. Without this the gate was
      // tied to suppress.isSuppressing() (a SHORT transcript-grace
      // window) and the detector stopped running while TTS was still
      // playing through the speaker — barge couldn't fire past the
      // first 1.2s of any reply (v0.381 field-test regression).
      webrtcSuppress.onListening();
      // Flush the gate-drop tally now if the gate actually opened (a
      // listening landing inside the barge-drain grace leaves it shut;
      // the tally then flushes on the first post-drain user event).
      if (!webrtcSuppress.isTtsPlaying()) logGateDropsIfAny('listening');
      // Field-bug 2026-08-26 diagnostics: snapshot pc/ICE/DC/sender-track
      // state and sample outbound RTP bytesSent over the next 5s, so a
      // "bridge says listening but my speech goes nowhere" report is
      // answerable from the client log alone (2 bounded lines per turn).
      try { webrtcConnection.logListeningTransport(); } catch { /* diag only */ }
      // Visual pulse — adds the .listening class to the mic button so
      // the user can distinguish "we got your touch" (red filled, no
      // pulse) from "actually listening" (red filled + pulse). The
      // class clears with .active on stopVoice.
      const btn = document.getElementById('btn-mic');
      if (btn) btn.classList.add('listening');
      return;
    }
    if (ev.type !== 'transcript' || typeof ev.text !== 'string') return;
    if (ev.role === 'assistant') {
      // Talk-mode suppression arming rides the DATA CHANNEL, not the SSE
      // reply stream (field bug 2026-08-26). The bridge forwards every
      // assistant delta it TTSes over this ordered channel, and its
      // `listening` envelope is guaranteed to arrive AFTER the last
      // delta of the last TTS round — so a ttsPlaying armed here always
      // has its clear coming. SSE deltas, by contrast, can land after
      // `listening` (stall-flush on wake, ring replay on reconnect) and
      // used to re-arm ttsPlaying forever, silently dropping every
      // subsequent user transcript below. Rendering still ignores these
      // envelopes — the SSE handleReplyDelta/Final path stays the single
      // render origin.
      if (ev.is_final) webrtcSuppress.onAssistantFinal({ viaDataChannel: true });
      else webrtcSuppress.onAssistantDelta({ viaDataChannel: true });
      return;
    }
    if (ev.role === 'user') {
      // Half-duplex: while the agent is speaking, the speaker-to-mic
      // path re-captures TTS output as STT input. Drop user transcripts
      // for the entire TTS audio playback window — `isTtsPlaying()`
      // is the authoritative "TTS audio not yet done" signal (set on
      // assistant_delta, cleared on bridge `listening` envelope).
      // `isSuppressing()` was the old gate but only covered the
      // text-final + 1.2s grace window — TTS audio plays for many
      // more seconds, so the post-grace window leaked TTS bleed-through
      // back as fake user transcripts (the "1 2 3 4 5 6 7 8 9 zero"
      // feedback loop on slow-terminating TTS). Use ttsPlaying
      // for full playback coverage; client-side BargeWindow handles
      // the legitimate barge case independently.
      //
      // Diagnostics (field 2026-08-27): these drops were INVISIBLE — a
      // reply window that eats a final of real pre-reply speech and a
      // wedged round that receives nothing look identical in the log.
      // Count what the gate drops, attributed to the reply window vs
      // the post-barge drain, and emit ONE line when the pipe reopens.
      //
      // 2026-08-28: the post-barge DRAIN no longer drops anything. Echo
      // suppression moved to where the audio is — the bridge now holds
      // its own mic→Deepgram gate shut for the post-halt speaker tail
      // (tts_bridge.HALT_TAIL_GRACE_S), so the drained TTS never reaches
      // STT and cannot become a transcript in the first place. Any user
      // transcript that arrives after a barge is therefore genuine
      // speech BY CONSTRUCTION, and dropping it only loses the user's
      // words: field 2026-08-27 23:04:25 ate his first post-barge
      // interim AND final ("during barge drain: 1 interim/1 final")
      // while the bridge journal showed it had delivered them
      // (`first post-TTS transcript (round=2 final=False len=11)`).
      // The REPLY-window gate below is untouched — while the agent is
      // actually speaking the bridge's gate and this one agree, and
      // this one still catches anything that slips the seam.
      if (webrtcSuppress.isTtsPlaying()) {
        if (!webrtcSuppress.isBargeDrainActive()) {
          if (ev.is_final) dcGateDrops.windowFinals++; else dcGateDrops.windowInterims++;
          return;
        }
        // Post-barge drain: count what we let through (so the tally
        // line still says what happened in the window that used to eat
        // it) and fall through to normal handling.
        if (ev.is_final) dcGateDrops.drainFinals++; else dcGateDrops.drainInterims++;
      } else {
        logGateDropsIfAny('gate-open');
      }
      // Deepgram's UtteranceEnd arrives as an EMPTY final (the bridge
      // forwards empty finals since 9eb5a88 for dictate.ts's caret
      // re-anchor; the dictate listener is a different consumer). In
      // talk mode it carries nothing: pre-fix the final branch below
      // minted a pendingSend for it via ensureUserBubble(''), leaving
      // an EMPTY user bubble after every dispatch — which in turn
      // baited the projection's thinking placeholder into rendering an
      // empty CLAWDIAN bubble under it (the two ghost bubbles of the
      // 2026-08-27 field screenshot). It has no dictation effect either
      // (handleUserFinal no-ops on empty). Ignore it entirely.
      if (typeof ev.text !== 'string' || !ev.text.trim()) return;
      if (!ev.is_final) {
        // Interim: upsert the streaming user bubble. Display = previously
        // is_finalized segments for this utterance + current interim.
        const display = (dcUserBufferedFinals + ' ' + ev.text).trim();
        if (!display) return;
        // Keep the raw partial so a call that dies before this segment
        // is finalised can still rescue the half-sentence (2026-08-30).
        dcUserLastInterim = ev.text;
        ensureUserBubble(display);
        setUserBubbleText(display);
        return;
      }
      // Final segment: append to our buffered-finals copy, update the
      // bubble to reflect the locked-in text, then feed the dictation
      // state machine so it can buffer for dispatch (silence/commit).
      dcUserBufferedFinals = (dcUserBufferedFinals + ' ' + ev.text).trim();
      // The final SUPERSEDES the segment's interim (and is what goes
      // into the dictation buffer), so the rescue must not also carry
      // the partial or the tail would be duplicated.
      dcUserLastInterim = '';
      ensureUserBubble(dcUserBufferedFinals);
      setUserBubbleText(dcUserBufferedFinals);
      webrtcDictation.handleUserFinal(ev.text);
      return;
    }
    // Assistant transcript RENDERING happens on the SSE handleReplyDelta /
    // handleReplyFinal path (single render origin); the bridge's
    // ev.role === 'assistant' duplicates only drive suppression arming
    // (handled above) and are otherwise ignored.
  });

  // Populate the mic picker once on boot. It needs prior getUserMedia
  // permission for labels to surface — until permission is granted, the
  // dropdown shows generic "Mic <id>" entries. Subsequent WebRTC calls
  // will get full labels on the next render.
  populateMicPicker().catch(() => {});

  // releaseCaptureIfActive (release-all coordinator) is now provided by the
  // voice controller, created below once composerSend + the mode start/stop
  // fns exist; it's assigned to the module-level handle there.

  // ── Composer ────────────────────────────────────────────────────────────
  const composerInput = document.getElementById('composer-input') as HTMLTextAreaElement;
  const composerSend = document.getElementById('composer-send') as HTMLButtonElement;

  // Per-chat drafts: keystrokes save to the chat the text is BOUND to;
  // the view-commit seam (sessionDrawer.applyViewChangedEffects) swaps
  // drafts on switch. onRestored re-runs the chrome a real keystroke
  // would have (autoResize/updateSendButtonState are hoisted function
  // declarations — defined below, callable from this callback).
  // (init call is below the clear/restore wiring, so those buttons are
  // already looked up when the first onComposerState fires.)

  // ── Composer clear (✕) + restore (↩) ────────────────────────────────
  // Jonathan, 2026-08-30: "a very subtle x" that shows only when the
  // composer has content and clears it, plus a restore icon that shows
  // only while the cleared text can be put back. This is the discard
  // gesture for dictation the call-end rescue parks here — the reason
  // it is safe next to the call button is that the undo is real
  // (per-chat, persisted next to the draft, no expiry — see the
  // lifetime note in composerDrafts.ts), not a countdown toast.
  const composerClearBtn = document.getElementById('composer-clear') as HTMLButtonElement | null;
  const composerRestoreBtn = document.getElementById('composer-restore') as HTMLButtonElement | null;
  composerClearBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    if (composerDrafts.clearWithUndo()) log('[composer] cleared (undoable)');
  });
  composerRestoreBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    if (composerDrafts.restoreCleared()) log('[composer] restored cleared text');
  });

  composerDrafts.init({
    textarea: composerInput,
    onRestored: () => { autoResize(); updateSendButtonState(); },
    onComposerState: () => syncComposerEditButtons(),
  });
  void composerDrafts.hydrateDrafts();
  syncComposerEditButtons();

  // Agent-question pop-up (unified elicitation): approval answers ride
  // the normal ADDRESSED send path — same invariant-#3 plumbing as any
  // composer send, into the question's own chat.
  questionPopup.init({
    sendCommand: (text: string, chatId: string) => {
      const userMessageId = `umsg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      try { backend.sendMessage(text, { userMessageId, chatId }); }
      catch (e: any) { diag(`question-popup send failed: ${e?.message || e}`); }
    },
  });

  // Keyboard-driven transcript highlight mode (Slack-style):
  //   Empty composer + ↑ → highlight most recent bubble; ↑/↓
  //   navigates; ↓ past most recent returns to composer; p pins;
  //   c copies; Esc exits. See transcriptHighlight.ts header.
  initTranscriptHighlight({
    composer: composerInput,
    transcript: document.getElementById('transcript'),
  });

  /** Shared mount-site for the recorder bar (memo + turn-based both
   *  hide the composer-actions row and drop a recorder bar into the
   *  same physical spot). Returns the args every recorderBar.mount
   *  caller needs, plus a `restore()` that the caller invokes from
   *  every teardown path so the actions row reappears.
   *
   *  Returns null if the composer DOM isn't present (defensive — the
   *  caller can fall back to no-bar mode). */
  function enterComposerBarMount(): {
    container: HTMLElement;
    insertBefore: HTMLElement | null;
    hide: () => void;
    restore: () => void;
  } | null {
    const composerEl = composerInput?.parentElement as HTMLElement | null;
    if (!composerEl) return null;
    const actionsEl = composerEl.querySelector('.composer-actions') as HTMLElement | null;
    // 2026-05-05: actions row no longer hidden synchronously here.
    // Caller invokes hide() AFTER the audio path has actually opened
    // (turnbased.start / memo.start succeeded). Reason: cold-start
    // capture.acquire awaits the iOS audio-session prime which can take
    // ~2s on first call. Hiding actions before the recorder bar mounts
    // left an empty composer for the duration — app looked stuck. Now
    // the actions row stays visible during the wait; the recorder bar
    // takes over once it mounts (briefly both are visible, acceptable).
    return {
      container: composerEl,
      insertBefore: actionsEl || composerSend,
      hide: () => { if (actionsEl) actionsEl.style.display = 'none'; },
      restore: () => { if (actionsEl) actionsEl.style.display = ''; },
    };
  }

  /** Auto-grow the composer textarea with content, capped at the CSS
   *  max-height (currently 40vh desktop / 30vh mobile — see app.css).
   *  Past the cap the textarea scrolls internally.
   *
   *  We read max-height from getComputedStyle each call so the JS cap
   *  stays in sync with CSS (no duplication of the 40vh/30vh constants).
   *  If max-height is `none` or unparseable we fall back to 40% of
   *  innerHeight, matching the desktop default.
   *
   *  Resize side-effect: growing the textarea shrinks transcript
   *  clientHeight. If the user was pinned to the live edge before the
   *  resize, re-pin afterwards so streaming content doesn't slide out of
   *  view as they type. */
  function autoResize() {
    const cs = window.getComputedStyle(composerInput);
    const parsed = parseFloat(cs.maxHeight);
    const cap = Number.isFinite(parsed) && parsed > 0
      ? parsed
      : Math.round(window.innerHeight * 0.4);
    const transcriptEl = document.getElementById('transcript');
    const wasPinned = transcriptEl
      ? (transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight) <= 80
      : false;
    composerInput.style.height = 'auto';
    composerInput.style.height = Math.min(composerInput.scrollHeight, cap) + 'px';
    // Update --composer-height so the scroll-to-bottom button (which
    // anchors `bottom: calc(var(--composer-height) + 64px)`) tracks
    // the composer as it grows. Without this the button stays at the
    // 64px default and ends up overlapping the wrapped textarea text.
    const composerEl = composerInput.closest('.composer') as HTMLElement | null;
    if (composerEl) {
      const h = Math.round(composerEl.getBoundingClientRect().height);
      document.documentElement.style.setProperty('--composer-height', `${h}px`);
    }
    if (wasPinned && transcriptEl) {
      // scrollTo with behavior:'instant' — CSS scroll-behavior:smooth
      // on .transcript would otherwise animate this snap over ~300ms.
      // During the animation, virt fires a rerender per intermediate
      // scroll event, spacer heights adjust slightly each time, and
      // the user sees the transcript "twitch" as they hit a newline
      // mid-dictation. Instant scroll keeps the composer-resize fully
      // decoupled from the transcript's visual position.
      transcriptEl.scrollTo({ top: transcriptEl.scrollHeight, behavior: 'instant' as ScrollBehavior });
    }
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

  // Copy button on rendered code blocks (miniMarkdown emits .code-copy-btn).
  // Delegated at document level so it works for every transcript/card/pin
  // block without per-render wiring. Reads the sibling <code> textContent
  // (unescaped source) and flashes a brief "copied" state.
  document.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement)?.closest?.('.code-copy-btn') as HTMLElement | null;
    if (!btn) return;
    const code = btn.closest('.code-block')?.querySelector('code');
    const text = code?.textContent ?? '';
    if (!text || !navigator.clipboard?.writeText) return;
    navigator.clipboard.writeText(text).then(() => {
      btn.classList.add('copied');
      setTimeout(() => btn.classList.remove('copied'), 1200);
    }).catch(() => {});
  });

  function sendTypedMessage() {
    const text = composerInput.value.trim();
    const hasAttachments = attachments.hasPending();

    if (text || hasAttachments) {
      // First-run model gate (setupWizard.ts): on a fresh trial install
      // (stub backend still on its echo LLM) a send is HELD, not errored
      // — the wizard opens and the text stays in the composer.
      if (setupWizard.gateIfNeeded()) return;
      // NO connectivity gate here (field 2026-07-21): isConnected()
      // mirrors the SSE EventSource, which flaps on spotty links while
      // a POST would succeed. The send proceeds optimistically; a
      // connectivity failure queues it for reconnect (sendOrQueueMessage)
      // with the bubble staying `.pending`. The normal send path below
      // still runs releaseCaptureIfActive(), so the mic never stays hot.
      // Typed session-boundary commands. These are hidden from the slash
      // catalog (server-side), and gateway vocabulary collides with
      // Parley's: gateway /new is an IN-PLACE session reset (same thread,
      // fresh agent), not a new thread. So we map on the Parley side:
      //   /new   → New Chat button codepath (mint a fresh thread — matches
      //            the word + the button the user already knows).
      //   /clear → no gateway behavior (cli_only terminal screen wipe);
      //            new threads already start vanilla, so just nudge to
      //            New Chat instead of round-tripping an "Unknown command".
      //   /reset → NOT intercepted here. It's surfaced as a synthetic
      //            slash-catalog entry (see slashCommands.ts), so it routes
      //            through slashCommands.dispatch → upstream as a command,
      //            which resets the session in place (history stays
      //            scrollable, agent re-reads SOUL). The gateway gates it
      //            behind a destructive-confirm prompt.
      if (text[0] === '/') {
        const head = text.slice(1).split(/\s+/, 1)[0]?.toLowerCase();
        if (head === 'new') {
          composerInput.value = '';
          composerInput.dispatchEvent(new Event('input'));
          document.getElementById('sb-new-chat')?.click();
          return;
        }
        if (head === 'clear') {
          chat.addSystemLine(
            `Use the New Chat button (${formatHotkey('Cmd+Shift+O')}) to start a fresh chat.`,
          );
          composerInput.value = '';
          composerInput.dispatchEvent(new Event('input'));
          return;
        }
      }
      // Slash commands: route through slashCommands so the popover's
      // dispatch path AND the manually-typed-then-Enter path share one
      // codepath. slashCommands.dispatch calls onDispatch — which here is
      // the bare-bones backend.sendMessage (no optimistic bubble; the
      // agent's reply IS the response).
      if (slashCommands.isCommand(text)) {
        slashCommands.dispatch(text);
        return;
      }
      // Atomic-bubble path (Q1): bubble starts `.pending`. On agent's
      // first reply_delta / typing the bubble flips to a normal user
      // line. On send-failure it flips to `.failed` with a Retry button
      // that restores the composer text and re-fires sendTypedMessage.
      //
      // Cross-device dedup: pre-mint a userMessageId. It ships with
      // the POST body → upstream's user_message broadcast echoes it →
      // projection dedups on the originator, renders fresh on other
      // devices.
      const userMessageId = `umsg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const sendChatId = resolveOrMintSendChatId();
      if (sendChatId) {
        transcriptStore.addPendingSend(sendChatId, {
          messageId: userMessageId,
          text: text || '',
          source: 'text',
          sentAt: Date.now(),
          attachments: hasAttachments ? attachments.toChatEcho() : undefined,
        });
      }
      // Optimistic sidebar entry — show this chat in the drawer with
      // the user's text as the snippet IMMEDIATELY, before the agent
      // replies. Without this, the user fires off a message and the
      // drawer shows "New chat" with 0 msgs until the server-side turn
      // completes (which can be 30s+ on long tool-using turns). With
      // it, multiple back-to-back new chats stack as the user expects.
      // handleSessionAnnounced is idempotent: if the chat already has
      // a cached row OR a pending row, it no-ops. The server-side
      // session_changed envelope replaces the pending entry with the
      // canonical title later.
      if (sendChatId && text) {
        const snippet = text.slice(0, 80);
        sessionDrawer.handleSessionAnnounced({
          id: sendChatId,
          snippet,
          source: 'parley',
          started_at: new Date().toISOString(),
        });
      }
      // Explicit address (invariant #3): the same chatId the optimistic
      // bubble was filed under is what the POST carries — the adapter's
      // mutable pointer is out of the loop for composer sends.
      const sendOpts: Record<string, any> = { userMessageId };
      if (sendChatId) sendOpts.chatId = sendChatId;
      // sendMessage failures come back through the promise;
      // sendOrQueueMessage classifies them: connectivity-class (fetch
      // network error — the gateway never answered) keeps the bubble
      // `.pending` and queues the POST for the next reconnect; an
      // answered HTTP rejection flips the bubble to `.failed` with
      // Retry, which restores `text` to the composer.
      if (hasAttachments) {
        // Large attachments (task #158) stream to the upload endpoint
        // before send, so building the payload is async. toSendPayload
        // snapshots the pending list synchronously, so the clear() below
        // can't race the in-flight uploads. An UPLOAD failure still flips
        // the bubble straight to failed — the upload can't be replayed
        // after attachments.clear() revokes the blob previews; Retry
        // restores text + re-attaches inline (data:) attachments, and
        // toasts a re-attach notice for large (blob:) ones. Once the
        // payload is built, the POST itself is offline-queued like a
        // plain send.
        attachments.toSendPayload()
          .then((att) => {
            sendOpts.attachments = att;
            sendOrQueueMessage(sendChatId, userMessageId, text, sendOpts);
          })
          .catch((e) => failSendBubble(sendChatId, userMessageId, (e as Error)?.message || String(e)));
      } else {
        sendOrQueueMessage(sendChatId, userMessageId, text, sendOpts);
      }
      // Tear down any in-progress capture (dictation, memo, call) BEFORE
      // we clear the textarea. Otherwise an in-flight STT final lands
      // into the cleared composer and pastes the user's just-sent
      // utterance back in. dictate.stop() marks the in-flight interim as
      // abandoned synchronously so the late-event filter catches anything
      // arriving during the provider-stop await.
      releaseCaptureIfActive();
      attachments.clear();
      playFeedback('send');
      composerInput.value = '';
      // The ADDRESSED chat's draft is spent (send committed — a failure
      // comes back through Retry, which restores the text).
      composerDrafts.clearDraft(sendChatId);
      // A typed message in this chat also answers any pending clarify
      // via the gateway's text-intercept — drop the pop-up so it
      // doesn't outlive the question it was asking.
      if (sendChatId) questionPopup.noteUserSentText(sendChatId);
      autoResize();
      updateSendButtonState();
    } else if (draft.hasContent()) {
      // NO connectivity gate (field 2026-07-21): flush unconditionally —
      // the draft's onFlush path dispatches via sendOrQueueMessage, so a
      // flush while the link is down renders a `.pending` bubble and
      // POSTs on reconnect instead of swallowing the tap.
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
  // Select-to-quote: selecting transcript text floats a "Quote" button that
  // inserts the selection as a markdown blockquote into the composer for
  // reply (accumulating multiple quote+reply pairs into one message).
  const docQuoteRoot = document.getElementById('doc-drawer-body');
  selectToQuote.init({
    transcriptEl: document.getElementById('transcript'),
    extraEls: [document.getElementById('pin-drawer-list'), docQuoteRoot],
    onQuote: (text, root) => {
      // Doc-panel selections get an attribution line inside the quote so
      // the agent knows the passage came from a document, not the
      // transcript — this is the agent-mediated-edit bridge (quote →
      // spoken instruction → agent edits the file → re-push). Known
      // limit: selections inside the sandboxed HTML iframe are invisible
      // to the parent, so this covers markdown/text docs only.
      if (root && docQuoteRoot && root === docQuoteRoot) {
        const doc = docStore.currentDoc();
        if (doc) text = `${text}\n— from "${doc.title}"${doc.path ? ` (${doc.path})` : ''}`;
      }
      composer.appendQuote(text);
    },
  });
  // Retry-send wire-up (Crack A): reconciler renders a Retry button
  // on a `.failed` user bubble and dispatches `parley:retry-send`
  // on click. Restore the composer with the original text + drop
  // the failed pendingSend so the user can re-send. Mirrors the old
  // chat.markBubbleFailed onRetry callback the reconciler replaces.
  //
  // Field bug #224 (2026-06-12): Retry restored the TEXT but silently
  // dropped the attachment — the user re-sent a photo-less message
  // without noticing. Inline (data:) echo attachments survive in the
  // pendingSend, so rebuild Files from them and re-queue. Large
  // (blob:) previews were revoked by attachments.clear() at send time
  // and can't be restored — tell the user to re-attach those.
  document.addEventListener('parley:retry-send', async (ev) => {
    const detail = (ev as CustomEvent).detail || {};
    const text = typeof detail.text === 'string' ? detail.text : '';
    const messageId = typeof detail.messageId === 'string' ? detail.messageId : '';
    const chatId = switchCtl.viewedId();
    const pendingAtts = (chatId && messageId)
      ? (transcriptStore.getPendingSend(chatId, messageId)?.attachments ?? [])
      : [];
    if (chatId && messageId) {
      transcriptStore.clearPendingSend(chatId, messageId);
    }
    if (text) {
      composerInput.value = text;
      composerInput.dispatchEvent(new Event('input'));  // triggers autoResize + updateSendButtonState
      composerInput.focus();
    }
    let lost = 0;
    for (const a of pendingAtts) {
      if (typeof a?.dataUrl === 'string' && a.dataUrl.startsWith('data:')) {
        try {
          const blob = await (await fetch(a.dataUrl)).blob();
          await attachments.add(new File([blob], a.fileName || 'attachment', {
            type: a.mimeType || blob.type,
          }));
        } catch { lost += 1; }
      } else {
        lost += 1;
      }
    }
    if (lost > 0) {
      toast(`${lost > 1 ? `${lost} attachments` : 'Attachment'} couldn't be restored — please re-attach`, 'err');
    }
  });
  // Slash-command popover. Backend-declared registry, frontend-rendered
  // — see src/slashCommands.ts. slashCommands owns the dispatch +
  // popover; main.ts supplies onDispatch.
  //
  // onDispatch renders an OPTIMISTIC user bubble before POSTing, same
  // as sendTypedMessage's regular-text path. Field bug 2026-05-17:
  // without the optimistic bubble, slash-command replies (which
  // are fast — millisecond turns for diagnostic commands like
  // /agents) raced ahead of the server's out-of-turn user_message
  // envelope. The reply rendered FIRST, the user's "/agents" bubble
  // landed below it. Local-first upsert under a PWA-minted
  // userMessageId fixes the order; the server's later user_message
  // broadcast dedups via the same id.
  slashCommands.init({
    input: composerInput,
    onDispatch: (cmdText) => {
      const hasAtt = attachments.hasPending();
      const userMessageId = `umsg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      // Optimistic user bubble — slash commands succeed optimistically
      // (server-side validation produces an error envelope, not a
      // !ok response, so no .failed flip needed).
      const sendChatId = resolveOrMintSendChatId();
      if (sendChatId) {
        transcriptStore.addPendingSend(sendChatId, {
          messageId: userMessageId,
          text: cmdText,
          source: 'text',
          sentAt: Date.now(),
          attachments: hasAtt ? attachments.toChatEcho() : undefined,
        });
      }
      const opts: Record<string, any> = { userMessageId };
      if (sendChatId) opts.chatId = sendChatId;
      const slashFail = (e: any) => {
        const msg = e?.message || String(e);
        diag(`slash sendMessage failed: ${msg}`);
        status.setStatus(`Send failed: ${msg}`, 'err');
      };
      if (hasAtt) {
        // Async payload build (large attachments stream to upload first).
        // Snapshot taken synchronously in toSendPayload, so the clear()
        // below is safe.
        attachments.toSendPayload()
          .then((att) => { opts.attachments = att; return backend.sendMessage(cmdText, opts); })
          .catch(slashFail);
      } else {
        try { backend.sendMessage(cmdText, opts); }
        catch (e: any) {
          slashFail(e);
          releaseCaptureIfActive();
          return;
        }
      }
      attachments.clear();
      playFeedback('send');
      composerInput.value = '';
      composerDrafts.clearDraft(sendChatId);
      autoResize();
      updateSendButtonState();
    },
  });
  // Enter-key handling. Desktop: Enter sends, Shift+Enter newline (chat
  // convention). iOS (PWA + Cap): Enter inserts newline like a normal
  // textarea — soft keyboards don't have shift+enter, so binding Enter
  // to send leaves no easy way to add a line break. Send button is the
  // unambiguous send affordance on touch. Matches Gemini / ChatGPT iOS.
  // iPad with hardware keyboard is still iOS by UA — power users get
  // Cmd+Enter via the global handler below.
  const isIosComposer = /iPad|iPhone|iPod/.test(navigator.userAgent);
  composerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      if (isIosComposer) return;        // default = newline; tap send
      // While a memo (incl. batch dictate-to-composer) bar is up, Enter
      // means "finish the memo + transcribe", NOT "send the typed text".
      // The document-level memo keydown handler owns that (it calls
      // composerSend.click()). Bail here so the existing composer text
      // isn't fired off first — this listener runs before the doc one.
      if (memoActive) return;
      e.preventDefault();
      sendTypedMessage();
    }
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

  // Drag-and-drop attach on the whole main app area (everything to
  // the right of the drawer — transcript, the dark side gutters, and
  // the composer). Same gate as the + button: only accept when the
  // model (or its vision fallback) can process attachments.
  // attachments.add() validates each file's type + size internally
  // and surfaces errors via the status line.
  //
  // Counter pattern for dragenter/dragleave: bare booleans flicker
  // because dragleave fires every time the pointer crosses a child
  // boundary. Tracking depth keeps the highlight steady until the
  // pointer truly exits the area.
  const mainDropZone = document.querySelector('.main') as HTMLElement | null;
  if (mainDropZone) {
    // Wheel over the dark side gutters (the .main area flanking the
    // centered .chat-column) scrolls the transcript, so the user doesn't
    // have to land the cursor on the narrow text column to scroll. The
    // gutters only exist on wide viewports where .chat-column hits its
    // max-width; on mobile the column fills the width so this never fires.
    const chatColumn = mainDropZone.querySelector('.chat-column');
    mainDropZone.addEventListener('wheel', (e: WheelEvent) => {
      // Only forward from the gutters; inside the column the transcript
      // and composer scroll/behave natively.
      if (chatColumn && chatColumn.contains(e.target as Node)) return;
      const transcriptEl = document.getElementById('transcript');
      if (!transcriptEl) return;
      // deltaMode 1 = lines (Firefox); approximate a line as 16px.
      const factor = e.deltaMode === 1 ? 16 : 1;
      transcriptEl.scrollTop += e.deltaY * factor;
      e.preventDefault();
    }, { passive: false });

    let dragDepth = 0;
    const hasFiles = (e: DragEvent): boolean => {
      const types = e.dataTransfer?.types;
      if (!types) return false;
      // dataTransfer.types is a DOMStringList in older browsers; both
      // forms support `.includes`-style checks via Array conversion.
      for (const t of Array.from(types as any) as string[]) {
        if (t === 'Files') return true;
      }
      return false;
    };
    mainDropZone.addEventListener('dragenter', (e: Event) => {
      const dragEvent = e as DragEvent;
      if (!hasFiles(dragEvent) || !canAttachFiles()) return;
      dragEvent.preventDefault();
      dragDepth += 1;
      mainDropZone.classList.add('drag-over');
    });
    mainDropZone.addEventListener('dragover', (e: Event) => {
      const dragEvent = e as DragEvent;
      if (!hasFiles(dragEvent) || !canAttachFiles()) return;
      // preventDefault is required for `drop` to fire on this element.
      dragEvent.preventDefault();
      if (dragEvent.dataTransfer) dragEvent.dataTransfer.dropEffect = 'copy';
    });
    mainDropZone.addEventListener('dragleave', (e: Event) => {
      const dragEvent = e as DragEvent;
      if (!hasFiles(dragEvent)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) mainDropZone.classList.remove('drag-over');
    });
    mainDropZone.addEventListener('drop', async (e: Event) => {
      const dragEvent = e as DragEvent;
      if (!hasFiles(dragEvent)) return;
      dragEvent.preventDefault();
      dragDepth = 0;
      mainDropZone.classList.remove('drag-over');
      if (!canAttachFiles()) {
        status.setStatus('Drop ignored — selected model does not support attachments', 'err');
        return;
      }
      const files = Array.from(dragEvent.dataTransfer?.files || []);
      for (const f of files) await attachments.add(f);
    });
  }

  // Image-upload UI gate + per-model capability cache — see modelCapabilities.ts.
  initModelCapabilities({
    btnAttach,
    btnCamera,
    getCurrentModelId: () => String(agentSettingsMod.getCurrentValue('model') ?? ''),
  });

  // Surface a system line in the live chat when the model changes via
  // the settings panel — same pattern as the cli's `/model` confirmation.
  // Lists declared input modalities so the user knows whether image /
  // pdf / audio inputs will work without trial-and-error.
  window.addEventListener('agent-setting-changed', (e: Event) => {
    const detail = (e as CustomEvent).detail || {};
    if (detail.id !== 'model') return;
    const modelId = String(detail.value || '');
    if (!modelId) return;
    // Resolve modalities from the live caps lookup. If models.dev knows
    // the model, label is "text" or "text, image" based on supports_vision;
    // otherwise fall back to "text" plus a note if vision_fallback_model
    // is configured (hermes will route via auxiliary).
    void fetchModelCaps(modelId).then(caps => {
      let inputs: string;
      const fallback = getVisionFallbackModel();
      if (caps && caps.known) {
        inputs = caps.supports_vision ? 'text, image' : 'text';
      } else if (fallback) {
        inputs = `text  ·  images route via ${fallback}`;
      } else {
        inputs = 'text  ·  capability unknown to models.dev';
      }
      chat.addSystemLine(`Model: ${modelId} — accepts ${inputs}`);
    });
  });

  // New-chat button — lives in the sidebar now (#sb-new-chat). Works for
  // every backend, regardless of whether it supports session browsing,
  // since newSession is just a conversation-name rotation. /new slash
  // command is a separate path handled by sendTypedMessage.
  const btnNewChat = document.getElementById('sb-new-chat');
  if (btnNewChat) {
    btnNewChat.onclick = async () => {
      // NO connectivity gate (field 2026-07-21, walking-test): new chat
      // is FULLY LOCAL — backend.newSession() mints the chat_id
      // synchronously and its only I/O is a fire-and-forget IDB
      // setActive; there is no server-side rotation call (the server
      // row materializes lazily on first send, which is itself
      // offline-queued). Gating on isConnected() — the flapping SSE
      // boolean — swallowed the click on spotty links and left the
      // user staring at the previous session.
      // No-op if there's already an active chat AND it's empty (no
      // real content in the transcript). Without this guard, rapid
      // new-chat clicks accumulate empty 'New chat / 0 msgs' rows in
      // the drawer for every press. Skip the guard on first-ever
      // click (no active chat yet) so a fresh install still mints one.
      //
      // Source of truth: transcriptStore.durable for the currently-
      // viewed chat. The DOM-row count check the prior version used
      // (`.line.s0, .line.agent`) missed several non-empty shapes:
      //
      //   • tool-call-only chats (agent did a search but the final
      //     reply was deleted, retried, or never finalized) — DOM has
      //     only `.line.tool` rows, no `.line.s0/.agent`, but the
      //     chat IS populated and the user expects New chat to mint
      //     a fresh one.
      //   • a chat whose user/agent rows are mid-render (in-flight
      //     reconciler pass) — DOM transient, store already durable.
      //   • a chat the projection re-classified — e.g. notification
      //     rows from a cron delivery.
      //
      // Each of those would FALSELY trigger the no-op, leaving the
      // user on the existing (populated) chat and making the click
      // look like "New chat opened an existing chat" (Jonathan field
      // bug 2026-06-23). The store check is shape-agnostic — any
      // row in ANY of the three buckets (durable, inflight, pendingSends)
      // counts as content. Durable alone is not enough — between
      // user-send and reply_final the user message lives only in
      // inflight/pendingSends, but the DOM shows a `.line.s0` bubble;
      // a guard that ignores inflight would no-op the click in that
      // window (regression caught by `sidebar-immediate-title`).
      const viewedForGuard = switchCtl.viewedId();
      // peekState (non-creating): on a cold resume whose boot fetch
      // failed (offline mobile relaunch — snapshot DOM on screen, store
      // never hydrated) the viewed chat has NO store entry at all.
      // getState's lazy-create would read that as "hydrated and empty"
      // and the guard below would swallow a legitimate click. Absent
      // state = UNKNOWN content → treat as non-empty so the click always
      // mints. A state that EXISTS with empty buckets is a genuinely
      // empty chat (hydrated-empty resume, or a fresh mint whose
      // 'New chat started' decoration created the entry) → no-op holds.
      const guardState = viewedForGuard ? transcriptStore.peekState(viewedForGuard) : null;
      const hasContent = viewedForGuard
        ? (guardState
            ? guardState.durable.length + guardState.inflight.length + guardState.pendingSends.length > 0
            : true)
        : false;
      const hasActiveChat = !!backend.getCurrentSessionId?.();
      // Keep the DOM ref around — sweep paths further down still
      // operate against it.
      const transcriptEl = document.getElementById('transcript');
      // A session switch that hasn't committed/cleared yet has blanked the
      // transcript behind a loading spinner — that's a LOADING state, not
      // an empty active chat, so the no-op guard must not swallow the click
      // (else the first New-chat press does nothing, the user waits out the
      // spinner, sees the prior transcript, and has to click again — field
      // bug 2026-06-16). optimisticId() is set at begin() and cleared on
      // settle, so it's the in-flight-switch signal.
      const switchInFlight = !!switchCtl.optimisticId();
      if (hasActiveChat && !hasContent && !switchInFlight) {
        diag('new-chat: current chat empty, no-op');
        return;
      }
      diag('reset history: new-chat button');
      // Supersede any in-flight resume BEFORE the rotation, mirroring
      // deleteSessionAtomic. Without this, a session-switch resume() that's
      // still awaiting its cache/server render lands seconds later (the
      // server-render continuation is gated only by isCurrent(tok), and
      // new-chat never bumped the generation), repaints the PRIOR session's
      // transcript over the fresh new chat, and re-commits viewed. Bumping
      // gen here makes that continuation bail; clearing optimistic re-points
      // focusedId() at the new chat. Field bug 2026-06-16 (new-session glitch).
      switchCtl.invalidate();
      switchCtl.setOptimistic(null);
      // Intentionally do NOT stop streaming or cancel memo — new-chat is a
      // conversation rotation, not a full reset. Users expect to stay in
      // whatever audio mode they were in (streaming stays green, memo bar
      // stays open if open). If memo has an in-flight blob queued in the
      // outbox, it'll send against the NEW session. That's a conscious
      // trade: user asked for a fresh thread, they get one.
      const prevViewed = switchCtl.viewedId();
      if (prevViewed) {
        // Mirror sessionDrawer.resume()'s leaving-chat pattern. Without
        // this, transcriptStore.clearAll(prevViewed) → reconciler removes
        // bubbles → scrollHeight collapses → browser fires scroll(0)
        // → chat.ts scroll listener saves scrollTop=0 against
        // viewedSessionIdRef (which still points at prevViewed) →
        // prevViewed's saved scroll position is poisoned to 0. Restore
        // on return reads 0 → scrollTo top. Field bug 2026-05-24
        // (scroll_save_failing2.mov): mid-history → New chat → send
        // → return jumped to top of prior chat.
        chat.saveCurrentScrollPosition();
        flushScrollPosition(prevViewed);
        chat.trackViewedSession(null);
        transcriptStore.clearAll(prevViewed);
      }
      draft.dismiss();
      voiceMemos.clearAll().catch(() => {});
      // Blank the input surfaces atomically — but PRESERVE typed text
      // as the leaving chat's draft (per-chat drafts, 2026-07-12; the
      // old bare `value = ''` destroyed it). Synthetic `input` event
      // re-runs autoResize + updateSendButtonState in one go; it's
      // dispatched after the stash, when no chat is bound, so the
      // draft listener ignores it. The minted chat binds via the
      // setViewed → view-commit seam below.
      composerDrafts.stashAndClear();
      composerInput.dispatchEvent(new Event('input'));
      attachments.clear();
      historyLoaded = false;
      // newSession mints the chat_id SYNCHRONOUSLY (activeChatId is set
      // before its first await — mintChatId is pure), so
      // getCurrentSessionId() below is already correct without waiting.
      // The await it used to carry was only the IDB setActive
      // persistence — durability, not correctness — and IDB writes
      // queue behind whatever else is writing, which made new-chat
      // "sometimes instant, sometimes seconds" on a busy profile
      // (field 2026-07-13). Fire-and-forget; a reload racing the write
      // just boots into the previous session, same as before the mint.
      void backend.newSession?.();
      // Hard-reset the on-screen transcript before painting the blank chat.
      // transcriptStore.clearAll above drops the projection BUBBLES, but two
      // DOM artifacts survive it (field bug 2026-06-16):
      //   - KEYLESS `.line.system` rows the reconciler deliberately
      //     PRESERVES. Post-phase-4 these come only from the boot
      //     HTML-snapshot restore (addSystemLine now writes keyed
      //     decorations the reconciler owns) — sweep the keyless ones
      //     so snapshot leftovers can't linger over the fresh chat;
      //     model-owned rows (data-key) belong to their chat's state
      //     and are cleaned up by the reconciler itself.
      //   - a cold session-switch resume that was mid-flight already armed
      //     `.transcript-loading`; new-chat supersedes that resume
      //     (invalidate above) so its continuation bails before reaching the
      //     class-clear in sessionResume → the spinner would spin forever
      //     over the fresh blank chat (symptom 3).
      // Sweep both here, in the DOM, AFTER the scroll-save dance above so the
      // leaving chat's scrollTop is already captured against its real height.
      if (transcriptEl) {
        transcriptEl.querySelectorAll('.line.system:not([data-key])').forEach((el) => el.remove());
        transcriptEl.classList.remove('transcript-loading');
      }
      // Pin the viewed-session to the freshly-rotated chat_id BEFORE the
      // system line: addSystemLine writes a decoration into the FOCUSED
      // chat's state (phase 4), so the view must already point at the
      // minted chat or the line would fall to the no-chat DOM fallback.
      // Invariant: getViewed() mirrors the session on screen so
      // handleReplyDelta / handleReplyFinal don't drop incoming
      // envelopes for it.
      const newChatId = backend.getCurrentSessionId?.() || null;
      sessionDrawer.setViewed(newChatId);
      // Mirror into chat.viewedSessionIdRef so subsequent in-bubble
      // chat-id resolution (pin button, snapshot persist) sees the
      // new chat. Without this, pin-on-bubble in a fresh chat resolves
      // the chatId to whatever the prior viewed was (smoke
      // `pin-drawer-jump` regression).
      chat.trackViewedSession(newChatId);
      // Reset pagination to the fresh chat's reality: NO history, no
      // cursors. Without this, the previous chat's hasMore/oldest-id
      // leak across the rotation — the empty chat sits at scrollTop=0,
      // maybeLoadEarlier sees the stale hasMore and fires a bogus
      // load-earlier for the chat we just LEFT (top edge spinner over
      // a brand-new chat + a wasted fetch whose paint gets refused
      // downstream; field nit 2026-07-13).
      chat.setPaginationState(null, false, null, false);
      chat.addSystemLine('New chat started');
      // New chat is always parley-source; ensure composer is enabled
      // (in case user just rotated away from a non-parley chat).
      setComposerReadOnly(false);
      // Typeable immediately, no second tap (walking-test spec 2026-07-10;
      // the meeting-capture landing already does this — plain new-chat
      // left focus on BODY, caught by the session-budgets carve).
      composerInput.focus();
      // Re-render the session list so the old session row loses its
      // active highlight (new one isn't in response_store.db yet —
      // the optimistic placeholder row covers it).
      sessionDrawer.refresh();
      // No auto-cleanup of empty drawer rows. Removed 2026-05-05 after
      // confirmed data loss: at least 2 parley sessions
      // (20260430_092241_ff0bada3 "Series A pitch deck init",
      // 20260501_062917_89254e19 "YouTube investment memo") were wiped
      // by this sweep when their messageCount transiently read 0 during
      // hermes session-rotation/compression. Reaches into server state
      // for "tidiness" — a backend-destructive optimization with no
      // user signal. Hard rule: parley never auto-deletes
      // server-side data. Stale empty rows live in the drawer until the
      // user removes them via the row menu (which has a confirm dialog).
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
    // Revert the batch-dictation accept affordance (checkmark + tooltip).
    composerSend.classList.remove('accept-mode');
    composerSend.title = 'Send  ·  ⏎';
    // Clear voice-state classes on the mic button when memo dismisses.
    // .active is also flipped via voiceActive() polling indirectly, but
    // explicit removal here keeps the visual in sync without waiting.
    if (btnMic) {
      btnMic.classList.remove('active', 'listening');
    }
    updateSendButtonState();
  }

  memoOutbox.startBackgroundPollers();

  // ── Cursor-aware dictation (call=true, autoSend=false) ─────────────
  // webrtcDictate is the live-streaming + cursor-aware injection module.
  // init() binds the textarea + wires its user-input/cursor listeners.
  webrtcDictate.init(composerInput);
  // Pre-render chime WAVs at boot so primeFeedback() can unlock each
  // HTMLAudioElement synchronously inside the first call/dictate gesture
  // (offline render needs no gesture). See feedback.ts primeFeedback.
  warmFeedback();
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
      // Audible "your turn" cue — same chime call mode plays from the
      // bridge's listening envelope. Dictate doesn't go through the
      // bridge so we fire it directly when the provider reports
      // opening. Matches the chime vocabulary across modes.
      try { playFeedback('listening'); } catch { /* feedback is best-effort */ }
    } else {
      status.setStatus('');
    }
    updateSendButtonState();
  });

  // ── Composer voice dispatch ─────────────────────────────────────────
  //
  // Two-button split (2026-05): btn-mic owns memo + dictation, btn-call
  // owns calls. Each button has its own settings:
  //
  //   btn-mic:  settings.streaming    false=memo,           true=dictation
  //             settings.micAutoSend  false=land in composer, true=auto-send
  //
  //   btn-call: settings.realtime     false=turn-based,     true=WebRTC
  //             settings.tts          false=stream mode,    true=talk mode
  //                                                         (call-only)
  //
  // The four primitives below (startMemo, startDictate, startListen,
  // startCallStream) are mode-pure; the dispatch helpers (startMicMode,
  // startCallMode) read the relevant settings AT TAP TIME so flipping
  // the menu mid-session takes effect on the next tap without a
  // teardown. Each primitive is idempotent: starting a mode while the
  // mic is held by another mode tears that mode down first.

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
  async function startMemo(
    autoSend: boolean,
    dictateToComposer = false,
    initialCursor: number | null = null,
  ): Promise<void> {
    if (memoActive) return;
    if (dictateActive) await webrtcDictate.stop();
    if (webrtcControls.isOpen()) await webrtcControls.closeIfOpen('start-memo');
    // Batch dictation: register the composer insertion anchor NOW, at
    // recording start (the cursor captured at the mic gesture site).
    // The transcript can land seconds — or, via the durable outbox
    // retry, minutes — later; the anchor slides with edits in between
    // so the text lands where the utterance was aimed, not wherever
    // the caret sits at flush time (Jonathan field bug 2026-07-21).
    const dictateAnchorId = dictateToComposer ? composer.createAnchor(initialCursor) : null;
    // iOS AVAudioSession prep: prepareForCapture before getUserMedia.
    primeAudio(player);
    audioSession.prepareForCapture();
    memoActive = true;
    log('[mic-diag] memoActive=true (startMemo)');
    // Batch dictation (dictateToComposer): the relocated send button finishes
    // the recording and drops the clean transcript into the composer — it
    // does NOT send and never renders a voice-memo card. Swap to a checkmark
    // + matching tooltip so the affordance reads "accept into composer", not
    // "send". exitMemoMode reverts it.
    if (dictateToComposer) {
      composerSend.classList.add('accept-mode');
      composerSend.title = 'Insert transcript into composer';
    }
    updateSendButtonState();
    composerSend.onclick = async () => {
      if (composerSend.disabled) return;
      composerSend.disabled = true;
      try {
        const { audioBlob, durationMs } = await memo.stop();
        exitMemoMode();
        if (dictateToComposer) {
          await memoOutbox.transcribeToComposer(audioBlob, durationMs, dictateAnchorId);
        } else {
          await memoOutbox.handleMemoResult(audioBlob, durationMs, autoSend, 'composerSend.click');
        }
      } finally {
        composerSend.disabled = false;
      }
    };
    const mount = enterComposerBarMount();
    // Hide composer-actions synchronously alongside the bar mount so
    // there's no frame where both stack in the flex column (the brief
    // "extra row" composer jump). The bar itself mounts inside
    // memo.start() before any await — see memo.ts:67 — so the user
    // never sees an empty composer; the bar's empty-waveform shows
    // until the analyser attaches. (Reverts the deferred-hide rationale
    // from 2026-05-05.) exitMemoMode restores it on failure.
    mount?.hide();
    const ok = await memo.start({
      container: mount?.container,
      insertBefore: mount?.insertBefore || composerSend,
      sendBtn: composerSend,
      onDone: (audioBlob) => {
        exitMemoMode();
        if (dictateToComposer) {
          void memoOutbox.transcribeToComposer(audioBlob, undefined, dictateAnchorId);
        } else {
          memoOutbox.handleMemoResult(audioBlob, undefined, autoSend, 'memo.onDone');
        }
      },
      onCancel: () => {
        // Recording discarded — nothing will consume the anchor.
        composer.releaseAnchor(dictateAnchorId);
        exitMemoMode();
      },
    });
    if (!ok) {
      composer.releaseAnchor(dictateAnchorId);
      exitMemoMode();
      status.setStatus('Mic not available', 'err');
      return;
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
    // Realtime dictation OFF: record the whole utterance and batch one
    // /transcribe on stop, dropping the clean transcript into the
    // composer without auto-send. Reuses the memo/outbox pipeline —
    // startMemo(false) appends text and never submits. Fixes long-form
    // over-punctuation from per-pause streaming finals (#112).
    if (!settings.get().dictateRealtime) {
      await startMemo(false, /* dictateToComposer */ true, initialCursor);
      return;
    }
    // streamingEngine === 'local' uses browser Web Speech (Chrome/Safari);
    // it's typically reachable even when navigator.onLine reports false
    // since most browsers cache enough to keep recognising. Skip the
    // memo fallback for the local engine — fall through to the speech
    // start, which throws cleanly if Web Speech is genuinely unavailable.
    const useLocalEngine = settings.get().streamingEngine === 'local';
    if (!navigator.onLine && !useLocalEngine) {
      status.setStatus('Offline — using memo mode', null);
      await startMemo(false, /* dictateToComposer */ true, initialCursor);
      return;
    }
    primeAudio(player);
    primeFeedback();
    audioSession.prepareForCapture();
    try {
      // Engine selector — server (default) routes the WebRTC bridge;
      // local uses the in-browser SpeechRecognition path. Both are
      // STTProvider impls so dictate.ts's cursor-aware splice machine
      // stays the single owner of the textarea state.
      const provider = browserDictate.pickStreamingProvider();
      const chatId = switchCtl.viewedId() || backend.getCurrentSessionId?.() || null;
      await webrtcDictate.start({
        sessionId: chatId,
        chatId,
        initialCursor,
        provider,
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
    // Prime audio inside the gesture (pointerdown → startVoice →
    // startCallStream) — without this the shared AudioContext stays
    // null on iOS and feedback.ts falls back to a suspended private
    // ctx. Result: the bridge's first {type:'listening'} envelope
    // arrives but playFeedback('listening') silently no-ops on iOS.
    // Symmetric with startMemo/startDictate which already prime.
    primeAudio(player);
    // Unlock the chime elements in-gesture too — the call-start
    // 'listening' cue fires async from the bridge envelope, after the
    // user-activation window may have closed (see feedback.ts).
    primeFeedback();
    // Stop any text-mode TTS playback before the WebRTC peer track
    // takes over the speaker — otherwise the two compete on the
    // same audio output.
    cancelReplyTts();
    audioSession.prepareForCapture();
    // openCall picks the mode per the user's settings.tts preference at
    // open time — same behavior as the old toolbar mic, just invoked
    // from the composer.
    //
    // Talk mode requires bridge-side TTS over the WebRTC peer track.
    // When ttsEngine === 'local' (browser speechSynthesis), the bridge
    // wouldn't be the audio source — there's nothing for the call's
    // outbound audio path to carry. Force stream mode in that case so
    // the user gets text replies + can use the per-bubble play button
    // (which honors ttsEngine='local'). Set 2026-05-03 v0.401.
    const sx = settings.get() as any;
    const wantTalk = sx.tts && sx.ttsEngine !== 'local';
    const mode: 'stream' | 'talk' = wantTalk ? 'talk' : 'stream';
    try {
      await webrtcControls.openCall(mode);
    } catch (e: any) {
      diag('call open failed', e?.message);
    }
  }

  async function stopCallStream(): Promise<void> {
    if (!webrtcControls.isOpen()) return;
    await webrtcControls.closeIfOpen('stop-call-stream');
  }

  // ── Listen mode (turn-based handsfree) ─────────────────────────────
  // Listen is the third handsfree mic mode: records locally with
  // MediaRecorder (like memo), commits the buffered blob to /transcribe
  // on silence (Phase 1) or sendword (Phase 2), drops the transcript
  // into the composer, auto-submits, then re-arms after reply playback.
  // Lives alongside Talk/Stream — never replaces them.
  let listenActive = false;
  async function startListen(): Promise<void> {
    if (listenActive) return;
    if (memoActive) return;
    if (dictateActive) await webrtcDictate.stop();
    if (webrtcControls.isOpen()) await webrtcControls.closeIfOpen('start-listen');
    primeAudio(player);
    audioSession.prepareForCapture();
    // Mount the recorder bar via the shared helper — same place memo
    // uses, identical hide/restore semantics for the composer-actions
    // row. Reuses recorderBar.mount under the hood for visual parity.
    const mount = enterComposerBarMount();
    // Hide composer-actions synchronously alongside the bar mount so
    // there's no frame where both stack in the flex column. Same
    // rationale as startMemo — the bar's recorderBar.mount runs before
    // any await so the user sees the bar (with empty waveform) rather
    // than an empty composer.
    mount?.hide();
    // Move btn-mic into the bar's right-end slot so the user has a
    // visible "end call" affordance (mirrors how memo embeds the send
    // button). The btn-mic's existing pointer handlers in main.ts
    // already do the right thing on click while listenActive: route
    // through stopVoice → stopListen. The .listening / .active CSS
    // classes give it the red end-call appearance.
    const btnMicOriginalParent = btnMic?.parentElement || null;
    const btnMicOriginalNextSibling = btnMic?.nextElementSibling || null;
    const restoreComposerActions = () => {
      // Restore btn-mic to its original DOM home BEFORE un-hiding the
      // composer-actions row so it's back in its slot when visible.
      if (btnMic && btnMicOriginalParent && btnMic.parentElement !== btnMicOriginalParent) {
        try { btnMicOriginalParent.insertBefore(btnMic, btnMicOriginalNextSibling); }
        catch { btnMicOriginalParent.appendChild(btnMic); }
      }
      mount?.restore();
    };
    const ok = await turnbased.start({
      barContainer: mount?.container || null,
      barInsertBefore: mount?.insertBefore || null,
      barRightBtn: btnMic || null,
      onCommit: async (blob, reason) => {
        // Durable-first: the committed turn rides the same IDB outbox as
        // memos/dictation — memoOutbox owns transcribe (with keyterms +
        // chunking + timeout budgets), sendword strip, and auto-send.
        // The previous inline fetch here had NO timeout and NO
        // persistence: a dead connection mid-call hung the turn and
        // ending the call evaporated it (2026-06-10 field report).
        // chatId captured now so a late flush never sends cross-chat.
        try {
          const chatId = resolveOrMintSendChatId();
          await memoOutbox.transcribeListenTurn(blob, reason, chatId);
        } catch (e: any) {
          diag('listen: turn enqueue failed', e?.message);
        }
      },
      onCommitText: async (text, reason) => {
        // LOCAL streamingEngine path — turnbased.ts already ran Web
        // Speech in-browser and accumulated the transcript. No
        // /transcribe call, so the transcript can't be lost to a failed
        // upload — but the SEND still can. Sendword is stripped here
        // (text is final at commit time), then the body rides the same
        // durable outbox as server-engine turns so a dead connection
        // retains it for retry instead of evaporating it.
        let body = text;
        if (body && reason === 'sendword') {
          const { sendwordPhrase } = handsfree.getHandsfreeConfig();
          const m = handsfree.matchSendword(body, sendwordPhrase);
          if (m.matched) body = m.cleaned;
        }
        if (!body) {
          log('listen: empty local transcript, skipping send');
          return;
        }
        try {
          const chatId = resolveOrMintSendChatId();
          await memoOutbox.sendListenText(body, chatId);
        } catch (e: any) {
          diag('listen: text turn enqueue failed', e?.message);
        }
      },
      onCancel: () => {
        listenActive = false;
        if (btnMic) btnMic.classList.remove('listening-armed', 'listening');
        status.setStatus('');
      },
      onBarge: () => {
        // User spoke during TTS — PAUSE (not cancel) so the audio
        // position survives. User can then resume by clicking the
        // bubble's play button, OR talk to commit a new turn (Listen
        // re-arms via the 'paused' tts event subscribed at boot).
        // The barge bleed itself isn't shipped — the NEXT clean turn
        // is what gets committed if the user keeps talking.
        try { ttsModule.pauseReplyTts(); } catch { /* noop */ }
      },
      onState: (s) => {
        if (btnMic) {
          btnMic.classList.toggle('listening-armed', s === 'armed' || s === 'committing');
          btnMic.classList.toggle('listening', s === 'armed');
        }
        if (s === 'armed') status.setStatus('Listen: armed', 'live');
        else if (s === 'committing') status.setStatus('Listen: sending…', null);
        else if (s === 'playing') status.setStatus('Listen: speaking…', null);
        else if (s === 'cooldown') status.setStatus('Listen: re-arming…', null);
        else if (s === 'idle') {
          status.setStatus('');
          // Restore the composer-actions row that startListen hid so
          // the recorder bar could take its place. Tied to the 'idle'
          // transition (single point) so it covers every teardown
          // path: trash button, stopListen, mic-error fallback.
          restoreComposerActions();
        }
        // Wake-lock follows call state — release on idle, acquire on
        // armed/committing/playing/cooldown if user has the toggle on.
        evaluateWakeLock();
      },
    });
    if (!ok) {
      listenActive = false;
      restoreComposerActions();
      status.setStatus('Mic not available', 'err');
      return;
    }
    listenActive = true;
  }

  function stopListen(): void {
    if (!listenActive) return;
    listenActive = false;
    turnbased.stop();
    // Clear ALL voice-state classes — .active is added synchronously
    // on pointerdown (line ~2235) for immediate red-circle feedback,
    // but Listen's path doesn't go through the call/dictate cleanup
    // that normally removes it. Without explicit removal here, the
    // mic button stays red after Listen disarms even though the
    // micState is correctly 'idle'.
    if (btnMic) btnMic.classList.remove('listening-armed', 'listening', 'active');
  }

  // Voice coordination layer (extracted to src/voiceController.ts). Created
  // here — after composerSend + every mode start/stop fn exists — so the
  // factory's deps are all in scope. The state flags stay boot-scope locals
  // (mutated by many non-voice sites), read via live getters; memoActive is
  // also written by releaseCaptureIfActive, so it's plumbed via a setter.
  // Const-aliased back to the original names so every call site (all inside
  // runtime callbacks, hence TDZ-safe) stays unchanged.
  const voiceCtl = createVoiceController({
    getMemoActive: () => memoActive,
    setMemoActive: (v) => { memoActive = v; },
    getDictateActive: () => dictateActive,
    getListenActive: () => listenActive,
    webrtcControls,
    webrtcDictate,
    memo,
    capture,
    composerSend,
    stopDictate,
    stopCallStream,
    stopListen,
    startDictate,
    startMemo,
    log,
  });
  const voiceActive = voiceCtl.voiceActive;
  const stopVoice = voiceCtl.stopVoice;
  const startMicMode = voiceCtl.startMicMode;
  releaseCaptureIfActive = voiceCtl.releaseCaptureIfActive;

  // Test hook (mirrors window.__listen): lets smokes drive the mic
  // dispatch without synthesizing the pointer gesture. Used by
  // dictate-realtime-toggle to prove a 'tap' routes to memo (batch
  // /transcribe → composer) when settings.dictateRealtime is off.
  (window as any).__micDispatch = (gesture: 'tap' | 'hold') => startMicMode(gesture);

  /** Call-button dispatch. Realtime ON → WebRTC duplex (talk if
   *  speak-replies is on, else stream). Realtime OFF (the default) →
   *  turn-based Listen: full local audio buffer, sent to the server
   *  only when the user finishes speaking. Optimized for fidelity over
   *  latency; ideal when reply latency is dominated by the LLM
   *  round-trip. */
  // Re-entrancy guard: rapid btn-call taps during the cold-start audio-
  // session prime (~1.5s) used to spawn parallel startListen chains, each
  // creating its own MediaStream — only the last was tracked. Field
  // repro 2026-05-05: 3 taps → 3 "capture: acquired by listen" entries +
  // visible duplicate recorder bars, mic held by extras after end. The
  // capture.ts pendingOwner reservation now blocks the dupe streams
  // defensively; this guard prevents the racing chains from being kicked
  // off in the first place. Symmetric with controls.ts's btn-call disable
  // for WebRTC's requesting-mic/connecting states (turn-based listen
  // doesn't go through that state machine, hence this layer).
  let callOpening = false;
  async function startCallMode(): Promise<void> {
    if (callOpening) return;
    callOpening = true;
    try {
      const s = settings.get();
      if ((s as any).realtime) {
        await startCallStream();
      } else {
        await startListen();
      }
    } finally {
      callOpening = false;
    }
  }

  /** Read the current composer cursor position. Called BEFORE focus
   *  shifts off the textarea (mic-button pointerdown, hotkey handler)
   *  so the value reflects the user's intended insertion point. Returns
   *  null if the textarea has never been focused / has no selection
   *  data — dictate.ts will fall back gracefully. */
  function captureComposerCursor(): number | null {
    try {
      // Live read first — works when the textarea is still focused at
      // gesture time. On at least some browsers, button mousedown
      // shifts focus before our pointerdown handler runs, so by the
      // time we read selectionStart the textarea is blurred and the
      // value can be stale (0, value.length, or null depending on
      // browser). Fall back to composer.getLastCaret(), which is
      // tracked via a global selectionchange listener and reflects the
      // user's actual last-set caret position regardless of focus.
      if (document.activeElement === composerInput) {
        const ss = composerInput.selectionStart;
        if (typeof ss === 'number') return ss;
      }
      return composer.getLastCaret();
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
    // finger drifts onto the memo bar. Drag the finger ANY direction
    // (up/down/left/right) past the memo bar's padded bounds →
    // discard-armed; release in red → discard. The bar itself is the
    // "still recording" zone; outside the padded rect arms discard.
    // 200ms originally — too tight for a deliberate "tap" gesture
    // (natural finger lift takes ~250ms). Was 350ms (iOS long-press
    // range) but felt laggy in field use 2026-05-09; 280 splits the
    // difference: PTT triggers crisply for deliberate holds while
    // ~250ms tap-releases still classify as taps. If you start hitting
    // "I tapped to toggle but it recorded" misfires, bump back up.
    const TAP_THRESHOLD_MS = 280;

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

    /** Padding (px) added on every side of the memo bar's bounding rect
     *  before the inside/outside test. Generous margin so a finger
     *  hovering near the bar's edge stays classified as "still
     *  recording" — no false negatives where a near-edge release
     *  accidentally discards. Once the pointer
     *  clears this padded zone in ANY direction, discard arms. */
    const MEMO_BAR_DISCARD_PADDING_PX = 40;

    /** Inside-memo-bar hit test (padded). Returns true when the pointer
     *  is inside the memo bar's bbox expanded by MEMO_BAR_DISCARD_PADDING_PX
     *  on every side. The drag-to-discard gesture arms whenever this is
     *  false, so the user can flick the finger up, down, left, or right
     *  off the bar to discard — not just leftward. */
    function isInsideMemoBar(clientX: number, clientY: number): boolean {
      if (!holdMemoBar) return false;
      const r = holdMemoBar.getBoundingClientRect();
      const pad = MEMO_BAR_DISCARD_PADDING_PX;
      return (
        clientX >= r.left - pad &&
        clientX <= r.right + pad &&
        clientY >= r.top - pad &&
        clientY <= r.bottom + pad
      );
    }

    /** Trash-icon hit test. The trash icon is inside the memo bar
     *  (so isInsideMemoBar returns true when the pointer is over it),
     *  but it's a deliberate visual affordance — users naturally slide
     *  toward the trash to discard. Discard arms on EITHER condition:
     *  pointer outside the padded memo bar, OR pointer over the trash
     *  icon. Both conditions arm discard independently. */
    function isOverTrashZone(clientX: number, clientY: number): boolean {
      const trash = holdMemoBar?.querySelector('.memo-trash') as HTMLElement | null;
      if (!trash) return false;
      const r = trash.getBoundingClientRect();
      return (
        clientX >= r.left &&
        clientX <= r.right &&
        clientY >= r.top &&
        clientY <= r.bottom
      );
    }

    /** Resolve the memo bar element after startMicMode's async setup
     *  completes (mic permission, MediaRecorder spin-up). Polls briefly
     *  to cover iOS getUserMedia latency. Only relevant for memo mode
     *  (Streaming/dictate mode has no .memo-bar). */
    function pollForMemoBar(tries: number): void {
      if ((settings.get() as any).streaming) return;  // dictate mode — no memo bar
      const bar = document.querySelector('.memo-bar') as HTMLElement | null;
      if (bar) {
        bar.classList.add('memo-bar-ptt');
        holdMemoBar = bar;
      } else if (tries > 0) {
        setTimeout(() => pollForMemoBar(tries - 1), 30);
      }
    }

    let holdActivationTimer: ReturnType<typeof setTimeout> | null = null;
    /** Composer cursor captured at pointerdown — consumed when the
     *  classify resolves (TAP → dictate uses it; HOLD → memo discards
     *  it). Stashed at module level so the pointerup handler can read
     *  the value the pointerdown handler captured. */
    let pendingInitialCursor: number | null = null;

    /** Press-down: starts recording immediately (regardless of eventual
     *  tap-vs-hold classification). The release-time duration check
     *  decides whether to keep recording or stop. */
    btnMic.addEventListener('pointerdown', (e: PointerEvent) => {
      diagMicState('pointerdown ENTRY');
      // preventDefault + body.ptt-pressing as the very first acts of
      // the handler — kills iOS's native long-press selection-loupe
      // timer before it has a chance to fire (the loupe was leaking
      // text-selection from the textarea/composer area when the finger
      // landed a few px outside btn-mic's 22x22 hit zone). The
      // body.ptt-pressing class drives a global selection-disable rule
      // mirroring body.fake-lock-engaged, so even if iOS resolves the
      // gesture target to a sibling, no text gets selected. Cleared in
      // the pointerup/pointercancel handlers below.
      try { e.preventDefault(); } catch {}
      try { document.body.classList.add('ptt-pressing'); } catch {}
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
      log('[mic-diag] BRANCH: idle → press start (deferred classify)');
      pressStartedAt = performance.now();
      micState = 'recording';
      holdActive = false;
      holdDiscardArmed = false;
      holdMemoBar = null;
      capturedPointerId = e.pointerId;
      try { btnMic.setPointerCapture(e.pointerId); } catch {}
      // Immediate visual feedback (red dot) so the user sees their
      // press registered even though the actual mode-start is deferred
      // until classify (TAP vs HOLD).
      try { btnMic.classList.add('active'); } catch {}
      // Capture composer cursor BEFORE focus shifts to the mic button.
      // Reading later — after the implicit focus shift / the async
      // startVoice handshake — risks getting 0 / value.length / null
      // on iOS Safari, landing voice text at the wrong location. See
      // dictate.ts ensureAnchor for details. Stash for either branch
      // (timer-fire → memo discards it; pointerup-tap → dictate uses it).
      pendingInitialCursor = captureComposerCursor();
      log('[mic] pointerdown — pressed (t0=', pressStartedAt.toFixed(0), ', initialCursor=', pendingInitialCursor, ')');
      // Deferred-start gesture machine: don't pick a mode yet. After
      // TAP_THRESHOLD_MS, if the finger is still down, classify HOLD →
      // start memo (PTT) + activate drag-to-discard surface. If the
      // finger lifts before the timer fires, classify TAP in the
      // pointerup handler → start dictate instead. This gives us
      // gesture-driven mode selection (tap=dictate, hold=PTT memo)
      // without the cost of starting memo speculatively for every press.
      holdActivationTimer = setTimeout(() => {
        holdActivationTimer = null;
        if (micState !== 'recording') return;
        holdActive = true;
        log('[mic] HOLD threshold elapsed → start PTT memo');
        void startMicMode('hold');
        try {
          status.setStatus('Recording — release to send, drag off bar to discard', 'live');
        } catch {}
        pollForMemoBar(10);
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
      // Discard arms on EITHER:
      //   (a) pointer leaves the padded memo-bar rect in any direction
      //       (up/down/left/right) — natural "drag away" gesture, OR
      //   (b) pointer is OVER the trash icon — deliberate visual target,
      //       user instinct is to slide toward what they want.
      // Both motifs converge on discard intent.
      const discardArmed =
        !isInsideMemoBar(e.clientX, e.clientY)
        || isOverTrashZone(e.clientX, e.clientY);
      if (discardArmed !== holdDiscardArmed) {
        holdDiscardArmed = discardArmed;
        holdMemoBar.classList.toggle('discard-armed', discardArmed);
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

      const classify = dur < TAP_THRESHOLD_MS && !isCancel ? 'TAP' : 'HOLD';
      log('[mic] pointerup — dur=', dur.toFixed(0), 'ms, classify=', classify);

      if (classify === 'TAP') {
        // Pre-classify TAP: holdActivationTimer hasn't fired yet, so
        // memo never started. Cancel the timer + start dictate now.
        // The dictate session ends on second tap (handled by the
        // recording_toggle branch in pointerdown above), Esc, or Send.
        if (holdActivationTimer) {
          clearTimeout(holdActivationTimer);
          holdActivationTimer = null;
        }
        micState = 'recording_toggle';
        recordingToggleAt = performance.now();
        const cursor = pendingInitialCursor;
        pendingInitialCursor = null;
        log('[mic] TAP → start dictate (cursor=', cursor, ')');
        void startMicMode('tap', cursor);
        try {
          status.setStatus('Dictating — tap mic again, Esc, or Send to finish', 'live');
        } catch {}
        return;
      }

      // HOLD → memo started in the timer-fire branch. Finalize:
      //   pointer outside padded memo-bar rect → discard
      //   pointer still inside padded rect → send
      micState = 'idle';
      const wasDiscard = (holdActive && holdDiscardArmed) || isCancel;
      holdActive = false;
      holdDiscardArmed = false;
      const barRef = holdMemoBar;
      holdMemoBar = null;
      pendingInitialCursor = null;
      e.preventDefault();
      e.stopPropagation();
      // Defer a tick so async startVoice's MediaRecorder handshake
      // settles before we ask the same primitive to stop.
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
    // Clear body.ptt-pressing on every press release path so the
    // global selection-disable doesn't outlive the press. iOS PWA can
    // skip pointerup if the finger leaves the screen out of bounds —
    // pointercancel fires for that case, which is why both are wired.
    const clearPttPressing = () => {
      try { document.body.classList.remove('ptt-pressing'); } catch {}
    };
    btnMic.addEventListener('pointerup', clearPttPressing);
    btnMic.addEventListener('pointercancel', clearPttPressing);
    // Safety nets — iOS WKWebView occasionally drops pointerup on
    // btnMic when the gesture overlaps with system events (e.g. mic
    // tap stopping a Listen call also triggers an audio-session
    // transition that can swallow the pointerup). The class then
    // stays on, disabling composer-input until next pointerup.
    // A mic-tap can leave ptt-pressing stuck on alongside swipe-active.
    //
    //   1. visibilitychange — return-to-foreground is a clean
    //      "user definitely isn't pressing the button anymore"
    //      signal; clear unconditionally.
    //   2. Any window pointerdown — if ptt-pressing is on but the
    //      target isn't btnMic, the user moved on. Clear.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && document.body.classList.contains('ptt-pressing')) {
        diag('[mic] safety: clearing stuck ptt-pressing on visibilitychange');
        document.body.classList.remove('ptt-pressing');
      }
    });
    window.addEventListener('pointerdown', (e: PointerEvent) => {
      if (!document.body.classList.contains('ptt-pressing')) return;
      const t = e.target as Node | null;
      if (t && btnMic.contains(t)) return;  // legitimate continued press
      diag('[mic] safety: clearing stuck ptt-pressing on stray pointerdown');
      document.body.classList.remove('ptt-pressing');
    }, { capture: true, passive: true });

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
        // Keyboard activation = TAP semantics (no press-and-hold via
        // Enter/Space) — start dictation.
        void startMicMode('tap', captureComposerCursor());
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

  // ── Call button — tap-to-toggle (no PTT, no drag-to-discard) ───────
  // Simpler than btn-mic: a call is always an explicit on/off action
  // (no "tap and hold to keep recording" ambiguity, no discard zone).
  // pointerdown is good enough; we don't need the gesture state machine.
  const btnCall = document.getElementById('btn-call') as HTMLButtonElement | null;
  if (btnCall) {
    btnCall.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      // If a mic-mode (memo / dictate) is currently active, tear it
      // down before opening the call so we don't have two voice paths
      // fighting for the mic. capture.ts's single-owner mutex would
      // catch this defensively but doing it here gives a cleaner
      // teardown sequence.
      const callOpen = webrtcControls.isOpen() || listenActive;
      if (callOpen) {
        // Tap on an active call → end it.
        log('[call] pointerdown — ending active call');
        void stopVoice();
        return;
      }
      // If mic-mode is running, stop it first (memo finalizes via send).
      if (voiceActive()) {
        log('[call] pointerdown — pre-empting active mic mode before call');
        void stopVoice();
      }
      log('[call] pointerdown — startCallMode');
      void startCallMode();
    });
    // Keyboard activation (Enter/Space).
    btnCall.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      const callOpen = webrtcControls.isOpen() || listenActive;
      if (callOpen) {
        void stopVoice();
      } else {
        if (voiceActive()) void stopVoice();
        void startCallMode();
      }
    });
  }

  /** Active-state visual on the call button. Reflects "user is in a
   *  CALL" — not just "WebRTC is connected." Dictation also opens
   *  the WebRTC peer (live STT to composer) but is mic-initiated, so
   *  webrtcControls.isOpen() being true during dictation would
   *  wrongly flip btn-call.active. Gate on dictateActive=false to
   *  exclude that case. */
  function syncCallButtonVisual(): void {
    if (!btnCall) return;
    const active = listenActive
      || (webrtcControls.isOpen() && !dictateActive);
    btnCall.classList.toggle('active', active);
  }
  /** Composer mic shows a stop glyph whenever some voice path is in
   *  flight, since the mic-tap dispatcher routes to stopVoice in that
   *  case (see pointerdown's "voiceActive defensive" branch). Without
   *  the swap the user sees a mic icon that actually ends the call. */
  function syncMicIcon(): void {
    const btn = document.getElementById('btn-mic');
    if (!btn) return;
    btn.classList.toggle('voice-active', voiceActive());
  }
  // Sync on every settings flip + every voice-state transition we know
  // about. Enough coverage: webrtcControls open/close fires through
  // controls.ts; listenActive flips through startListen/stopListen.
  // Hooking those would be cleaner but the polling here is cheap.
  const syncVoiceButtonVisuals = () => { syncCallButtonVisual(); syncMicIcon(); };
  setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    syncVoiceButtonVisuals();
  }, 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncVoiceButtonVisuals();
  });
  syncVoiceButtonVisuals();

  // ── Mic + Call mode chevron menus (per-button toggle rows) ─────────
  // Two independent menus. State persists in settings; reads on every
  // dispatch, writes on every flip. No teardown needed.
  //
  //   #mic-mode-menu  (right of composer): Auto-send + Streaming
  //   #call-mode-menu (left of composer):  Realtime + Speak-replies
  //
  // Both menus share the .mic-toggle-row + .mic-mode-menu CSS rules; the
  // anchoring (left vs. right) is the only visual difference, handled
  // by the .call-mode-menu rule in app.css.
  // Mic button has no menu anymore — tap=dictate, hold=PTT-memo gesture
  // replaces the streaming + autoSend toggles. The mic-mode-menu DOM was
  // dropped in the same commit. Call button keeps its menu (Realtime +
  // Speak-replies).
  const btnCallMode = document.getElementById('btn-call-mode') as HTMLButtonElement | null;
  const callModeMenu = document.getElementById('call-mode-menu') as HTMLElement | null;
  const callModeWrap = document.querySelector('.call-mode-wrap') as HTMLElement | null;
  // Mic button regained a chevron menu (2026-06-03) holding its one
  // preference: dictateRealtime. Same .mic-toggle-row machinery as the
  // call menu, anchored right (see .mic-mode-menu in app.css).
  const btnMicMode = document.getElementById('btn-mic-mode') as HTMLButtonElement | null;
  const micModeMenu = document.getElementById('mic-mode-menu') as HTMLElement | null;
  const micModeWrap = document.querySelector('.mic-mode-wrap') as HTMLElement | null;

  type CallToggleKey = 'realtime' | 'tts' | 'dictateRealtime';

  // Hover-capable, fine-pointer devices (desktop, laptop, iPad+trackpad)
  // get .title tooltips on hover; touch-only devices (iPhone, iPad bare)
  // don't, because iOS treats title as a long-press tooltip preview that
  // fights with PTT gestures (see ae8eb88). aria-label is set
  // unconditionally for screen readers.
  const isHoverDevice = typeof window !== 'undefined'
    && window.matchMedia?.('(hover: hover) and (pointer: fine)').matches === true;

  function setTooltip(el: Element | null, text: string): void {
    if (!el) return;
    el.setAttribute('aria-label', text);
    if (isHoverDevice) el.setAttribute('title', text);
  }

  function tooltipForCallToggle(key: CallToggleKey): string {
    if (key === 'realtime')
      return 'Realtime: ON = WebRTC duplex audio (low latency, lossy on flaky networks). OFF (default) = turn-based recording (full fidelity, sent on end-of-utterance).';
    if (key === 'dictateRealtime')
      return 'Realtime dictation: ON (default) = live transcript into the composer as you speak. OFF = record the whole utterance, transcribe once on stop, drop the clean text in the composer without auto-send (better long-form punctuation).';
    return 'Speak replies — TTS audio output during a call (talk mode vs. stream mode)';
  }

  function applyMenuRows(menu: HTMLElement | null, s: any): void {
    if (!menu) return;
    menu.querySelectorAll<HTMLButtonElement>('button.mic-toggle-row').forEach(b => {
      const key = b.dataset.toggle as CallToggleKey | undefined;
      if (!key) return;
      const on = !!s[key];
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.classList.toggle('on', on);
      setTooltip(b, tooltipForCallToggle(key));
    });
  }

  function applyMicModeUi(): void {
    const s = settings.get() as any;
    // Realtime + streamingEngine are conceptually one knob from the
    // user's perspective: "do you want WebRTC or turn-based." The
    // call-mode menu shows the Realtime toggle unconditionally; the
    // engine pairing is an implementation detail handled in the
    // toggle handler (flipping Realtime ON auto-flips streamingEngine
    // away from local). Reverse coupling NOT applied — the user can
    // still keep streamingEngine=server AND turn-based mode (real
    // bridge, full-fidelity recording) by leaving Realtime OFF.
    applyMenuRows(callModeMenu, s);
    applyMenuRows(micModeMenu, s);
    if (callModeWrap) {
      callModeWrap.dataset.mode = s.realtime ? 'realtime' : 'turn-based';
    }
    if (micModeWrap) {
      micModeWrap.dataset.mode = s.dictateRealtime ? 'dictate' : 'memo';
    }
    // Dynamic call-button tooltip — only meaningful on hover devices
    // (setTooltip skips title= on touch). Includes the configured
    // toggle-call hotkey so desktop users see "⌘⇧C" and any rebind
    // surfaces here on next applyMicModeUi() trigger.
    const btnCallEl = document.getElementById('btn-call');
    if (btnCallEl) {
      const what = s.realtime
        ? (s.tts ? 'WebRTC call (talk mode)' : 'WebRTC call (stream mode)')
        : 'turn-based call (Listen)';
      const callHk = formatHotkey(s.hotkeyToggleCall || '');
      setTooltip(btnCallEl, callHk
        ? `Tap to start — ${what}  ·  ${callHk}`
        : `Tap to start — ${what}`);
    }
    // btn-mic tooltip is static in index.html ("Tap = dictate, hold =
    // memo  ·  ⌘⇧D"). Override here so user-rebound hotkeys surface
    // correctly. Same hover-only gating as btn-call.
    const btnMicEl = document.getElementById('btn-mic');
    if (btnMicEl) {
      const micHk = formatHotkey(s.hotkeyToggleMic || '');
      setTooltip(btnMicEl, micHk
        ? `Tap = dictate, hold = memo  ·  ${micHk}`
        : 'Tap = dictate, hold = memo');
    }
    // sb-new-chat tooltip — hotkey hint for Cmd+Shift+O. Hardcoded for
    // now (not yet a user-bindable setting; matches the hardcoded
    // branch in the global hotkey handler below).
    const btnNewChatEl = document.getElementById('sb-new-chat');
    if (btnNewChatEl) {
      setTooltip(btnNewChatEl, `New chat  ·  ${formatHotkey('Cmd+Shift+O')}`);
    }
    // Pin-drawer toggle tooltips — desktop rail variant + mobile
    // toolbar variant. Hardcoded Cmd+Shift+P, mirrors the matching
    // branch in the global hotkey handler. Mobile suppresses titles
    // via util/mobileTooltips.ts anyway so the toolbar setTooltip is
    // mostly belt-and-suspenders for tablet/landscape edge cases.
    const pinHotkeyLabel = `Pinned messages  ·  ${formatHotkey('Cmd+Shift+P')}`;
    for (const id of ['btn-pin-drawer-rail', 'btn-pin-drawer']) {
      const el = document.getElementById(id);
      if (el) setTooltip(el, pinHotkeyLabel);
    }
    const activityHotkeyLabel = 'Activity  ·  ' + formatHotkey('Cmd+Shift+A');
    for (const id of ['btn-activity-drawer-rail', 'btn-activity-drawer']) {
      const el = document.getElementById(id);
      if (el) setTooltip(el, activityHotkeyLabel);
    }
    // Sidebar toggle gets its existing Cmd+Shift+S hint here too so
    // we don't have a tooltip-symmetry gap between the two drawers.
    const sbToggleEl = document.getElementById('sb-toggle');
    if (sbToggleEl) {
      setTooltip(sbToggleEl, `Toggle sessions  ·  ${formatHotkey('Cmd+Shift+S')}`);
    }
  }
  applyMicModeUi();
  // Hotkey rebinds in the settings panel should refresh tooltips. Fire
  // applyMicModeUi via a custom event from settings.ts (close handler
  // dispatches it so any saved hotkey changes propagate).
  window.addEventListener('parley:hotkeys-changed', () => applyMicModeUi());
  // Engine flip (set-streaming-engine select in the Settings panel)
  // → re-render mic/call UI so btn-call hide/show keeps up live.
  window.addEventListener('parley:engine-changed', () => applyMicModeUi());

  // ── Barge slider (call-mode menu) ──────────────────────────────────
  // Single slider 0..100 that folds the bargeIn boolean into its
  // leftmost position (0 = OFF). Replaces the prior settings-panel
  // checkbox + slider pair. iOS speakerphone hides the row entirely
  // because barge is acoustically impossible there (no AEC against
  // <audio>-element TTS playing through the same physical device).
  // See audio/shared/headphones.ts for the routing detector.
  {
    const slider = document.getElementById('call-mode-barge-slider') as HTMLInputElement | null;
    const valEl = document.getElementById('call-mode-barge-val');
    const row = document.getElementById('call-mode-barge-row');
    function readSettingsToSlider(): void {
      if (!slider || !valEl) return;
      const s = settings.get() as any;
      const sens = s.bargeIn
        ? settings.vadThresholdToSensitivity(s.bargeVadThreshold)
        : 0;
      slider.value = String(sens);
      valEl.textContent = sens === 0 ? 'Off' : `${sens}%`;
    }
    function writeSliderToSettings(): void {
      if (!slider || !valEl) return;
      const sens = Number(slider.value);
      valEl.textContent = sens === 0 ? 'Off' : `${sens}%`;
      if (sens === 0) {
        // Kill switch — bargeIn=false skips detector creation AND
        // VAD asset prefetch entirely (see prefetch site below).
        void settings.set('bargeIn', false);
      } else {
        void settings.set('bargeIn', true);
        void settings.set('bargeVadThreshold' as any, settings.sensitivityToVadThreshold(sens));
      }
    }
    slider?.addEventListener('input', writeSliderToSettings);
    readSettingsToSlider();
    // Hide the slider row whenever barge is physically unavailable —
    // SSOT lives in headphones.isBargeAvailable() so future callers
    // (settings hints, tap-to-interrupt fallback decision, etc.)
    // read from the same function and stay in sync.
    function applyBargeRowVisibility(): void {
      if (!row) return;
      const s = settings.get() as any;
      const mode = s.realtime ? 'realtime' : 'turnbased';
      const { available } = headphones.isBargeAvailable(mode);
      row.hidden = !available;
    }
    headphones.onChange(() => applyBargeRowVisibility());
    window.addEventListener('parley:settings-changed', () => {
      readSettingsToSlider();
      applyBargeRowVisibility();
    });
    applyBargeRowVisibility();
  }

  // ── VAD source override (call-mode menu) ────────────────────────────
  // Three buttons (Auto / Client / Bridge) that pin the VAD strategy.
  // Auto defers to chooseVadStrategy() (default: bridge). Backed by
  // localStorage (parley_vad_override) so it survives PWA reloads —
  // the URL ?vad= override is unreachable inside an installed PWA
  // (browser caches the entry URL).
  //
  // Dev-mode-only: the row is testing scaffolding for VAD experiments,
  // not user-facing config. Hide unless dev mode is on so non-dev
  // users don't see a confusing "VAD source: Auto / Client / Bridge"
  // toggle in the call menu.
  {
    const vadRow = document.getElementById('call-mode-vad-row');
    if (vadRow) {
      const showVadRow = isDevMode();
      vadRow.hidden = !showVadRow;
    }
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.mic-vad-option'),
    );
    function refresh(): void {
      const cur = vadRouting.getVadStrategyOverrideSetting();
      for (const btn of buttons) {
        const opt = btn.dataset.vadOption;
        btn.setAttribute('aria-checked', String(opt === cur));
      }
    }
    for (const btn of buttons) {
      btn.addEventListener('click', () => {
        const opt = btn.dataset.vadOption as 'auto' | 'client' | 'bridge';
        vadRouting.setVadStrategyOverrideSetting(opt);
        refresh();
        // Note: takes effect on the NEXT call open. Active calls keep
        // their VadSource — cycling the call (close + reopen) picks up
        // the new strategy. We don't hot-swap here because BargeDetector
        // owns its source's lifecycle and a mid-call swap would race.
      });
    }
    refresh();
  }

  // Mirror static composer aria-label → title for hover devices. iOS
  // touch path keeps title-less buttons (no long-press tooltip popup).
  if (isHoverDevice) {
    for (const id of ['btn-mic', 'btn-call-mode', 'btn-mic-mode']) {
      const el = document.getElementById(id);
      const label = el?.getAttribute('aria-label');
      if (el && label) el.setAttribute('title', label);
    }
  }

  // Single source of truth for "flip a mic / call menu toggle" — used by
  // BOTH the menu-click handlers AND the global hotkey handler. Reads
  // the POST-flip value via settings.get() after set() so the status
  // pill text doesn't drift from the menu visuals (visuals re-read
  // live state via applyMicModeUi).
  function flipMicSetting(key: CallToggleKey): void {
    const cur = !!(settings.get() as any)[key];
    const next = !cur;
    settings.set(key, next);
    // Flipping Realtime ON requires the WebRTC bridge — coerce
    // streamingEngine away from 'local' so the toggle is meaningful
    // immediately. One-way coupling: turning Realtime OFF leaves the
    // engine alone (user may still want server-engine turn-based,
    // which is a valid combination).
    if (key === 'realtime' && next) {
      const engine = (settings.get() as any).streamingEngine;
      if (engine === 'local') settings.set('streamingEngine', 'server');
    }
    applyMicModeUi();
    const label = key === 'realtime' ? 'Realtime'
      : key === 'dictateRealtime' ? 'Realtime dictation'
      : 'Speak replies';
    const live = !!(settings.get() as any)[key];
    status.setStatus(`${label}: ${live ? 'on' : 'off'}`, null);
    // Flipping `realtime` ON while a turn-based Listen session is
    // armed should disarm — the user's intent ("switch to realtime")
    // outweighs leaving the local recorder running.
    if (key === 'realtime' && next && listenActive) {
      stopListen();
    }
    // Toggling speak-replies OFF stops any in-flight text-mode TTS so
    // the user gets immediate silence (otherwise an active mp3 keeps
    // playing through to its end).
    if (key === 'tts' && !next) cancelReplyTts();
    // Speak-replies flip during an OPEN call cycles the WebRTC connection
    // into the new mode (talk = TTS audio; stream = STT only) so the user
    // sees the change immediately rather than "next call only". Brief
    // gap is acceptable — if it becomes annoying we can wait-for-flush.
    if (key === 'tts' && webrtcControls.isOpen()) {
      const newMode: 'talk' | 'stream' = next ? 'talk' : 'stream';
      void (async () => {
        try {
          await webrtcControls.closeIfOpen('tts-mode-flip');
          await webrtcControls.openCall(newMode);
        } catch (e: any) {
          diag('tts-flip mode swap failed', e?.message);
        }
      })();
    }
  }

  function setMenuOpen(menu: HTMLElement | null, btn: HTMLButtonElement | null, open: boolean): void {
    if (!menu || !btn) return;
    if (open) {
      menu.removeAttribute('hidden');
      menu.setAttribute('aria-hidden', 'false');
      btn.setAttribute('aria-expanded', 'true');
    } else {
      menu.setAttribute('hidden', '');
      menu.setAttribute('aria-hidden', 'true');
      btn.setAttribute('aria-expanded', 'false');
    }
  }

  function wireMenu(
    btn: HTMLButtonElement | null,
    menu: HTMLElement | null,
    wrap: HTMLElement | null,
  ): void {
    if (!btn || !menu) return;
    btn.onclick = (e) => {
      e.stopPropagation();
      const open = btn.getAttribute('aria-expanded') === 'true';
      setMenuOpen(menu, btn, !open);
    };
    menu.querySelectorAll<HTMLButtonElement>('button.mic-toggle-row').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        const key = b.dataset.toggle as CallToggleKey | undefined;
        if (!key) return;
        // Single canonical path — same as the hotkey. flipMicSetting
        // updates the setting, refreshes menu visuals, sets the status
        // pill text from the post-flip value, and runs side effects.
        // Menu stays open so the user can flip multiple toggles in one
        // pass (iOS Control Center pattern); tap outside to close.
        flipMicSetting(key);
      };
    });
    // Click outside closes the menu (capture so chat-bubble handlers
    // that stopPropagation can't strand us with a stuck-open menu).
    document.addEventListener('click', (e) => {
      if (menu.hasAttribute('hidden')) return;
      const t = e.target as Node;
      if (wrap && wrap.contains(t)) return;
      setMenuOpen(menu, btn, false);
    }, true);
  }
  wireMenu(btnCallMode, callModeMenu, callModeWrap);
  wireMenu(btnMicMode, micModeMenu, micModeWrap);

  // Send-button intercept — when dictate is active, clicking Send (or
  // pressing Enter to fire it) should send whatever's in the composer
  // AND close the dictate stream. Capture phase so we run alongside
  // sendTypedMessage rather than racing it.
  composerSend.addEventListener('click', () => {
    if (dictateActive) void stopDictate();
  }, true);

  // Esc ends any active voice mode — dictate / Listen / WebRTC call.
  // Matches the memo Esc-cancel UX (memo has its own handler that
  // fires only when recording). Priority order matches the natural
  // "innermost active mode" the user is most likely trying to exit.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (dictateActive) {
      e.preventDefault();
      void stopDictate();
      return;
    }
    if (listenActive) {
      e.preventDefault();
      stopListen();
      return;
    }
    if (webrtcControls.isOpen()) {
      e.preventDefault();
      void webrtcControls.closeIfOpen('esc-key');
      return;
    }
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
      // Shift-combos, plus bare ⌘/Ctrl+digit for the doc tabs: those
      // dropped Shift because ⌘⇧3/4/5 are macOS SYSTEM screenshot
      // shortcuts — the OS consumes them before the browser ever sees
      // the keydown, so tabs 3–5 could never fire (his catch,
      // 2026-08-26). Without widening this gate, ⌘1 from inside the
      // composer would early-return here and the hotkey would be dead
      // exactly where he types.
      const isShortcut = (e.metaKey || e.ctrlKey)
        && (e.shiftKey || /^Digit[0-9]$/.test(e.code));
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
        'bindings=', { call: (s as any).hotkeyToggleCall, mic: s.hotkeyToggleMic });
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
    // Doc tabs: ⌘⇧1…⌘⇧9 select the Nth rail doc tab (current VISUAL
    // order, 1 = top — browser tab semantics; a drag-reorder renumbers).
    // Matched on e.code, NOT e.key: shift+digit mangles e.key layout-
    // dependently ('!' on US, '+' on German), while Digit1…Digit9 name
    // the physical key regardless of layout. Alt excluded so option-
    // modified combos stay the browser's. Claim only on a hit — with no
    // doc at that position the keystroke keeps its browser meaning.
    // Doc tabs: the stored hotkeyDocTabs combo carries ONE example digit
    // ('Cmd+1'); its digit is stripped and the MODIFIERS apply to every
    // Digit1…Digit9 — configuring the prefix once instead of nine
    // bindings. Default is bare ⌘/Ctrl (Chrome's tab idiom): Shift is
    // unusable because ⌘⇧3/4/5 are macOS SYSTEM screenshot shortcuts the
    // page never receives, so a shifted default silently loses tabs 3–5.
    // In an installed PWA / the CAP shell the digits reach us; in a
    // regular browser tab the browser wins — accepted trade. Same
    // meta/ctrl interchangeability as matches() above; empty setting =
    // disabled, matching the other hotkeys' Backspace-clear.
    if (/^Digit[0-9]$/.test(e.code)) {
      const combo = String((s as any).hotkeyDocTabs || '');
      const mods = combo.split('+').map(x => x.trim().toLowerCase()).filter(x => x && !/^\d$/.test(x));
      if (mods.length) {
        const needMeta = mods.includes('cmd') || mods.includes('meta');
        const needCtrl = mods.includes('ctrl');
        const needAlt = mods.includes('alt');
        const needShift = mods.includes('shift');
        const modifierOK =
          (needMeta ? (e.metaKey || e.ctrlKey) : !e.metaKey) &&
          (needCtrl ? (e.ctrlKey || e.metaKey) : (needMeta || !e.ctrlKey)) &&
          (needAlt ? e.altKey : !e.altKey) &&
          (needShift ? e.shiftKey : !e.shiftKey);
        if (modifierOK && (needMeta || needCtrl)) {
          // ⌘0 → All docs (his ask, 2026-08-26: "cmd+0 for going to all
          // docs") — completes the browser-tab idiom under the SAME
          // stored prefix as ⌘1…9 (no new setting key; a synced key
          // costs two places — settings.ts + frontend-config). Routes
          // through openAllDocs: the identical list-view aim + select
          // the Docs rail button click runs, with the tab hotkeys'
          // toggle parity (list in front → close). Browser ⌘0 is
          // zoom-reset — page-interceptable, same accepted trade as
          // ⌘1…9 (installed PWA/CAP are the primary surfaces). Claim
          // only on a hit — openAllDocs is false when the doc module
          // isn't registered (cached shell predating it).
          if (e.code === 'Digit0') {
            log('[hotkey] docList (0)');
            if (openAllDocs()) {
              claim();
              return;
            }
          } else {
            const idx = Number(e.code.slice(5)) - 1;
            log('[hotkey] docTab', idx + 1);
            if (selectDocTab(idx)) {
              claim();
              return;
            }
          }
        }
      }
    }
    // Focus moves. These are the two halves of the keyboard loop between
    // picking a session and replying in it; ArrowUp/Down already handle
    // the middle (sessionDrawer's document listener, active whenever
    // focus is outside a text field). Both fire from ANYWHERE including
    // inside a text field — that's the point of "focus the other thing".
    if (matches((s as any).hotkeyFocusComposer)) {
      claim();
      log('[hotkey] focusComposer');
      focusComposer();
      return;
    }
    if (matches((s as any).hotkeyFocusSessions)) {
      claim();
      log('[hotkey] focusSessions');
      sessionDrawer.focusList();
      return;
    }
    if (matches((s as any).hotkeyToggleCall)) {
      claim();
      // Hotkey toggles the CALL — start a call if none active, end any
      // active call (mirrors btn-call's tap behavior). Pre-empts mic
      // mode if running so the call gets a clean mic.
      const callOpen = webrtcControls.isOpen() || listenActive;
      log('[hotkey] toggleCall — callOpen=', callOpen);
      if (callOpen) {
        void stopVoice();
      } else {
        if (voiceActive()) void stopVoice();
        void startCallMode();
      }
      return;
    }
    // hotkeyAutoSend retired — micAutoSend setting was eliminated when
    // the mic-button gesture model replaced the streaming/autoSend
    // toggles (PTT memo always sends; tap dictation never auto-sends).
    // The setting key + hotkey are dropped silently; old user-bound
    // values stay in localStorage but are no longer wired anywhere.
    if (matches('Cmd+Shift+O')) {
      claim();
      // Hotkey route to the sidebar "New chat" button. Hardcoded
      // binding for now (not yet user-configurable); same body as
      // btnNewChat.onclick — synthesize a click so we don't duplicate
      // the long minting + rotation sequence.
      const btn = document.getElementById('sb-new-chat') as HTMLButtonElement | null;
      if (btn && !btn.disabled) btn.click();
      // Hotkey path is desktop-only — focusing the composer is the
      // natural next action so the user can start typing immediately
      // without a second click. Mouse-click path on the same button
      // deliberately does NOT auto-focus, since that would surface the
      // soft keyboard on mobile.
      composerInput.focus();
      return;
    }
    if (matches('Cmd+Shift+P')) {
      claim();
      // Toggle the right drawer on its Pins tab. The per-tab header
      // buttons were removed in the 2026-07-09 consolidation (these
      // hotkeys no-op'd against the dead ids until the CAP-rail
      // subagent flagged it) — the rail tab buttons are the stable
      // click targets on every breakpoint.
      const btn = document.getElementById('btn-pin-drawer-rail') as HTMLButtonElement | null;
      btn?.click();
      return;
    }
    if (matches('Cmd+Shift+A')) {
      claim();
      const btn = document.getElementById('btn-activity-drawer-rail') as HTMLButtonElement | null;
      btn?.click();
      return;
    }
    if (matches('Cmd+Shift+S')) {
      claim();
      // Toggle the left session sidebar. Visible toggle button id
      // differs by viewport (desktop = sb-toggle inside the rail,
      // mobile = sb-toggle-mobile in the toolbar) — both wire to the
      // same Drawer.toggle internally so either click works.
      const btn = (document.getElementById('sb-toggle')
        || document.getElementById('sb-toggle-mobile')) as HTMLButtonElement | null;
      btn?.click();
      return;
    }
    if (matches((s as any).hotkeyToggleMeeting)) {
      claim();
      // Toggle MEETING CAPTURE in the current session (meeting-polish
      // #25). Start/stop flip mirrors the header capture button; the
      // capture itself is app-global (survives session switches), so
      // "stop" needs no session context. Composes with Cmd+Shift+O:
      // new chat first, then this hotkey records INTO that fresh
      // session (start reads switchCtl.viewedId() at press time).
      log('[hotkey] toggleMeeting');
      hotkeyToggleMeetingCapture();
      return;
    }
    if (matches(s.hotkeyToggleMic)) {
      claim();
      // Toggle MIC specifically — startMicMode (memo/dictate). Not
      // btn.click() (the gesture machine listens to pointer events,
      // not clicks). The gesture machine's pointerdown handler has a
      // `if (voiceActive()) { stopVoice(); return; }` defensive branch
      // that auto-syncs state when the user next touches the mic.
      // Don't stop a call from this hotkey — calls have their own
      // dedicated hotkey (hotkeyToggleCall above).
      const micRunning = memoActive || dictateActive;
      log('[hotkey] toggleMic — micRunning=', micRunning);
      if (micRunning) {
        void stopVoice();
      } else {
        // Capture composer cursor BEFORE the rest of the hotkey path
        // (which may not shift focus, but reading at the gesture site
        // is the canonical pattern — same as the pointerdown handler).
        // If textarea was focused when the hotkey fired, this is the
        // user's caret; if focus was elsewhere, it's the last-known
        // selection state, which is still a reasonable insertion point.
        // Hotkey = TAP semantics (no press-and-hold variant).
        void startMicMode('tap', captureComposerCursor());
      }
      return;
    }
  }, true);

  // ── Refresh button ──
  // Forces a SW update check + WAITS for the new SW to install before
  // reloading. iOS PWA suspends the page aggressively, so the periodic
  // reg.update() polling rarely fires in practice — devices end up stuck
  // on an old cached SW indefinitely.
  //
  // Bug fix 2026-05-01: the previous version called `await reg.update()`
  // (which resolves on update CHECK initiated, NOT install complete),
  // then immediately tried `reg.waiting?.postMessage(SKIP_WAITING)` —
  // but `reg.waiting` is null at that point because the new SW is still
  // in `installing` state. Then `location.reload()` fired, the page
  // reloaded under the OLD SW, and the new install (if it succeeded at
  // all) didn't take over until a SECOND refresh click. With APP_SHELL
  // drift causing install to fail outright (cache.addAll atomic 404),
  // it never took over at all — PWA permanently stuck on the last
  // version with a clean install.
  //
  // New flow: update → wait for installing→installed → SKIP_WAITING →
  // wait for controllerchange (which reloads via the index.html listener)
  // → fall through to manual reload only if no update happened.
  const btnRefresh = document.getElementById('btn-refresh');
  if (btnRefresh) {
    btnRefresh.onclick = async () => {
      try { void webrtcControls.closeIfOpen('refresh-button'); } catch {}
      try { player.pause(); player.src = ''; player.load(); } catch {}

      // Run keyterms + settings rehydrate in parallel with the SW
      // update flow — independent work, no need to serialize.
      const sideEffects = Promise.all([
        (async () => {
          try {
            const km = await import('./keyterms.ts');
            await km.rehydrateFromSeed();
          } catch (err) {
            diag(`refresh: keyterms rehydrate failed: ${(err as Error)?.message ?? err}`);
          }
        })(),
        (async () => {
          try { await settings.reload(); }
          catch (err) {
            diag(`refresh: settings reload failed: ${(err as Error)?.message ?? err}`);
          }
        })(),
      ]);

      let willControllerChangeReload = false;
      try {
        const reg = await navigator.serviceWorker?.getRegistration();
        if (reg) {
          // Kick off update check. Resolves when the check completes —
          // a new worker (if any) is now in reg.installing.
          await reg.update();
          const newWorker = reg.installing || reg.waiting;
          if (newWorker && newWorker !== reg.active) {
            diag(`refresh: new SW detected, state=${newWorker.state}`);
            willControllerChangeReload = await waitForSwActivation(newWorker, 8000);
            if (!willControllerChangeReload) {
              diag('refresh: SW activation timed out — falling back to plain reload');
            }
          } else {
            diag('refresh: no new SW (already on latest)');
          }
        }
      } catch (err) {
        diag(`refresh: SW update failed: ${(err as Error)?.message ?? err}`);
      }

      await sideEffects;

      // If a SW activation is in flight, the index.html `controllerchange`
      // listener will reload us. Don't double-reload (causes a visible
      // flash). If no activation is happening, manual reload to pick up
      // keyterms / settings refresh.
      if (!willControllerChangeReload) {
        diag('refresh: location.reload()');
        location.reload();
      } else {
        diag('refresh: awaiting controllerchange auto-reload');
      }
    };
  }

  // SW passive-update detector — see swLifecycle.ts.
  initPassiveUpdateDetector();

  // Listen mode bootstrap — URL flag for headless smoke tests. Auto-arms
  // Listen on boot when ?listen=1 is present so the smoke can drive
  // synthetic frames in (?listen_mock_mic=1). The flag also accepts
  // ?silence_sec=N to compress the silence window for fast tests.
  try {
    const qs = new URLSearchParams(location.search);
    if (qs.get('listen') === '1') {
      const sec = Number(qs.get('silence_sec'));
      if (Number.isFinite(sec) && sec > 0) settings.set('silenceSec', sec);
      // Defer briefly so settings.load() + audio prime can settle.
      setTimeout(() => { void startListen(); }, 50);
    }
  } catch { /* noop */ }

  log('page loaded, UA:', navigator.userAgent);

  // Console-typeable nuclear reset for stuck SW updates — see
  // swLifecycle.ts. Exposes `__forceUpdate()` on window.
  installForceUpdateConsoleHook();

  // Background prefetch of the VAD assets so the first BargeDetector.start()
  // doesn't pay the ~14.7 MB download cost mid-tap.
  //
  // Tuning history:
  //   v0.426 (2026-05-04): 5s delay, 5 fetches in PARALLEL.
  //   v0.435 (2026-05-05): 30s delay, serialized one-at-a-time.
  //   v0.440 (2026-05-05): immediate fire + speechVad.start AWAITS the
  //     prefetch promise. Field repro on hostile network (Mac Chrome
  //     T-Mobile 5G ~78 KB/s effective): the 30s delay didn't help
  //     because the user clicks Call within seconds of page load,
  //     well before the prefetch starts. MicVAD.new fires its OWN
  //     fetch which the 15s watchdog cancels mid-download — cache
  //     never populates → every retry fails identically.
  //
  //     New design: prefetch starts at page-ready and exposes its
  //     completion promise on `window.__vadPrefetchPromise__`.
  //     speechVad.start awaits that promise BEFORE constructing
  //     MicVAD. On slow networks the user's first call waits for
  //     the cache to populate (could be 30-60s on really bad links)
  //     but subsequent calls hit the warm cache instantly. On fast
  //     networks the prefetch is well done before any click, no
  //     visible delay.
  //
  //   Fetch order: lib bundle FIRST (smallest + needed first), then
  //   model + worklet + ort runtime.
  const prefetchUrls = [
    '/build/vendor/vad-web.mjs',
    '/assets/vad/silero_vad_legacy.onnx',
    '/assets/vad/vad.worklet.bundle.min.js',
    '/assets/vad/ort-wasm-simd-threaded.mjs',
    '/assets/vad/ort-wasm-simd-threaded.wasm',
  ];
  // Skip the VAD prefetch entirely when barge is disabled. The slider
  // 0% position sets bargeIn=false and means "I do not want barge to
  // run at all" — no detector is constructed, so loading 14.7 MB of
  // Silero assets is pure waste. Save bandwidth + parse time.
  const bargeEnabled = !!(settings.get() as any).bargeIn;
  if (!bargeEnabled) {
    log('VAD prefetch: skipped — barge disabled (slider 0%)');
    (window as any).__vadPrefetchPromise__ = Promise.resolve();
  } else {
    (window as any).__vadPrefetchPromise__ = (async () => {
      const t0 = performance.now();
      for (const url of prefetchUrls) {
        try {
          const r = await fetch(url);
          await r.text();
        } catch { /* best-effort warm */ }
      }
      log(`VAD prefetch: ${prefetchUrls.length} assets sequentially warmed in ${Math.round(performance.now() - t0)}ms`);
    })();
    // Lib parse — small additional step after prefetch promise.
    (window as any).__vadPrefetchPromise__.then(async () => {
      try {
        const speechVad = await import('./audio/shared/speechVad/index.ts');
        const supported = await speechVad.isSupported();
        log(`VAD prefetch: lib parsed, supported=${supported}`);
      } catch (e: any) {
        log(`VAD prefetch: lib import failed: ${e?.message}`);
      }
    });
  }
}

// ─── Session resume (drawer tap) ────────────────────────────────────────────

// ─── Session history backfill ────────────────────────────────────────────────

let historyLoaded = false;

async function backfillHistory() {
  if (historyLoaded) { diag('backfill: skip (already loaded)'); return; }
  historyLoaded = true;
  // The transcriptStore + projection + reconciler pipeline is the
  // canonical render path — it populates the chat on resume() / drawer
  // click, so direct backfill appends would be duplicate work. Retained
  // as a one-shot guard so callers can await it without side effects.
  diag('backfill: skip (store path is canonical)');
}

// ─── Go ─────────────────────────────────────────────────────────────────────

boot().catch(err => {
  console.error('Parley boot failed:', err);
  document.body.textContent = `Boot error: ${err.message}`;
});
