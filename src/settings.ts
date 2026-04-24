/**
 * @fileoverview Settings — persist, hydrate, apply. One source of truth.
 */

import * as backend from './backend.ts';

const STORAGE_KEY = 'sidekick.settings.v2';

// Model state — tracked separately from user settings (lives in openclaw
// config on the gateway, not in localStorage). Re-fetched on panel open
// and on a background poll so CLI-side changes reflect in the UI.
const modelState = {
  /** @type {string|null} */   current: null,
  /** @type {Array<Object>}  */ catalog: [],
};

type ModelHandlers = {
  onModelChange?: (ref: string, catalog: Object[], opts?: { silent?: boolean }) => void;
  reloadKeyterms?: () => void;
};
let modelHandlers: ModelHandlers = {};
let modelPollTimer: ReturnType<typeof setInterval> | null = null;

export function getCurrentModel() { return modelState.current; }
export function getModelCatalog() { return modelState.catalog; }
export function getCurrentModelEntry() {
  return modelState.catalog.find(e => e.id === modelState.current) || null;
}
/** Force a model-state refresh (e.g. after gateway reconnect). */
export function refreshModels() { return refreshModelState(); }

async function refreshModelState() {
  const [catalog, current] = await Promise.all([
    backend.listModels(),
    backend.getCurrentModel(),
  ]);

  // Empty catalog usually means the gateway wasn't ready — don't clobber the
  // existing dropdown (HTML default "Loading…" or previously-populated list).
  if (catalog.length === 0) return;

  const wasInitial = modelState.current === null;
  const changed = current && current !== modelState.current;
  modelState.catalog = catalog;
  if (current) modelState.current = current;

  const sel = document.getElementById('set-model') as HTMLSelectElement | null;
  if (sel) {
    sel.innerHTML = '';
    // Placeholder for when the effective model can't be determined — better
    // to show blank than to lie. Kept at the top so the assignment below has
    // a valid fallback target when `current` is null.
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '— select model —';
    placeholder.disabled = true;
    sel.appendChild(placeholder);

    // Ensure the currently-active model is ALWAYS present in the dropdown,
    // even if it didn't survive the catalog's filter (e.g. hermes config
    // set something the openrouter feed dropped below the 64K context floor
    // or doesn't carry at all). Without this, `sel.value = current` would
    // silently fail and the picker would fall back to the placeholder.
    const catalogHas = (id: string) => catalog.some((e: any) => e.id === id);
    const extras: any[] = [];
    if (current && !catalogHas(current)) {
      extras.push({ id: current, name: current, group: 'preferred' });
    }

    // Partition into groups so preferred models surface first. Entries
    // without a `group` field (backends that don't tag — e.g. openclaw)
    // fall into `other` and render flat (no optgroup).
    const preferred = [...extras, ...catalog.filter((e: any) => e.group === 'preferred')];
    const other = catalog.filter((e: any) => e.group !== 'preferred');

    const appendOption = (parent: Element, entry: any) => {
      const opt = document.createElement('option');
      opt.value = entry.id;
      opt.textContent = (entry.name || entry.id).replace(/^openrouter\//, '');
      parent.appendChild(opt);
    };

    if (preferred.length > 0) {
      // Curated filter is active — show only the preferred set. Widening
      // the picker is a server-side concern (edit SIDEKICK_PREFERRED_MODELS
      // or clear it to get the full catalog back), not a per-user toggle.
      for (const entry of preferred) appendOption(sel, entry);
    } else {
      // No preferred config (or catalog came back flat) → render the full
      // catalog. This covers backends that don't tag groups (e.g. openclaw).
      for (const entry of other) appendOption(sel, entry);
    }

    // `current` should now match exactly one <option> (either a catalog
    // entry, an injected extra, or — if null — the placeholder).
    sel.value = modelState.current || '';
  }

  if (changed && modelHandlers.onModelChange) {
    // Pass `silent` flag for the initial discovery so main.ts can gate the
    // attachment buttons without emitting a "Model: X" chat line on load.
    modelHandlers.onModelChange(modelState.current, catalog, { silent: wasInitial });
  }
}

function startModelPoll() {
  if (modelPollTimer) return;
  // 30s — cheap: config.get is a file-read. Catches CLI-side changes.
  modelPollTimer = setInterval(() => { refreshModelState().catch(() => {}); }, 30_000);
}

const DEFAULTS = {
  tts: false,          // TTS output off by default; user enables via Speaking toolbar button
  autoSend: true,      // auto-send voice transcripts when speaking is on
  voice: 'aura-2-thalia-en',
  micDevice: '',            // audio input device ID ('' = system default)
  streamingEngine: 'server', // 'server' (Deepgram) or 'local' (Web Speech only)
  // When on, a Deepgram stall / disconnect switches STT to Web Speech so
  // the user keeps getting transcripts. Default on: without it, any DG
  // connectivity issue leaves streaming silently dead. Users who strongly
  // prefer DG accuracy over degraded-but-live can toggle off in settings.
  autoFallback: true,
  ttsEngine: 'server',       // 'server' (Deepgram Aura /tts) or 'local' (Web Speech synthesis)
  ttsVoiceLocal: '',         // Web Speech voice name (empty = system default)
  dictationAutoSend: true,   // send on stop, or put in composer to edit
  wakeLock: true,
  commitPhrase: 'over',   // empty = commit-word disabled
  commitDelaySec: 1.5,
  silenceSec: 8,
  bargeIn: true,
  // Voice nav keywords — matched as a whole utterance at end-of-final,
  // short-circuited BEFORE draft append so they don't ship as messages.
  // Pipe-separated alternates allowed per field (`previous chat|back chat`).
  // Empty = disable that command. Keep the word "chat" (or your own
  // trailing anchor) as a safety to avoid collisions with normal speech.
  navPrev: 'previous chat',
  navNext: 'next chat',
  navPause: 'pause chat',
  // Reply playback order. When false (FIFO — default), new agent
  // replies queue if one is currently playing; current finishes then
  // the queued one plays. When true, new replies interrupt the
  // current one (classic auto-skip — older behavior). The 'receive'
  // chime fires on arrival either way; use voice "next chat" or the
  // pocket-lock button to advance manually when queued.
  autoAdvanceOnNew: false,
  // Threshold on per-frame mic peak (0..1). Higher = less sensitive. The
  // UI shows the inverse (sensitivity %) where 100% ≈ threshold 0.0 and
  // 0% ≈ threshold 0.50; see settings.ts slider wiring for the mapping.
  bargeThreshold: 0.20,
  contentSize: 15,
  // Click volume for send/receive feedback. 0..1; 0 = silent. 0.5 matches
  // the original "subtle" level, 1.0 is ~2x louder for noisy environments
  // (e.g. bike rides). Mapped linearly to gain multiplier in feedback.ts.
  audioFeedbackVolume: 0.5,
  theme: 'dark',
  // Session drawer filter — passed as `?prefix=` to /api/hermes/sessions.
  // Supports comma-separated glob patterns (e.g. 'sidekick-*,work-*');
  // '*' converts to SQL LIKE '%' on the server. Sessions whose source
  // isn't webchat (telegram, cli) always use the raw UUID as id, so the
  // filter only restricts webchat rows — telegram always shows.
  sessionsFilter: 'sidekick-*',
};

let current = { ...DEFAULTS };

// Barge-in sensitivity ↔ threshold mapping. The user-facing slider is a
// "sensitivity %" (higher = more sensitive, matches the label). Under the
// hood we store a peak threshold (0..1; higher = requires louder sound).
// Linear mapping: 100% ↔ threshold 0.0, 0% ↔ threshold 0.5.
const BARGE_MAX_THRESHOLD = 0.5;
function sensitivityToThreshold(sens) {
  const clamped = Math.max(0, Math.min(100, sens));
  return +((100 - clamped) / 100 * BARGE_MAX_THRESHOLD).toFixed(3);
}
function thresholdToSensitivity(thr) {
  const clamped = Math.max(0, Math.min(BARGE_MAX_THRESHOLD, thr));
  return Math.round((1 - clamped / BARGE_MAX_THRESHOLD) * 100);
}

function audioFeedbackLabel(vol) {
  return vol <= 0 ? 'Off' : `${Math.round(vol * 100)}%`;
}

export function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) current = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {}
  return current;
}

export function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(current)); } catch {}
}

/** @returns {Readonly<typeof DEFAULTS>} */
export function get() { return current; }

export function set(key: string, value: any) {
  (current as any)[key] = value;
  save();
}

/** Apply visual settings that need immediate DOM effects. */
export function applyVisuals() {
  document.documentElement.style.setProperty('--content-size', current.contentSize + 'px');
}

/**
 * Hydrate all settings controls from current values + wire change handlers.
 * @param {Object} handlers — { onThemeChange, onVoiceChange, onWakeLockChange, onSave, onModelChange }
 */
export function hydrate(handlers: {
  onThemeChange?: () => void;
  onVoiceChange?: () => void;
  onWakeLockChange?: () => void;
  onSave?: () => void;
  onModelChange?: (ref: string, catalog: Object[], opts?: { silent?: boolean }) => void;
  onMicChange?: () => void;
  onStreamingEngineChange?: () => void;
  onAutoSendChange?: () => void;
  onSessionsFilterChange?: () => void;
} = {}) {
  modelHandlers = { onModelChange: handlers.onModelChange };
  const $inp = (id: string) => document.getElementById(id) as HTMLInputElement | null;
  const $sel = (id: string) => document.getElementById(id) as HTMLSelectElement | null;
  const $any = (id: string) => document.getElementById(id);

  const setMic = $sel('set-mic');
  const setStreamEngine = $sel('set-streaming-engine');
  const setAutoFallback = $inp('set-auto-fallback');
  const setSttKeyterms = document.getElementById('set-stt-keyterms') as HTMLTextAreaElement | null;
  const setSessionsFilter = $inp('set-sessions-filter');
  const setTtsEngine = $sel('set-tts-engine');
  const setDictAutoSend = $inp('set-dictation-autosend');
  const setVoice = $sel('set-voice');
  const setWake = $inp('set-wake');
  const setCommitPhrase = $inp('set-commit-phrase');
  const setCommitDelay = $inp('set-commit-delay');
  const setCommitDelayVal = $any('set-commit-delay-val');
  const setSilence = $inp('set-silence');
  const setSilenceVal = $any('set-silence-val');
  const setNavPrev = $inp('set-nav-prev');
  const setNavNext = $inp('set-nav-next');
  const setNavPause = $inp('set-nav-pause');
  const setBarge = $inp('set-barge');
  const setBargeSens = $inp('set-barge-sens');
  const setBargeSensVal = $any('set-barge-sens-val');
  const setAudioFeedback = $inp('set-audio-feedback');
  const setAudioFeedbackVal = $any('set-audio-feedback-val');
  const setFontSize = $inp('set-fontsize');
  const setFontSizeVal = $any('set-fontsize-val');
  const setTheme = $sel('set-theme');

  // Initial values
  if (setStreamEngine) setStreamEngine.value = current.streamingEngine;
  if (setAutoFallback) setAutoFallback.checked = current.autoFallback;
  if (setTtsEngine) setTtsEngine.value = current.ttsEngine;
  if (setDictAutoSend) setDictAutoSend.checked = current.dictationAutoSend;
  if (setAudioFeedback) setAudioFeedback.value = String(Math.round(current.audioFeedbackVolume * 100));
  if (setAudioFeedbackVal) setAudioFeedbackVal.textContent = audioFeedbackLabel(current.audioFeedbackVolume);
  if (setVoice) setVoice.value = current.voice;
  if (setWake) setWake.checked = current.wakeLock;
  if (setCommitPhrase) setCommitPhrase.value = current.commitPhrase;
  if (setCommitDelay) setCommitDelay.value = String(current.commitDelaySec);
  if (setCommitDelayVal) setCommitDelayVal.textContent = `${current.commitDelaySec}s`;
  if (setSilence) setSilence.value = String(current.silenceSec);
  if (setSilenceVal) setSilenceVal.textContent = current.silenceSec === 0 ? 'Off' : `${current.silenceSec}s`;
  if (setNavPrev) setNavPrev.value = current.navPrev;
  if (setNavNext) setNavNext.value = current.navNext;
  if (setNavPause) setNavPause.value = current.navPause;
  if (setBarge) setBarge.checked = current.bargeIn;
  // Sensitivity slider is the INVERSE of threshold. Map threshold 0..0.5 onto
  // slider 100..0 so "100%" = fire on any sound, "0%" = basically never.
  if (setBargeSens) setBargeSens.value = String(thresholdToSensitivity(current.bargeThreshold));
  if (setBargeSensVal) setBargeSensVal.textContent = `${thresholdToSensitivity(current.bargeThreshold)}%`;
  if (setFontSize) setFontSize.value = String(current.contentSize);
  if (setFontSizeVal) setFontSizeVal.textContent = `${current.contentSize}px`;
  if (setTheme) setTheme.value = current.theme;
  if (setSessionsFilter) setSessionsFilter.value = current.sessionsFilter;

  // Change handlers
  if (setStreamEngine) setStreamEngine.onchange = () => {
    set('streamingEngine', setStreamEngine.value);
    if (handlers.onStreamingEngineChange) handlers.onStreamingEngineChange();
  };
  if (setAutoFallback) setAutoFallback.onchange = () => { set('autoFallback', setAutoFallback.checked); };
  // Keyterms textarea is backed by apps/sidekick/keyterms.txt on the
  // server — edits save to disk. One source of truth, no localStorage
  // fork. Fetch on panel open; save on blur.
  if (setSttKeyterms) {
    async function loadKeyterms() {
      try {
        const { fetchWithTimeout } = await import('./util/fetchWithTimeout.ts');
        const r = await fetchWithTimeout('/api/keyterms', { timeoutMs: 5_000 });
        if (r.ok) setSttKeyterms.value = await r.text();
      } catch {}
    }
    async function saveKeyterms() {
      try {
        const { fetchWithTimeout } = await import('./util/fetchWithTimeout.ts');
        await fetchWithTimeout('/api/keyterms', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: setSttKeyterms.value,
          timeoutMs: 5_000,
        });
      } catch {}
    }
    loadKeyterms();
    setSttKeyterms.addEventListener('blur', saveKeyterms);
    // Expose a re-load hook so the settings-panel-open toggle can
    // refresh the view if someone edited the file directly on disk.
    modelHandlers.reloadKeyterms = loadKeyterms;
  }
  if (setSessionsFilter) {
    setSessionsFilter.addEventListener('change', () => {
      set('sessionsFilter', setSessionsFilter.value.trim() || 'sidekick-*');
      if (handlers.onSessionsFilterChange) handlers.onSessionsFilterChange();
    });
  }
  if (setTtsEngine) setTtsEngine.onchange = () => {
    set('ttsEngine', setTtsEngine.value);
    applyTtsEngineVisibility();
  };

  // Local TTS voice picker — populated from browser's speechSynthesis API.
  // Voice list often loads async, so we also listen on voiceschanged.
  const setTtsVoiceLocal = document.getElementById('set-tts-voice-local') as HTMLSelectElement | null;
  if (setTtsVoiceLocal) {
    setTtsVoiceLocal.onchange = () => { set('ttsVoiceLocal', setTtsVoiceLocal.value); };
    populateLocalVoices();
    if (typeof speechSynthesis !== 'undefined') {
      speechSynthesis.onvoiceschanged = () => populateLocalVoices();
    }
  }
  applyTtsEngineVisibility();

  function applyTtsEngineVisibility() {
    const isLocal = current.ttsEngine === 'local';
    const rowL = document.getElementById('row-tts-voice-local');
    const rowS = document.getElementById('row-tts-voice-server');
    if (rowL) rowL.style.display = isLocal ? '' : 'none';
    if (rowS) rowS.style.display = isLocal ? 'none' : '';
  }

  function populateLocalVoices() {
    if (typeof speechSynthesis === 'undefined' || !setTtsVoiceLocal) return;
    const voices = speechSynthesis.getVoices();
    if (!voices.length) return;  // wait for voiceschanged
    setTtsVoiceLocal.innerHTML = '';
    const defaultOpt = document.createElement('option');
    defaultOpt.value = ''; defaultOpt.textContent = 'System default';
    setTtsVoiceLocal.appendChild(defaultOpt);
    // Filter to the browser's primary language (usually English for our users).
    // Fall back to showing all if the filter would leave zero voices.
    const primaryLang = (navigator.language || 'en').split('-')[0].toLowerCase();
    let filtered = voices.filter(v => (v.lang || '').toLowerCase().startsWith(primaryLang));
    if (filtered.length === 0) filtered = voices;
    // Prefer localService voices (on-device, higher quality) at top.
    const local = filtered.filter(v => (v as any).localService);
    const remote = filtered.filter(v => !(v as any).localService);
    for (const v of [...local, ...remote]) {
      const opt = document.createElement('option');
      opt.value = v.name;
      opt.textContent = `${v.name} (${v.lang})`;
      setTtsVoiceLocal.appendChild(opt);
    }
    if (current.ttsVoiceLocal) setTtsVoiceLocal.value = current.ttsVoiceLocal;
  }
  if (setDictAutoSend) setDictAutoSend.onchange = () => { set('dictationAutoSend', setDictAutoSend.checked); };
  if (setMic) setMic.onchange = () => {
    set('micDevice', setMic.value);
    if (handlers.onMicChange) handlers.onMicChange();
  };
  if (setVoice) setVoice.onchange = () => {
    set('voice', setVoice.value);
    if (handlers.onVoiceChange) handlers.onVoiceChange();
  };
  if (setWake) setWake.onchange = () => {
    set('wakeLock', setWake.checked);
    if (handlers.onWakeLockChange) handlers.onWakeLockChange();
  };
  if (setCommitPhrase) setCommitPhrase.onchange = () => {
    // Empty string = commit-word disabled. Non-empty = that phrase.
    set('commitPhrase', setCommitPhrase.value.trim().toLowerCase());
  };
  if (setCommitDelay) setCommitDelay.oninput = () => {
    set('commitDelaySec', parseFloat(setCommitDelay.value));
    if (setCommitDelayVal) setCommitDelayVal.textContent = `${current.commitDelaySec}s`;
  };
  if (setSilence) setSilence.oninput = () => {
    const val = parseInt(setSilence.value, 10);
    set('silenceSec', val);
    set('autoSend', val > 0);
    if (setSilenceVal) setSilenceVal.textContent = val === 0 ? 'Off' : `${val}s`;
    if (handlers.onAutoSendChange) handlers.onAutoSendChange();
  };
  // Nav keyword strings — persisted on blur (text input is awkward
  // for per-keystroke saves). Empty = that command disabled; aliases
  // separated with "|" (e.g. "previous chat|back chat").
  if (setNavPrev) setNavPrev.onchange = () => { set('navPrev', setNavPrev.value.trim().toLowerCase()); };
  if (setNavNext) setNavNext.onchange = () => { set('navNext', setNavNext.value.trim().toLowerCase()); };
  if (setNavPause) setNavPause.onchange = () => { set('navPause', setNavPause.value.trim().toLowerCase()); };
  if (setBarge) setBarge.onchange = () => { set('bargeIn', setBarge.checked); };
  if (setAudioFeedback) setAudioFeedback.oninput = () => {
    const pct = parseInt(setAudioFeedback.value, 10);
    set('audioFeedbackVolume', pct / 100);
    if (setAudioFeedbackVal) setAudioFeedbackVal.textContent = audioFeedbackLabel(pct / 100);
  };
  if (setBargeSens) setBargeSens.oninput = () => {
    const sensitivity = parseInt(setBargeSens.value, 10);
    set('bargeThreshold', sensitivityToThreshold(sensitivity));
    if (setBargeSensVal) setBargeSensVal.textContent = `${sensitivity}%`;
  };
  if (setFontSize) setFontSize.oninput = () => {
    set('contentSize', parseInt(setFontSize.value, 10));
    if (setFontSizeVal) setFontSizeVal.textContent = `${current.contentSize}px`;
    applyVisuals();
  };
  if (setTheme) setTheme.onchange = () => {
    set('theme', setTheme.value);
    if (handlers.onThemeChange) handlers.onThemeChange();
  };

  // Settings panel toggle — button moved into the sidebar bottom (#sb-settings).
  // Panel is a modal overlay (same shape as #info-panel); close via X button,
  // Esc key, or backdrop click.
  const btnSet = $any('sb-settings');
  const panel = $any('settings');
  const openPanel = () => {
    if (!panel) return;
    panel.classList.add('on');
    refreshModelState();
    modelHandlers.reloadKeyterms?.();
  };
  const closePanel = () => { if (panel) panel.classList.remove('on'); };
  if (btnSet) btnSet.onclick = openPanel;
  const closeBtn = $any('settings-close');
  if (closeBtn) closeBtn.onclick = closePanel;
  if (panel) {
    // Clicking the backdrop (outside .settings-inner) closes.
    panel.addEventListener('click', (e: MouseEvent) => {
      if (e.target === panel) closePanel();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel && panel.classList.contains('on')) closePanel();
  });

  // Model selector: switch the session's active model via /model slash
  // command (same path as the CLI, updates sessionEntry.modelOverride).
  // Verifies via sessions.list afterward so we don't lie if the server
  // rejects the change.
  const setModel = $sel('set-model');
  if (setModel) {
    setModel.onchange = async () => {
      const newRef = setModel.value;
      if (!newRef) return;
      backend.setModel(newRef);
      // Optimistic UI update + immediate system line.
      const prev = modelState.current;
      modelState.current = newRef;
      if (modelHandlers.onModelChange) modelHandlers.onModelChange(newRef, modelState.catalog);
      // Verify after ~800ms (slash command processing); revert if rejected.
      setTimeout(async () => {
        const actual = await backend.getCurrentModel();
        if (actual && actual !== newRef) {
          modelState.current = actual;
          setModel.value = modelState.catalog.some(e => e.id === actual) ? actual : '';
          if (modelHandlers.onModelChange) modelHandlers.onModelChange(actual, modelState.catalog);
        }
      }, 1500);
    };
  }

  // Expand checkbox hit area to the entire row — clicking the label (handled
  // natively via `for=`) or the hint/padding (handled here) toggles the
  // checkbox. Skip when the click target is itself an interactive element
  // so the native label + inline inputs keep their own semantics.
  if (panel) {
    panel.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest('.row') as HTMLElement | null;
      if (!row) return;
      const cb = row.querySelector('input[type=checkbox]') as HTMLInputElement | null;
      if (!cb) return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'LABEL') return;
      cb.click();
    });
  }

  // Initial model state fetch + 30s poll for external (CLI) changes.
  refreshModelState().catch(() => {});
  startModelPoll();
}
