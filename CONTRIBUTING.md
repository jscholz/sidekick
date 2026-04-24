# Contributing to ClawPortal

Thanks for wanting to contribute.

## Dev setup

```bash
npm install
cp ../.env.example .env    # or equivalent — fill in DEEPGRAM_API_KEY, GW_TOKEN
npm test
npm run typecheck
npm start
```

Open `http://localhost:3001`. If you don't have an OpenClaw gateway running, most of the UI still loads — the gateway-status pill just stays red.

## Tests

Keep `npm test` green:
```
npm test        # node:test suite — commit-word, fallback parser, markdown,
                # card pipeline, card validators
npm run typecheck  # tsc --noEmit against JSDoc annotations
```

TypeScript isn't used for compilation; we're JavaScript + JSDoc checked by tsc.
Don't add a bundler, don't rewrite in TypeScript.

## Code style

- ES modules, plain JS, no bundler. Browser loads `src/` directly.
- JSDoc for types (annotated so `tsc --noEmit` catches mistakes).
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
- OpenClaw gateway version you're pointing at (if relevant)

## Scope

ClawPortal is specifically a voice-first client for OpenClaw. PRs that generalise
to other agent backends are welcome but need to pass through an adapter — see
`src/gateway.mjs` for the current interface. Per-model quirks (e.g. Deepgram
wedge detection) stay in their provider modules.

## License

By contributing you agree that your contributions will be licensed under the
Apache License 2.0 (see `LICENSE`).
