// Preferred-model glob filter — config-driven allowlist of model ids
// the picker shows when non-empty. Lives at the proxy level (vs.
// inside an upstream adapter) because the source of truth is
// `models.preferred` in sidekick.config.yaml plus
// SIDEKICK_PREFERRED_MODELS env, and config reload + the
// /api/preferred-models POST/GET endpoints all live in server.ts.
//
// State is a live-mutable singleton: server.ts calls
// `rebuildPreferredModels()` at startup and on every yaml change so
// the next picker fetch sees the fresh list without a server
// restart.
//
// Globs are anchored RegExps (`^…$`); `*` becomes `.*`, regex
// metachars are escaped. Matches the per-model `id` (e.g.
// `anthropic/claude-haiku-4.5`).

/** Live-mutable so the POST /api/preferred-models handler can refresh
 *  the matcher without a server restart. */
export let PREFERRED_MODELS_RAW: string[] = [];
export let PREFERRED_MODELS_GLOBS: RegExp[] = [];

export function rebuildPreferredModels(globs: string[]): void {
  PREFERRED_MODELS_RAW = globs.filter(Boolean);
  PREFERRED_MODELS_GLOBS = PREFERRED_MODELS_RAW.map((glob) => {
    // Escape regex metachars, then turn `*` into `.*`. Anchored at
    // both ends so "anthropic/*" matches "anthropic/claude-haiku-4.5"
    // but not "fooanthropic/whatever".
    const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`);
  });
}

export function isPreferredModel(id: string): boolean {
  if (PREFERRED_MODELS_GLOBS.length === 0) return false;
  return PREFERRED_MODELS_GLOBS.some((re) => re.test(id));
}
