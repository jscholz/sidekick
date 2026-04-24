/**
 * @fileoverview Theme management (dark / light / auto).
 */

const systemPrefersLight = window.matchMedia('(prefers-color-scheme: light)');

function resolveTheme(mode) {
  if (mode === 'auto') return systemPrefersLight.matches ? 'light' : 'dark';
  return mode;
}

/** @param {string} mode — 'dark' | 'light' | 'auto' */
export function applyTheme(mode) {
  const effective = resolveTheme(mode);
  document.documentElement.dataset.theme = effective;
  const meta = document.getElementById('meta-theme-color');
  if (meta) meta.setAttribute('content', effective === 'light' ? '#f7f5f0' : '#0a0a0a');
}

/** Call once; re-applies on system preference change if mode is 'auto'. */
export function watchSystem(getMode) {
  systemPrefersLight.addEventListener('change', () => {
    if (getMode() === 'auto') applyTheme('auto');
  });
}
