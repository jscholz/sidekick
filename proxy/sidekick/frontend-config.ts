// Sidekick proxy — frontend settings store.
//
// PWA settings (theme, hotkeys, voice phrases, send-word, etc.) used
// to live in browser localStorage, hardcoded defaults in
// src/settings.ts. Now they live in `sidekick.config.yaml` under a
// `frontend:` section, written via POST /api/sidekick/config/{key}
// and read via GET /api/sidekick/config.
//
// Categories below match the Settings pane's groups so the yaml
// stays human-readable. The wire shape, on the other hand, is FLAT
// `{key: value}` — every PWA consumer references settings.get('key')
// without knowing the category. This mapping module is the single
// source of truth for "which settings exist + which category they
// live under in the yaml."
//
// Per-device settings (mic device, local TTS voice) stay in browser
// localStorage — their values can't be deployment-defaults.

import * as fs from 'node:fs/promises';
import YAML from 'yaml';

/** Each setting's category in the yaml + its built-in default. The
 *  default is the fallback when a fresh deployment doesn't have the
 *  yaml key set; once written, the yaml value wins. */
export const FRONTEND_SETTINGS = {
  // Streaming (mic + STT + TTS + voice-flow)
  streamingEngine:        { category: 'streaming',       default: 'server' },
  autoFallback:           { category: 'streaming',       default: true },
  ttsEngine:              { category: 'streaming',       default: 'server' },
  voice:                  { category: 'streaming',       default: 'aura-2-thalia-en' },
  tts:                    { category: 'streaming',       default: false },
  autoSend:               { category: 'streaming',       default: true },
  silenceSec:             { category: 'streaming',       default: 15 },
  commitPhrase:           { category: 'streaming',       default: 'over' },
  commitDelaySec:         { category: 'streaming',       default: 1.5 },
  navPrev:                { category: 'streaming',       default: 'previous chat' },
  navNext:                { category: 'streaming',       default: 'next chat' },
  navPause:               { category: 'streaming',       default: 'pause chat' },
  // Interaction (mic-meter + barge + wake lock + audio feedback)
  bargeIn:                { category: 'interaction',     default: true },
  bargeThreshold:         { category: 'interaction',     default: 0.20 },
  wakeLock:               { category: 'interaction',     default: true },
  audioFeedbackVolume:    { category: 'interaction',     default: 0.5 },
  // Hotkeys (modifier+key strings)
  hotkeyCallMode:         { category: 'hotkeys',         default: 'Cmd+Shift+C' },
  hotkeyAutoSend:         { category: 'hotkeys',         default: 'Cmd+Shift+S' },
  hotkeyToggleMic:        { category: 'hotkeys',         default: 'Cmd+Shift+D' },
  // Agent-activity surfacing (tool-call + tool-result row rendering)
  agentActivity:          { category: 'agent_activity',  default: 'summary' },
  // Display
  contentSize:            { category: 'display',         default: 15 },
  theme:                  { category: 'display',         default: 'dark' },
  // Composer mic-mode flags
  micCall:                { category: 'composer',        default: false },
  micAutoSend:            { category: 'composer',        default: false },
  autoAdvanceOnNew:       { category: 'composer',        default: false },
} as const;

export type FrontendSettingKey = keyof typeof FRONTEND_SETTINGS;
export type FrontendSettingValue = string | number | boolean;

/** Resolve the current value for one setting from a yaml-doc-as-JS.
 *  Returns the built-in default when the yaml doesn't have the key. */
function readOne(cfg: any, key: FrontendSettingKey): FrontendSettingValue {
  const meta = FRONTEND_SETTINGS[key];
  const cat = cfg?.frontend?.[meta.category];
  if (cat && Object.prototype.hasOwnProperty.call(cat, key)) {
    return cat[key];
  }
  return meta.default as FrontendSettingValue;
}

/** Build the flat `{key: value}` snapshot the PWA consumes. */
export function readAllFrontend(cfg: any): Record<string, FrontendSettingValue> {
  const out: Record<string, FrontendSettingValue> = {};
  for (const k of Object.keys(FRONTEND_SETTINGS) as FrontendSettingKey[]) {
    out[k] = readOne(cfg, k);
  }
  return out;
}

/** Validate + coerce a POST body's value against the declared
 *  setting type (inferred from the default). Throws on type
 *  mismatch — propagates to a 400 to the PWA. */
export function coerceValue(key: FrontendSettingKey, raw: unknown): FrontendSettingValue {
  const meta = FRONTEND_SETTINGS[key];
  const def = meta.default;
  if (typeof def === 'boolean') {
    if (typeof raw !== 'boolean') throw new Error(`expected boolean for ${key}; got ${typeof raw}`);
    return raw;
  }
  if (typeof def === 'number') {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) throw new Error(`expected number for ${key}; got ${JSON.stringify(raw)}`);
    return n;
  }
  if (typeof def === 'string') {
    if (typeof raw !== 'string') throw new Error(`expected string for ${key}; got ${typeof raw}`);
    return raw;
  }
  throw new Error(`unsupported default type for ${key}`);
}

/** Persist one setting back to the yaml document. The proxy's
 *  deployDoc is a YAML.Document so comments + ordering survive the
 *  round-trip. Returns the doc (caller writes to disk). */
export function writeOne(
  doc: YAML.Document.Parsed,
  key: FrontendSettingKey,
  value: FrontendSettingValue,
): void {
  const meta = FRONTEND_SETTINGS[key];
  doc.setIn(['frontend', meta.category, key], value);
}

/** Write the YAML document to `target`, atomically (tmp + rename
 *  to avoid a partial-file read by a concurrent reader). */
export async function persist(doc: YAML.Document.Parsed, target: string): Promise<void> {
  const tmp = `${target}.tmp-${process.pid}`;
  await fs.writeFile(tmp, doc.toString(), 'utf8');
  await fs.rename(tmp, target);
}
