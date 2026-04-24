# Archived: Canvas side-pane (2026-04-21)

These are the files that powered the original "canvas" side-pane — a
dedicated column to the right of the chat transcript that displayed one
card at a time with a filmstrip of history and an ambient clock/weather
screen when idle.

Archived because SideKick evolved into an audio-first PWA where a
persistent visual side-pane didn't earn its footprint. Structured
content now renders inline on the agent bubble that produced it
(matching the ChatGPT/Claude chat pattern).

## What's here

- `canvas.mjs` — container lifecycle: history array, current-index,
  dedup window, replace-by-id, filmstrip render, bind() to the
  side-pane DOM elements.
- `ambient.mjs` — clock + weather card shown when no card is active.
  Fetches `/weather` from the gateway; uses Open-Meteo WMO codes to
  pick emoji + description.

## What's still live

The reusable pieces stayed in `src/canvas/`:

- `registry.mjs`, `validate.mjs`, `validators.mjs` — card protocol.
- `fallback.mjs` — `parseCardsFromText` / `extractImageBlocks`.
- `cards/*.mjs` — per-kind renderers (image, youtube, spotify,
  links, markdown, loading). Each `render(card, container)` still
  works; we now pass a per-bubble attachment container instead of
  the side-pane body.
- `attach.mjs` — new thin glue that validates a card, dedups against
  prior attachments on the same bubble, and calls the kind's render().

## If you ever want the side-pane back

- Wire `bind({body, title, icon, dismiss, filmstrip, ambient})` to a
  fresh side-column in index.html.
- Keep the CSS archived here in `canvas-sidepane.css` as a starting
  point (extracted from `styles/app.css` at archive time).
- The card kinds themselves don't need changes — they render into
  whatever container you give them.
