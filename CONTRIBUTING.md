# Contributing to Sidekick

Thanks for wanting to contribute.

## Dev setup

```bash
npm install
# Optional .env with DEEPGRAM_API_KEY, SIDEKICK_BACKEND, etc.
npm test
npm run typecheck
npm start
```

Open `http://localhost:3001`. Without a backend reachable, most of the
UI still loads — the connection-status pill just stays red.

## Tests

Keep `npm test` green:
```
npm test        # node:test suite — commit-word, fallback parser, markdown,
                # card pipeline, card validators
npm run typecheck  # tsc --noEmit
```

## Code style

- ES modules, no bundler. Browser loads `build/` (compiled 1:1 from `src/`).
- JSDoc / TypeScript for types, checked by `tsc --noEmit`.
- Minimal comments; prefer well-named identifiers. Comments explain *why* not *what*.
- No emoji in committed code unless the feature is explicitly about emoji.

## PR guidelines

- Small, focused PRs.
- Include a short rationale in the description — what's the user-visible effect, and what trade-off does it make.
- Update `sw.js` `CACHE_NAME` if you change any file in the `APP_SHELL` list.
- If you add a new source file under `src/`, add it to `APP_SHELL` too.

## Reporting bugs

Please include:
- Browser + OS + whether you're running as an installed PWA
- The `?debug=1` panel output or `localStorage.sidekick_debug='1'` log dump covering the failure
- Which `SIDEKICK_BACKEND` you're pointing at

## Scope

Sidekick is a voice-first client that's agent-agnostic by design. New
integrations land as a `BackendAdapter` — see
[`src/backends/README.md`](src/backends/README.md). Per-model quirks
(e.g. Deepgram wedge detection) stay inside their provider modules.

## License

By contributing you agree that your contributions will be licensed under the
Apache License 2.0 (see `LICENSE`).
