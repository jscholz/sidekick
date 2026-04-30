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

Keep `npm test` green before every commit:
```
npm test           # all *.test.ts under test/, src/, proxy/
npm run typecheck  # tsc --noEmit over TypeScript sources
```

Source is TypeScript compiled to `.mjs` via esbuild (`scripts/build.mjs`) — the
browser loads the compiled output, no runtime bundler.

### Test layout convention

Generic / backend-agnostic tests live in `test/`:
- `markdown.test.ts`, `validate.test.ts`, `pipeline.test.ts` (card pipeline)
- `commit-word.test.ts`, `voice-interim-promote.test.ts` (voice state machines)
- `tts-clean.test.ts`, `fallback.test.ts`, `sessionFilter.test.ts`

Backend-specific tests are co-located with the backend under
`proxy/backends/<name>/__tests__/`. Today this is just hermes-gateway
(`proxy/backends/hermes-gateway/__tests__/proxy.test.ts` + harness),
but the convention scales: a fork swapping hermes for another backend
deletes `proxy/backends/hermes-gateway/` + `backends/hermes/plugin/` and
loses no tests elsewhere.

UX tests (browser-DOM scenarios) belong in `test/` because they test the
PWA shell, not a backend. See `docs/UX_TEST_PLAN.md` for the proposed
Tier 1/2/3 test plan and which seams are worth pinning.

### Test-writing principles

- **Test the seam, not the symptom.** When a bug reproduces, write the
  test at the lowest layer where the misbehavior is observable. The
  proxy contract suite was written this way: 8 tests pin contract
  invariants (orphan-list filtering, chat_id-tagged SSE, atomic
  delete) so any future regression has a name.
- **Hermetic by default.** Tests for the proxy or any backend
  abstraction MUST run without a live hermes / network / LLM. The
  `proxy/backends/hermes-gateway/__tests__/proxy-harness.ts`
  pattern (FakePlugin WS + scratch state.db) is the template — copy
  it for new backends.
- **UX tests should never depend on a specific backend.** If a UX test
  fails one way against hermes-gateway and another way against
  another backend, the test is wrong. Use the mock backend
  (`scripts/smoke/mock-backend.mjs`) by default; real-backend runs are
  on-demand when touching adjacent code.

### When extending the proxy contract

The proxy contract is documented at
`proxy/backends/hermes-gateway/CONTRACT.md`. If you change any of
the `/api/sidekick/*` HTTP+SSE surface or the WS envelope schema:
1. Update CONTRACT.md.
2. Add a contract test under `__tests__/proxy.test.ts` that pins the
   new behavior.
3. Run the suite (`npm test -- proxy/backends/hermes-gateway/__tests__/proxy.test.ts`)
   before committing.

### Diagnostic recipes (when a UX bug repros)

Triage at the right layer FIRST. If `curl` reproduces the bug, it's
the proxy or downstream; if only the PWA repros, it's the PWA.

```bash
# Watch one chat's live envelope stream
curl -N "http://127.0.0.1:3001/api/sidekick/stream?chat_id=$CHAT"

# Drawer source-of-truth (should match state.db)
curl http://127.0.0.1:3001/api/sidekick/sessions | jq

# state.db ground truth
sqlite3 ~/.hermes/state.db \
  "SELECT id, title, message_count FROM sessions WHERE source='sidekick' ORDER BY started_at DESC LIMIT 20"

# Drive a turn from CLI (no PWA needed)
curl -X POST http://127.0.0.1:3001/api/sidekick/messages \
  -H 'content-type: application/json' \
  -d '{"chat_id":"test-cli","text":"hi"}'

# Run the proxy contract suite
npm test -- proxy/backends/hermes-gateway/__tests__/proxy.test.ts
```

### Smoke tests (Playwright)

`npm run smoke` runs Playwright scenarios under `scripts/smoke/`.
Scenarios opt into mock or real backend via `BACKEND` export:
- `BACKEND='mocked'` — uses `scripts/smoke/mock-backend.mjs` route
  interception. Fast, hermetic, no chat pollution. **Default for new
  scenarios.**
- `BACKEND='real'` — hits a running hermes. Slower, flakier; reserve
  for cases that genuinely depend on live LLM behavior.
- `BACKEND='either'` — runs against whichever is available.

Override per-run with `--real-backend` to force every scenario through
hermes (used when validating that mock matches reality).

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
adapter interface — see `src/proxyClientTypes.ts` and the existing adapters in
`src/`. Per-provider quirks (e.g. Deepgram wedge detection) stay in
their provider modules.

## License

By contributing you agree that your contributions will be licensed under the
Apache License 2.0 (see `LICENSE`).
