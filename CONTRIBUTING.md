# Contributing to Sidekick

Thanks for wanting to contribute.

## Dev setup

```bash
npm install
cp .env.example .env    # fill in DEEPGRAM_API_KEY, and backend-specific vars
npm test
npm run typecheck
npm start
```

Open `http://localhost:3001`. If you don't have an agent backend running, most of the UI still loads — the backend-status pill just stays red.

## Tests

Keep `npm test` green:
```
npm test           # node:test suite — commit-word, fallback parser, markdown,
                   # card pipeline, card validators, voice interim-promotion, tts cleanup
npm run typecheck  # tsc --noEmit over TypeScript sources
```

Source is TypeScript compiled to `.mjs` via esbuild (`scripts/build.mjs`) — the
browser loads the compiled output, no runtime bundler.

## Code style

- ES modules, native `import` graph, no bundler. Browser loads `build/` directly.
- TypeScript sources under `src/`; JSDoc casts where inference falls short.
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
- Which backend you're pointing at (hermes, openclaw, openai-compat, zeroclaw) and its version

## Scope

Sidekick is a voice-first PWA for agent backends. New backends plug in via the
adapter interface — see `src/backends/types.ts` and the existing adapters in
`src/backends/`. Per-provider quirks (e.g. Deepgram wedge detection) stay in
their provider modules.

## License

By contributing you agree that your contributions will be licensed under the
Apache License 2.0 (see `LICENSE`).
