/**
 * @fileoverview Canvas protocol types (v1).
 *
 * These JSDoc typedefs are the contract between the agent, the fallback
 * parser, and the card renderer. Every card — whether emitted by Clawdian
 * via CLI tool, parsed from reply text, or synthesised by a client intent —
 * passes through as a CanvasCard before it reaches the renderer.
 *
 * To enable TypeScript checking later: add tsconfig with checkJs + allowJs.
 */

// ─── Canvas protocol ────────────────────────────────────────────────────────

/**
 * A card to show in the canvas pane.
 * Emitted by the agent (via canvas CLI tool), the fallback URL parser,
 * or client-side intents (image gen).
 *
 * @typedef {Object} CanvasCard
 * @property {number} v - Protocol version. Always 1.
 * @property {string} kind - Card type identifier (e.g. 'image', 'youtube', 'links').
 * @property {string} [id] - Stable ID for replace/update semantics.
 * @property {Object} payload - Kind-specific data. Schema validated per kind.
 * @property {CardMeta} [meta] - Display and lifecycle metadata.
 */

/**
 * @typedef {Object} CardMeta
 * @property {string} [title] - Optional display title (used by renderers that show a header).
 * @property {number} [ttl_sec] - Auto-dismiss after N seconds (unused in inline mode, retained for protocol compat).
 * @property {string} [replaces] - ID of card to replace in-place.
 * @property {'agent'|'intent'|'fallback'|'paste'} source - Who produced this card.
 */

// ─── Per-kind payloads ──────────────────────────────────────────────────────

/**
 * @typedef {Object} ImagePayload
 * @property {string} url - Image URL or data URI.
 * @property {string} [caption] - Text below the image.
 * @property {string} [alt] - Alt text for accessibility.
 */

/**
 * @typedef {Object} YouTubePayload
 * @property {string} video_id - YouTube video ID (11 chars).
 * @property {string} url - Full YouTube URL (for "open in YouTube" link).
 */

/**
 * @typedef {Object} SpotifyPayload
 * @property {string} url - Original Spotify URL.
 * @property {string} embed_url - Embed iframe URL.
 * @property {'track'|'album'|'playlist'|'episode'|'show'|'artist'} resource_type
 */

/**
 * @typedef {Object} LinksPayload
 * @property {LinkItem[]} links - One or more links to display.
 */

/**
 * @typedef {Object} LinkItem
 * @property {string} url
 * @property {string} [title] - From OG tags or manual.
 * @property {string} [description] - From OG tags.
 * @property {string} [image] - Preview image URL.
 * @property {string} [site_name] - e.g. "Wikipedia".
 */

/**
 * @typedef {Object} MarkdownPayload
 * @property {string} text - Markdown-formatted text to render.
 */

/**
 * @typedef {Object} WeatherPayload
 * @property {number} temp_c - Current temperature.
 * @property {number} weather_code - WMO weather code.
 * @property {string} description - Human-readable conditions.
 * @property {number} [high_c] - Daily high.
 * @property {number} [low_c] - Daily low.
 * @property {string} [location] - City / place name.
 */

/**
 * @typedef {Object} LoadingPayload
 * @property {string} [message] - e.g. "Generating image…"
 */

// ─── Card module interface ──────────────────────────────────────────────────

/**
 * Every card kind module (in canvas/cards/*.ts) exports this shape.
 *
 * @typedef {Object} CardKindModule
 * @property {string} kind - Must match the registry key.
 * @property {string} icon - Single character/emoji for the header.
 * @property {string} label - Human label (e.g. "Image", "Video").
 * @property {(payload: Object) => string[]} validate - Returns error strings; empty = valid.
 * @property {(card: CanvasCard, container: HTMLElement) => void} render - Renders into container.
 */

// Export nothing at runtime — this file is purely for type definitions.
// Importing it gives editors + tsc the types without any side effects.
export {};
