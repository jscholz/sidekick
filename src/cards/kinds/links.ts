/**
 * @fileoverview Link-list card kind. Renders with OG-enriched previews,
 * inline iframes for frameable sites, and Google Maps embeds.
 *
 * @typedef {import('../../types.js').LinksPayload} LinksPayload
 * @typedef {import('../../types.js').CanvasCard} CanvasCard
 */

import { escapeHtml, escapeAttr } from '../../util/dom.ts';
import { getConfig } from '../../config.ts';

/** @type {import('../../types.js').CardKindModule} */
export default {
  kind: 'links',
  icon: '⎘',
  label: 'Links',

  validate(payload) {
    const errors = [];
    if (!Array.isArray(payload.links) || payload.links.length === 0) {
      errors.push('links must be a non-empty array');
    } else {
      for (const l of payload.links) {
        if (typeof l.url !== 'string' || !l.url) errors.push('link missing url');
      }
    }
    return errors;
  },

  render(card, container) {
    const p = /** @type {LinksPayload} */ (card.payload);
    const div = document.createElement('div');
    div.className = 'card-links';

    const tryIframe = p.links.length === 1;

    for (const link of p.links) {
      const host = safeHost(link.url);

      // Google Maps → use Embed API (interactive map, not a static preview)
      const mapsEmbed = tryIframe && buildMapsEmbed(link.url);
      if (mapsEmbed) {
        const frame = document.createElement('div');
        frame.className = 'link-iframe-wrap maps';
        frame.innerHTML = `<iframe src="${escapeAttr(mapsEmbed)}" allowfullscreen loading="lazy" referrerpolicy="no-referrer"></iframe>`;
        div.appendChild(frame);
        // Still show a small link below for "open in Google Maps"
        const a = document.createElement('a');
        a.href = link.url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.className = 'open-ext';
        a.textContent = 'open in google maps ↗';
        div.appendChild(a);
        container.appendChild(div);
        return;
      }

      const a = document.createElement('a');
      a.href = link.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.className = 'link-preview';
      a.innerHTML = renderPreviewBody(link, host);
      div.appendChild(a);
      fetchAndDecorate(a, link.url, host, tryIframe, div);
    }

    container.appendChild(div);
  },
};

// ── Google Maps Embed ─────────────────────────────────────────────────────

/**
 * Detect Google Maps URLs and convert to Embed API format.
 * Returns embed URL or null if not a maps link.
 */
function buildMapsEmbed(url) {
  let cfg;
  try { cfg = getConfig(); } catch { return null; }
  const key = cfg.mapsEmbedKey;
  if (!key) return null;

  // Directions: google.com/maps/dir/ORIGIN/DESTINATION
  // Real URLs often trail with /@lat,lng,zoomz/data=!3m1!4b1!... — those
  // segments are NOT destinations and break the Embed API if passed through.
  const dirMatch = url.match(/google\.com\/maps\/dir\/([^?]+)/i);
  if (dirMatch) {
    const parts = dirMatch[1]
      .split('/')
      .filter(p => p && !isNonPlaceSegment(p))
      .map(decodeURIComponent);
    if (parts.length >= 2) {
      const origin = encodeURIComponent(parts[0].replace(/\+/g, ' '));
      const dest = encodeURIComponent(parts[parts.length - 1].replace(/\+/g, ' '));
      return `https://www.google.com/maps/embed/v1/directions?origin=${origin}&destination=${dest}&key=${key}`;
    }
  }

  // Place: google.com/maps/place/PLACE or google.com/maps?q=QUERY
  const placeMatch = url.match(/google\.com\/maps\/place\/([^/?]+)/i);
  if (placeMatch && !isNonPlaceSegment(placeMatch[1])) {
    const q = encodeURIComponent(decodeURIComponent(placeMatch[1]).replace(/\+/g, ' '));
    return `https://www.google.com/maps/embed/v1/place?q=${q}&key=${key}`;
  }

  // Search query: google.com/maps/search/QUERY or google.com/maps?q=QUERY
  const searchMatch = url.match(/google\.com\/maps\/search\/([^/?]+)/i) ||
                      url.match(/google\.com\/maps\?.*q=([^&]+)/i);
  if (searchMatch) {
    const q = encodeURIComponent(decodeURIComponent(searchMatch[1]).replace(/\+/g, ' '));
    return `https://www.google.com/maps/embed/v1/search?q=${q}&key=${key}`;
  }

  // Generic maps URL with coordinates: /@LAT,LNG,ZOOM
  const coordMatch = url.match(/google\.com\/maps.*\/@([-\d.]+),([-\d.]+),([\d.]+)z/i);
  if (coordMatch) {
    return `https://www.google.com/maps/embed/v1/view?center=${coordMatch[1]},${coordMatch[2]}&zoom=${coordMatch[3]}&key=${key}`;
  }

  return null;
}

/**
 * A Google Maps URL path segment that is NOT a place name:
 *   • `@37.12,-122.12,15z` — coordinate + zoom (prefixed with `@`)
 *   • `data=!3m1!4b1!4m5...` — Maps' opaque protobuf-in-URL data blob
 *     (anything containing `=` is param-like, never a place)
 */
function isNonPlaceSegment(seg) {
  return seg.startsWith('@') || seg.includes('=');
}

// ── OG Preview ────────────────────────────────────────────────────────────

function safeHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url; }
}

function renderPreviewBody(link, host) {
  const img = link.image
    ? `<img class="preview-image" src="${escapeAttr(link.image)}" alt="" loading="lazy" onerror="this.remove()">`
    : '';
  return `${img}
    <div class="preview-body">
      <div class="preview-host">
        <img src="https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(host)}" alt="">
        <span>${escapeHtml(link.site_name || host)}</span>
      </div>
      <div class="preview-title">${escapeHtml(link.title || link.url)}</div>
      ${link.description ? `<div class="preview-desc">${escapeHtml(link.description)}</div>` : ''}
    </div>`;
}

async function fetchAndDecorate(anchor, url, host, tryIframe, container) {
  try {
    const { fetchWithTimeout } = await import('../../util/fetchWithTimeout.ts');
    const r = await fetchWithTimeout(`/link-preview?url=${encodeURIComponent(url)}`, { timeoutMs: 10_000 });
    const og = await r.json();

    // Use OG image if available; fall back to Chromium screenshot for sites
    // with no OG data (paywalled/JS-rendered like NYT)
    let image = og.image;
    if (!image && !og.description) {
      image = `/screenshot?url=${encodeURIComponent(url)}`;
    }
    const enriched = {
      url, title: og.title, description: og.description,
      image, site_name: og.siteName,
    };
    anchor.innerHTML = renderPreviewBody(enriched, host);

    if (tryIframe && og.frameable) {
      const frame = document.createElement('div');
      frame.className = 'link-iframe-wrap';
      frame.innerHTML = `
        <iframe src="${escapeAttr(url)}"
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
          loading="lazy" referrerpolicy="no-referrer"></iframe>`;
      container.insertBefore(frame, anchor);
    }
  } catch { /* keep skeleton */ }
}
