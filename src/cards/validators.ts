/**
 * @fileoverview Per-kind payload validators — pure logic, no DOM.
 * Shared between server (Node) and client (browser).
 * Each validator returns an array of error strings (empty = valid).
 */

export const validators = {
  image(p) {
    const e = [];
    if (typeof p.url !== 'string' || !p.url) e.push('missing or invalid url');
    return e;
  },

  youtube(p) {
    const e = [];
    if (typeof p.video_id !== 'string' || !/^[A-Za-z0-9_-]{6,}$/.test(p.video_id)) e.push('missing or invalid video_id');
    if (typeof p.url !== 'string') e.push('missing url');
    return e;
  },

  spotify(p) {
    const e = [];
    if (typeof p.url !== 'string') e.push('missing url');
    if (typeof p.embed_url !== 'string') e.push('missing embed_url');
    return e;
  },

  links(p) {
    const e = [];
    if (!Array.isArray(p.links) || p.links.length === 0) e.push('links must be a non-empty array');
    else { for (const l of p.links) { if (typeof l.url !== 'string' || !l.url) e.push('link missing url'); } }
    return e;
  },

  markdown(p) {
    if (typeof p.text !== 'string' || !p.text.trim()) return ['missing or empty text'];
    return [];
  },

  loading(_p) { return []; },
};
