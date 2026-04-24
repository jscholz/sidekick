/**
 * @fileoverview Runtime config, loaded from server /config endpoint.
 * Replaces hardcoded keys in the HTML.
 */

/**
 * @typedef {Object} RuntimeConfig
 * @property {string} gwToken
 * @property {string} [mapsEmbedKey]
 * @property {string[]} [sttKeyterms] - Deepgram keyterm biasing hints.
 * @property {string} [appName]
 * @property {string} [agentLabel] - Prefix the agent uses (e.g. "Clawdian").
 * @property {string} [backend] - Which BackendAdapter to load ('openclaw', 'openai-compat', ...).
 * @property {string} [openaiCompatModel] - Model string for the openai-compat backend.
 */
/** @type {RuntimeConfig | null} */
let cfg = null;

export async function loadConfig() {
  const { fetchWithTimeout } = await import('./util/fetchWithTimeout.ts');
  // 8s — /config is a file read on the server, should return instantly.
  // Longer stalls mean the gateway isn't running; better to bail fast.
  const r = await fetchWithTimeout('/config', { timeoutMs: 8_000 });
  cfg = await r.json();
  return cfg;
}

export function getConfig() {
  if (!cfg) throw new Error('config not loaded — call loadConfig() first');
  return cfg;
}

/** Gateway WS URL derived from the current page hostname. */
export function gwWsUrl() {
  return `wss://${location.hostname}:18789/ws`;
}

/** Agent's display name (shown in bubble speaker, MediaSession metadata,
 *  and used to strip the matching [bracket] prefix the agent emits). Falls
 *  back to a generic label when config isn't loaded yet. */
export function getAgentLabel() {
  return cfg?.agentLabel || 'Agent';
}

/** App name (title bar, MediaSession app name, browser tab title). */
export function getAppName() {
  return cfg?.appName || 'SideKick';
}

/** Header tagline shown beneath the app name. */
export function getAppSubtitle() {
  return cfg?.appSubtitle || 'Agent Portal';
}

/** Optional theme primary color. Empty string = don't override stylesheet. */
export function getThemePrimary() {
  return cfg?.themePrimary || '';
}

/** Apply skinning config to the DOM — brand text, document title, info
 *  panel heading, and the --primary CSS variable. Called once on boot
 *  after loadConfig() resolves. Everything user-visible that embeds the
 *  app name should flow through here so deployments with a different
 *  SIDEKICK_APP_NAME rebrand end-to-end. */
export function applySkinning() {
  const name = getAppName();
  const subtitle = getAppSubtitle();

  document.title = name;

  // Wordmark layout: header has a logo-as-S + "idekick" split, specifically
  // tuned for the "SideKick" wordmark. If the deployment sets a different
  // SIDEKICK_APP_NAME, render the full name as plain text and shrink the
  // logo to a leading icon so the split isn't lexically wrong (e.g.
  // "[S]idekick" becoming "[S]randdesk" for a Brandesk fork).
  const wmRest = document.querySelector('.header .wm-rest');
  const wmS = document.querySelector('.header .wm-s');
  if (wmRest && wmS) {
    const defaultName = 'SideKick';
    if (name.toLowerCase() === defaultName.toLowerCase()) {
      // Default branding — keep the [S]idekick split. Preserve case
      // from the config (e.g. "Sidekick" lowercases "idekick").
      wmRest.textContent = name.slice(1);
    } else {
      // Custom branding — show full name and present the logo as a
      // preceding icon (narrower, not oversized-as-cap-height).
      wmRest.textContent = name;
      (wmS as HTMLElement).style.width = '1em';
      (wmS as HTMLElement).style.height = '1em';
      (wmS as HTMLElement).style.marginRight = '6px';
      (wmS as HTMLElement).style.marginBottom = '0';
      // Hide the chevron layer — it was designed as a typographic accent
      // inside the letter S, not as part of a standalone icon.
      const chevron = wmS.querySelector('.wm-chevron') as HTMLElement | null;
      if (chevron) chevron.style.display = 'none';
    }
  }
  const subtitleEl = document.querySelector('.header .subtitle');
  if (subtitleEl) subtitleEl.textContent = subtitle;

  // Info panel / sidebar labels that reference the app by name.
  const infoH2 = document.querySelector('#info-panel h2');
  if (infoH2) infoH2.textContent = name;
  const sbInfo = document.getElementById('sb-info');
  if (sbInfo) {
    sbInfo.title = `About ${name}`;
    const label = sbInfo.querySelector('.sb-label');
    if (label) label.textContent = `About ${name}`;
  }

  const primary = getThemePrimary();
  if (primary) document.documentElement.style.setProperty('--primary', primary);
}
