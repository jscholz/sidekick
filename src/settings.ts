/**
 * @fileoverview Settings — persist, hydrate, apply. One source of truth.
 */

import * as backend from './backend.ts';
import * as agentSettings from './agentSettings.ts';

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

/** Stable fingerprint of a catalog so we can skip the full DOM rebuild
 *  when polling returns the same data. The dropdown gets re-rendered
 *  from scratch otherwise — `sel.innerHTML = ''` collapses the element
 *  height, then the re-population grows it back. With the catalog
 *  endpoint polling every 30s plus the post-set-model verify storm
 *  during a gateway restart, the user sees a high-frequency vertical
 *  jitter as the panel re-flows. Fingerprinting kills that. */
function catalogFingerprint(entries: any[]): string {
  // id list is enough — names, modalities, group tags don't drive the
  // <option> set's STRUCTURE, only its content (and we re-set sel.value
  // anyway). Sort to absorb backend ordering instability.
  return entries.map(e => e.id).sort().join('|');
}
let lastRenderedFingerprint = '';

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
    // Catalog unchanged from the last render? Just update the selection
    // and bail — avoids the wipe-and-rebuild flicker on rapid polls.
    const fp = catalogFingerprint(catalog) + '|' + (current || '');
    if (fp === lastRenderedFingerprint) {
      sel.value = modelState.current || '';
      // Still fire onModelChange below if `current` flipped (e.g. the
      // post-set-model verify came back with a different model).
      if (changed && modelHandlers.onModelChange) {
        modelHandlers.onModelChange(modelState.current, catalog, { silent: wasInitial });
      }
      return;
    }
    lastRenderedFingerprint = fp;
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

// Built-in fallbacks. Two storage backends:
//
//   - Per-device keys (PER_DEVICE_KEYS below) — `micDevice`,
//     `ttsVoiceLocal` — stay in browser localStorage. Their values
//     are hardware-specific (mic device IDs differ Mac vs iPhone;
//     Web Speech voice names differ per OS) so they can't be
//     deployment-wide.
//   - Everything else lives in `sidekick.config.yaml` under
//     `frontend.<category>.<key>:`, served by GET /api/sidekick/config
//     and written by POST /api/sidekick/config/<key>. The proxy is
//     the source of truth; localStorage is no longer consulted for
//     these keys.
//
// The DEFAULTS object below is only used when:
//   1. The proxy-fetch fails (offline / 503 / unconfigured) — last-
//      resort fallback so the UI still renders.
//   2. A new key was added to the schema and existing yamls don't
//      have it yet.
//
// Keys + values match `proxy/sidekick/frontend-config.ts`'s
// FRONTEND_SETTINGS table. If you add a setting, add it to BOTH.
const DEFAULTS = {
  tts: false,
  autoSend: true,
  voice: 'aura-2-thalia-en',
  micDevice: '',
  streamingEngine: 'server',
  autoFallback: true,
  ttsEngine: 'server',
  ttsVoiceLocal: '',
  wakeLock: true,
  commitPhrase: 'over',
  commitDelaySec: 1.5,
  silenceSec: 15,
  bargeIn: true,
  navPrev: 'previous chat',
  navNext: 'next chat',
  navPause: 'pause chat',
  autoAdvanceOnNew: false,
  bargeThreshold: 0.20,
  contentSize: 15,
  audioFeedbackVolume: 0.5,
  theme: 'dark',
  micCall: false,
  micAutoSend: false,
  hotkeyCallMode: 'Cmd+Shift+C',
  hotkeyAutoSend: 'Cmd+Shift+S',
  hotkeyToggleMic: 'Cmd+Shift+D',
  agentActivity: 'summary' as 'off' | 'summary' | 'full',
};

/** Settings whose value is hardware-specific to the browser; stay
 *  in localStorage rather than yaml. Everything else is yaml-backed. */
const PER_DEVICE_KEYS = new Set<string>(['micDevice', 'ttsVoiceLocal']);

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

/** Pull the current snapshot from the server (yaml-backed values)
 *  and merge with localStorage (per-device values). Synchronous
 *  fallback if the fetch fails. Idempotent — call again on Refresh
 *  or after the user closes the panel. */
export async function load() {
  // Per-device first — these are guaranteed available even if the
  // proxy is unreachable.
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const stored = JSON.parse(raw) as Record<string, any>;
      for (const k of PER_DEVICE_KEYS) {
        if (Object.prototype.hasOwnProperty.call(stored, k)) {
          (current as any)[k] = stored[k];
        }
      }
    }
  } catch {}
  // Yaml-backed: fetch flat snapshot from the proxy. The proxy
  // returns built-in defaults for any key the yaml doesn't define
  // yet, so partial yamls work.
  try {
    const r = await fetch('/api/sidekick/config', { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json() as { settings?: Record<string, any> };
      if (j?.settings) {
        for (const [k, v] of Object.entries(j.settings)) {
          if (PER_DEVICE_KEYS.has(k)) continue;
          (current as any)[k] = v;
        }
      }
    }
  } catch {
    // Offline / proxy down — `current` keeps the DEFAULTS or last
    // server snapshot. The Refresh button will retry.
  }
  return current;
}

/** Re-fetch yaml-backed settings from the proxy. Same as load() but
 *  named for clarity in the Refresh-button call site. */
export async function reload() {
  return load();
}

// Cross-tab sync for per-device keys (the yaml-backed ones round-
// trip through the server, so other tabs see them on their own
// reload/refresh). Storage event fires only on the OTHER tab when
// localStorage changes here; we re-pull and broadcast.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return;
    void load().then(() => {
      window.dispatchEvent(new CustomEvent('sidekick:settings-changed'));
    });
  });
}

/** Persist per-device values to localStorage. Yaml-backed values
 *  ride through set() → POST and don't touch localStorage. */
export function save() {
  try {
    const slice: Record<string, any> = {};
    for (const k of PER_DEVICE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(current, k)) {
        slice[k] = (current as any)[k];
      }
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slice));
  } catch {}
}

/** @returns {Readonly<typeof DEFAULTS>} */
export function get() { return current; }

/** Update one setting. Per-device keys land in localStorage; all
 *  others POST to the proxy (which writes the yaml). The local
 *  cache updates synchronously regardless so call sites that read
 *  settings.get() right after set() see the new value. */
export function set(key: string, value: any) {
  (current as any)[key] = value;
  if (PER_DEVICE_KEYS.has(key)) {
    save();
    return;
  }
  // Fire-and-forget POST. On failure, leave the local cache as-is
  // (user sees their value); next reload() resyncs from yaml.
  void fetch(`/api/sidekick/config/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value }),
  }).then((r) => {
    if (!r.ok) {
      console.warn(`[settings] POST /api/sidekick/config/${key} failed: ${r.status}`);
    }
  }).catch((e) => {
    console.warn(`[settings] POST /api/sidekick/config/${key} threw:`, e);
  });
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
} = {}) {
  modelHandlers = { onModelChange: handlers.onModelChange };
  const $inp = (id: string) => document.getElementById(id) as HTMLInputElement | null;
  const $sel = (id: string) => document.getElementById(id) as HTMLSelectElement | null;
  const $any = (id: string) => document.getElementById(id);

  const setMic = $sel('set-mic');
  const setStreamEngine = $sel('set-streaming-engine');
  const setAutoFallback = $inp('set-auto-fallback');
  const setSttKeyterms = document.getElementById('set-stt-keyterms') as HTMLInputElement | null;
  const keytermsChips = document.getElementById('keyterms-chips');
  const setHotkeyCall = $inp('set-hotkey-call');
  const setHotkeyAutoSend = $inp('set-hotkey-autosend');
  const setHotkeyMic = $inp('set-hotkey-mic');
  const setTtsEngine = $sel('set-tts-engine');
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
  const setAgentActivity = $sel('set-agent-activity');

  // Apply `current` snapshot to every form control + label. Called
  // once at hydrate time and again on the cross-tab `sidekick:settings-
  // changed` event so two PWA tabs stay visibly in sync without reload.
  // Pure DOM writes — does NOT fire onchange handlers (the cross-tab
  // path's source of truth is `current`, already updated by load()).
  function applyToDOM() {
    if (setStreamEngine) setStreamEngine.value = current.streamingEngine;
    if (setAutoFallback) setAutoFallback.checked = current.autoFallback;
    if (setTtsEngine) setTtsEngine.value = current.ttsEngine;
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
    if (setAgentActivity) setAgentActivity.value = current.agentActivity;
    if (setHotkeyCall) setHotkeyCall.value = current.hotkeyCallMode;
    if (setHotkeyAutoSend) setHotkeyAutoSend.value = current.hotkeyAutoSend;
    if (setHotkeyMic) setHotkeyMic.value = current.hotkeyToggleMic;
  }
  applyToDOM();

  // Cross-tab sync: re-apply on `sidekick:settings-changed` so the
  // <select> / <input> elements catch up after another tab wrote to
  // localStorage. Also re-apply visual side-effects (theme handler,
  // font size CSS var, TTS engine row visibility) so the page LOOKS
  // consistent — not just the form controls. handlers.onThemeChange
  // is the canonical "make the theme stick" callback in main.ts.
  window.addEventListener('sidekick:settings-changed', () => {
    applyToDOM();
    applyVisuals();
    applyTtsEngineVisibility();
    if (handlers.onThemeChange) handlers.onThemeChange();
  });

  // Change handlers
  if (setStreamEngine) setStreamEngine.onchange = () => {
    set('streamingEngine', setStreamEngine.value);
    if (handlers.onStreamingEngineChange) handlers.onStreamingEngineChange();
  };
  if (setAutoFallback) setAutoFallback.onchange = () => { set('autoFallback', setAutoFallback.checked); };
  // Keyterms: chip-based input, persisted PER USER in IndexedDB
  // (src/keyterms.ts). On first boot the list seeds from
  // /api/keyterms (default_stt_keyterms.txt on the server); after
  // that, all reads/writes are local. Each chip is one keyterm —
  // Enter or comma commits, × on a chip removes.
  if (setSttKeyterms && keytermsChips) {
    let terms: string[] = [];
    const renderChips = () => {
      keytermsChips.innerHTML = '';
      for (const t of terms) {
        const chip = document.createElement('span');
        chip.className = 'kt-chip';
        chip.textContent = t;
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'kt-chip-x';
        x.setAttribute('aria-label', `remove ${t}`);
        x.textContent = '×';
        x.onclick = () => { terms = terms.filter(v => v !== t); renderChips(); saveKeyterms(); };
        chip.appendChild(x);
        keytermsChips.appendChild(chip);
      }
    };
    async function loadKeyterms() {
      const { loadOrSeed } = await import('./keyterms.ts');
      try {
        terms = await loadOrSeed();
        renderChips();
      } catch {}
    }
    async function saveKeyterms() {
      const { writeList } = await import('./keyterms.ts');
      try { await writeList(terms); } catch {}
    }
    const commit = () => {
      const t = setSttKeyterms.value.trim().replace(/,$/, '').trim();
      if (!t) { setSttKeyterms.value = ''; return; }
      if (!terms.some(v => v.toLowerCase() === t.toLowerCase())) {
        terms.push(t);
        renderChips();
        saveKeyterms();
      }
      setSttKeyterms.value = '';
    };
    setSttKeyterms.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
      else if (e.key === 'Backspace' && !setSttKeyterms.value && terms.length) {
        // Backspace on empty input removes the last chip (standard chip UX).
        terms.pop(); renderChips(); saveKeyterms();
      }
    });
    setSttKeyterms.addEventListener('blur', () => { if (setSttKeyterms.value.trim()) commit(); });
    loadKeyterms();
    modelHandlers.reloadKeyterms = loadKeyterms;
  }

  // (Legacy preferred-models chip wiring removed — agentSettings.ts
  // renders preferred_models as a `string-list` SettingDef declared
  // by the agent via /v1/settings/schema.)

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
  // Hotkey inputs — click-to-capture. Focus the field, press a key
  // combination, and we format it as a string and save. Cmd is used as
  // the conventional Mac modifier name; the matcher accepts either Cmd
  // (metaKey) or Ctrl (ctrlKey) at runtime.
  function attachHotkeyCapture(el: HTMLInputElement | null, settingsKey: 'hotkeyCallMode' | 'hotkeyAutoSend' | 'hotkeyToggleMic') {
    if (!el) return;
    el.addEventListener('keydown', (e: KeyboardEvent) => {
      // Don't capture lone modifier keypresses; wait until a "real" key
      // is also pressed so the combo means something.
      if (e.key === 'Meta' || e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt') return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        // Cancel: restore prior value, blur.
        el.value = (current as any)[settingsKey] || '';
        el.blur();
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        // Clear the binding entirely (user wants no hotkey for this action).
        el.value = '';
        set(settingsKey as any, '');
        el.blur();
        return;
      }
      const parts: string[] = [];
      if (e.metaKey) parts.push('Cmd');
      if (e.ctrlKey) parts.push('Ctrl');
      if (e.altKey) parts.push('Alt');
      if (e.shiftKey) parts.push('Shift');
      // Normalize the key part: single chars uppercased; named keys passed through.
      const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      parts.push(key);
      const combo = parts.join('+');
      el.value = combo;
      set(settingsKey as any, combo);
      el.blur();
    });
  }
  attachHotkeyCapture(setHotkeyCall, 'hotkeyCallMode');
  attachHotkeyCapture(setHotkeyAutoSend, 'hotkeyAutoSend');
  attachHotkeyCapture(setHotkeyMic, 'hotkeyToggleMic');

  if (setTheme) setTheme.onchange = () => {
    set('theme', setTheme.value);
    if (handlers.onThemeChange) handlers.onThemeChange();
  };
  if (setAgentActivity) setAgentActivity.onchange = () => {
    // No handler callback — activityRow.ts reads settings.get() per call,
    // so the next tool event picks up the new mode automatically.
    set('agentActivity', setAgentActivity.value as any);
  };

  // Settings panel toggle — button moved into the sidebar bottom (#sb-settings).
  // Panel is a modal overlay (same shape as #info-panel); close via X button,
  // Esc key, or backdrop click.
  const btnSet = $any('sb-settings');
  const panel = $any('settings');
  const openPanel = () => {
    if (!panel) return;
    panel.classList.add('on');
    // Suppress accidental clicks on the toolbar buttons (mic / speak /
    // lock) while settings is open. The settings backdrop already
    // intercepts taps on the toolbar position because it's a fullscreen
    // overlay, BUT the X button at the top of the bottom-sheet is
    // vertically aligned with the toolbar's lock button on a typical
    // phone — finger motion after the X tap-up was landing on lock and
    // triggering pocket-lock unexpectedly. Disabling pointer-events on
    // .toolbar while .settings.on is active makes the toolbar unable to
    // receive the synthetic-click that iOS fires post-touchend.
    document.body.classList.add('settings-modal-open');
    // Schema-driven agent settings (model picker, future persona/temp/...).
    // Replaces the legacy refreshModelState path; the agent now declares
    // what's user-tunable via /v1/settings/schema.
    agentSettings.load().catch(() => {});
    modelHandlers.reloadKeyterms?.();
  };
  const closePanel = () => {
    // Re-fetch the schema on close so changes made by parallel clients
    // (CLI, sibling tab) surface the next time the panel opens. Cheap:
    // one HTTP roundtrip; runs after the close animation starts so it
    // doesn't block the dismiss.
    agentSettings.load().catch(() => {});
    // Suppress toolbar clicks for a brief delay AFTER close to cover the
    // remainder of the iOS touch sequence (touchend → click). 350ms is
    // long enough for the synthetic click to fire and be ignored, short
    // enough that the user doesn't notice the toolbar is dead.
    document.body.classList.add('settings-just-closed');
    setTimeout(() => document.body.classList.remove('settings-just-closed'), 350);
    document.body.classList.remove('settings-modal-open');
    // Force-hide via inline style as a belt-and-braces against any
    // stylesheet override that might survive the class removal.
    if (panel) {
      panel.classList.remove('on');
      panel.style.display = 'none';
      // Restore stylesheet authority on next open: the .on class adds
      // display:flex; without clearing the inline style, openPanel's
      // class-add would race the inline 'none'. Defer the cleanup so
      // it doesn't fire mid-close-animation.
      setTimeout(() => { if (panel) panel.style.display = ''; }, 50);
    }
  };
  if (btnSet) btnSet.onclick = openPanel;
  const closeBtn = $any('settings-close');
  if (closeBtn) {
    // Multiple event paths so iOS Safari's occasional click-event drop
    // (when the button is positioned absolutely inside an overflow:auto
    // container) can't strand the user with no exit. pointerup fires
    // before click and is more robust on iOS PWA. preventDefault stops
    // the synthetic click from firing afterwards (avoids double-close).
    const handle = (e: Event) => { e.preventDefault(); e.stopPropagation(); closePanel(); };
    closeBtn.addEventListener('pointerup', handle);
    closeBtn.addEventListener('click', handle);
  }
  if (panel) {
    // Clicking the backdrop (outside .settings-inner) closes.
    panel.addEventListener('click', (e: MouseEvent) => {
      if (e.target === panel) closePanel();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel && panel.classList.contains('on')) closePanel();
  });

  // Swipe-down to dismiss on mobile — bottom-sheet shape only. Viewport
  // guard kept here at the call-site so the desktop path doesn't even
  // import the gesture module. See ./settings/mobile-bottomsheet.ts for
  // the gesture impl and the rationale on why this is mobile-only.
  if (window.innerWidth <= 699) {
    const handle = $any('settings-handle');
    const inner = panel ? (panel.querySelector('.settings-inner') as HTMLElement | null) : null;
    if (handle && inner) {
      // Dynamic import: keeps the gesture code out of the desktop bundle's
      // hot path (the viewport check above already gates execution; this
      // additionally defers the network fetch).
      import('./settings/mobile-bottomsheet.ts').then(({ attachMobileBottomsheetDismiss }) => {
        attachMobileBottomsheetDismiss(handle, inner, closePanel);
      });
    }
  }

  // (Legacy set-model dropdown handler removed — agentSettings.ts now
  // owns the model picker via the /v1/settings/* schema contract.)

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

  // Settings-panel open / close drive the agent-settings refresh now;
  // see openPanel/closePanel above. The legacy refreshModelState + 30s
  // poll talked to per-backend listModels/setModel/getCurrentModel
  // methods the proxy-client adapter doesn't implement — kept here as
  // dead code only because main.ts still references the modelHandlers
  // surface for attachment-button gating.
}
