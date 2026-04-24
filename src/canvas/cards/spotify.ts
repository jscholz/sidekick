/**
 * @fileoverview Spotify embed card kind.
 * Preflights URLs via oEmbed to avoid "Page not found" embeds.
 *
 * @typedef {import('../../types.js').SpotifyPayload} SpotifyPayload
 * @typedef {import('../../types.js').CanvasCard} CanvasCard
 */

import { escapeAttr, escapeHtml } from '../../util/dom.ts';
import { log } from '../../util/log.ts';

/** @type {import('../../types.js').CardKindModule} */
export default {
  kind: 'spotify',
  icon: '♫',
  label: 'Music',

  validate(payload) {
    const errors = [];
    if (typeof payload.url !== 'string') errors.push('missing url');
    if (typeof payload.embed_url !== 'string') errors.push('missing embed_url');
    return errors;
  },

  render(card, container) {
    const p = /** @type {SpotifyPayload} */ (card.payload);
    const div = document.createElement('div');
    div.className = 'card-embed spotify';

    // Show loading state while we check if the URL is valid
    div.innerHTML = `
      <div class="card-loading">checking spotify…</div>
      <a class="open-ext" href="${escapeAttr(p.url)}" target="_blank" rel="noopener">open in spotify ↗</a>`;
    container.appendChild(div);

    // Preflight via oEmbed — if the track/album doesn't exist, degrade gracefully
    import('../../util/fetchWithTimeout.ts').then(({ fetchWithTimeout }) =>
      fetchWithTimeout(`/spotify-check?url=${encodeURIComponent(p.url)}`, { timeoutMs: 10_000 }))
      .then(r => r.json())
      .then(data => {
        if (data.ok) {
          div.innerHTML = `
            <div class="embed-wrap">
              <iframe src="${escapeAttr(p.embed_url)}" allow="encrypted-media"
                sandbox="allow-scripts allow-same-origin allow-popups"></iframe>
            </div>
            <a class="open-ext" href="${escapeAttr(p.url)}" target="_blank" rel="noopener">
              ${data.title ? escapeHtml(data.title) + ' — ' : ''}open in spotify ↗
            </a>`;
        } else {
          log('spotify check failed for:', p.url, data);
          // Fall back to search link
          const query = p.url.split('/').pop()?.split('?')[0] || '';
          const searchUrl = `https://open.spotify.com/search/${encodeURIComponent(query)}`;
          div.innerHTML = `
            <div class="card-text" style="padding: 16px; text-align: center; color: var(--muted)">
              <p>This Spotify link couldn't be verified.</p>
              <a class="open-ext" href="${escapeAttr(searchUrl)}" target="_blank" rel="noopener"
                 style="color: var(--primary)">search on spotify ↗</a>
            </div>`;
        }
      })
      .catch(() => {
        // Network error — still try embedding, might work
        div.innerHTML = `
          <div class="embed-wrap">
            <iframe src="${escapeAttr(p.embed_url)}" allow="encrypted-media"
              sandbox="allow-scripts allow-same-origin allow-popups"></iframe>
          </div>
          <a class="open-ext" href="${escapeAttr(p.url)}" target="_blank" rel="noopener">open in spotify ↗</a>`;
      });
  },
};
