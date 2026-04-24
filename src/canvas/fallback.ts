/**
 * @fileoverview Fallback parser: extracts CanvasCard payloads from plain text.
 *
 * This is the best-effort path for when the agent doesn't use canvas.show
 * directly — e.g. it emits a URL in chat text, or includes a markdown image.
 * Cards produced here go through the same validate → render pipeline as
 * agent-emitted cards.
 *
 * Rules:
 *   1. Markdown images ![alt](url) → image card
 *   2. YouTube URLs → youtube card
 *   3. Spotify URLs → spotify card
 *   4. Remaining URLs → links card (with async OG enrichment)
 *   5. Never duplicate: each URL is classified once.
 *
 * @typedef {import('../types.js').CanvasCard} CanvasCard
 */

/**
 * Parse reply text into zero or more CanvasCard payloads.
 * @param {string} text - Raw reply text from the agent.
 * @returns {CanvasCard[]}
 */
export function parseCardsFromText(text) {
  /** @type {CanvasCard[]} */
  const cards = [];
  const seen = new Set();

  // 1. Markdown images
  for (const m of text.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
    seen.add(m[2]);
    cards.push({
      v: 1,
      kind: 'image',
      payload: { url: m[2], caption: m[1] || undefined },
      meta: { title: m[1]?.slice(0, 40) || 'Image', source: 'fallback' },
    });
  }

  // 2. Enumerate all URLs, classify each
  const urlRe = /https?:\/\/[^\s<)\]"'`]+/gi;
  const leftovers = [];

  for (const m of text.matchAll(urlRe)) {
    // Strip trailing noise, then validate with URL constructor
    let url = m[0].replace(/[,.;:!?)>]+$/, '');
    try { url = new URL(url).href; } catch { continue; } // skip malformed URLs
    if (seen.has(url)) continue;
    seen.add(url);

    // YouTube
    const yt = url.match(
      /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{6,})/i
    );
    if (yt) {
      cards.push({
        v: 1,
        kind: 'youtube',
        payload: { video_id: yt[1], url },
        meta: { title: 'YouTube', source: 'fallback' },
      });
      continue;
    }

    // Spotify
    const sp = url.match(
      /^https?:\/\/open\.spotify\.com\/(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]+)/i
    );
    if (sp) {
      cards.push({
        v: 1,
        kind: 'spotify',
        payload: {
          url,
          embed_url: `https://open.spotify.com/embed/${sp[1]}/${sp[2]}?utm_source=generator`,
          resource_type: sp[1],
        },
        meta: { title: `Spotify ${sp[1]}`, source: 'fallback' },
      });
      continue;
    }

    leftovers.push({ url });
  }

  // 3. Generic links
  if (leftovers.length > 0) {
    cards.push({
      v: 1,
      kind: 'links',
      payload: { links: leftovers },
      meta: {
        title: leftovers.length === 1 ? 'Link' : `${leftovers.length} links`,
        source: 'fallback',
      },
    });
  }

  return cards;
}

/**
 * Extract image blocks from an agent message's content array.
 * Handles multiple shapes (Anthropic base64, OpenAI image_url, direct url/data).
 * @param {Array<Object>} content
 * @returns {CanvasCard[]}
 */
export function extractImageBlocks(content) {
  /** @type {CanvasCard[]} */
  const out = [];
  for (const c of content || []) {
    if (!c || c.type !== 'image') continue;
    let url = null;
    if (typeof c.url === 'string') url = c.url;
    else if (c.image_url?.url) url = c.image_url.url;
    else if (c.source?.url) url = c.source.url;
    else if (c.source?.data) {
      url = `data:${c.source.media_type || 'image/png'};base64,${c.source.data}`;
    } else if (c.data) {
      url = `data:${c.media_type || 'image/png'};base64,${c.data}`;
    }
    const title = c.alt || c.caption || c.title || 'Generated';
    if (url) {
      out.push({
        v: 1,
        kind: 'image',
        payload: { url, caption: title !== 'Generated' ? title : undefined },
        meta: { title: title.slice(0, 40), source: 'agent' },
      });
    }
  }
  return out;
}
