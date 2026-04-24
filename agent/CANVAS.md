# Canvas Protocol v1

The SideKick canvas is a visual pane alongside the chat. When the agent emits
a `canvas.show` payload, the client validates it and renders a card.

## Protocol shape

```json
{
  "v": 1,
  "kind": "<card-type>",
  "id": "<optional-stable-id>",
  "payload": { ... },
  "meta": {
    "title": "short label for filmstrip",
    "source": "agent",
    "replaces": "<optional-id-to-replace>",
    "ttl_sec": 0
  }
}
```

**Required fields**: `v` (always 1), `kind`, `payload`.
**Validation**: every card is validated before render. Invalid payloads are
dropped and the error returned to the agent so it can retry.

## Card kinds

### image
Show a single image. Good for generated images, photos, diagrams.
```json
{ "v": 1, "kind": "image", "payload": { "url": "https://...", "caption": "A cat" } }
```
| field | required | type |
|-------|----------|------|
| url | yes | string (URL or data URI) |
| caption | no | string |
| alt | no | string |

### youtube
Embed a YouTube video inline.
```json
{ "v": 1, "kind": "youtube", "payload": { "video_id": "dQw4w9WgXcQ", "url": "https://youtube.com/watch?v=dQw4w9WgXcQ" } }
```
| field | required | type |
|-------|----------|------|
| video_id | yes | string (6+ chars, alphanumeric + dash/underscore) |
| url | yes | string |

### spotify
Embed a Spotify player. **URL must be a real Spotify link** — made-up IDs
will be caught by oEmbed validation and replaced with a search fallback.
```json
{ "v": 1, "kind": "spotify", "payload": { "url": "https://open.spotify.com/track/...", "embed_url": "https://open.spotify.com/embed/track/...", "resource_type": "track" } }
```
| field | required | type |
|-------|----------|------|
| url | yes | string |
| embed_url | yes | string |
| resource_type | no | track, album, playlist, episode, show, artist |

### links
Show one or more URL previews with OG-enriched thumbnails.
```json
{ "v": 1, "kind": "links", "payload": { "links": [{ "url": "https://bbc.com" }] } }
```
Each link item can optionally include `title`, `description`, `image`, `site_name`
(populated automatically via OG fetch if not provided).

### markdown
Render formatted text. Good for summaries, instructions, recipes.
```json
{ "v": 1, "kind": "markdown", "payload": { "text": "# Recipe\n\n1. Boil water\n2. ..." } }
```
| field | required | type |
|-------|----------|------|
| text | yes | string (markdown) |

### loading
Temporary placeholder while async work completes.
```json
{ "v": 1, "kind": "loading", "payload": { "message": "generating image…" } }
```

## ID and replace semantics

If a card has an `id`, a later card with `meta.replaces` pointing to that id
will replace it in-place (same position in the filmstrip). Use this for:
- Loading → final image (replace loading card with image card)
- Timer tick (same id, updated payload each second)
- Shopping list updates

## When to use canvas vs. text

Use canvas when the content is **primarily visual** — images, embeds, links,
formatted reference material. Keep the verbal reply short: "Here's the video"
or "I found three articles." Don't duplicate the card content in the text.

Use text only (no canvas) for conversational replies that don't benefit from
a visual representation.

## Adding new kinds

New card kinds are added in `apps/sidekick/src/canvas/cards/<kind>.mjs`.
Each module exports `{ kind, icon, label, validate, render }`.
Register it in `main.mjs`. The agent docs (this file) are updated to match.
