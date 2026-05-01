# Agent guide for sidekick

Read this first if you're an AI coding agent (Claude Code, Cursor,
etc.) about to make non-trivial changes. Five-minute orientation,
saves a multi-hour thrash later.

## Before you change anything

1. **`CONTRIBUTING.md`** — dev setup, test commands, code style, and
   the test-layout convention. Read the "Tests" section in full; the
   diagnostic recipes alone will save you hours.
2. **`proxy/backends/hermes-gateway/CONTRACT.md`** — if your
   change touches the proxy or PWA backend client. Documents the
   WebSocket envelope schema, session lifecycle, HTTP+SSE surface,
   and what state lives where (`state.db` vs `sessions.json`).
3. **`docs/UX_TEST_PLAN.md`** — proposed UX-layer tests, tiered. If
   you're touching composer / drawer / chat / dictation, check
   whether your area is in Tier 1; consider writing the test before
   the fix.
4. **`docs/ABSTRACT_AGENT_PROTOCOL.md`** + **`docs/SIDEKICK_AUDIO_PROTOCOL.md`**
   — agent / audio wire formats, only relevant if you're touching
   those layers.

## Workflow rules (learned the hard way)

- **Map the contract before writing integration code.** If you're
  bridging two systems, the canonical wire / API contract beats your
  guesses. Spend 5 minutes reading the spec; don't reverse-engineer
  it from one or two endpoints. (CONTRACT.md exists for this reason.)

- **Read API docs before writing API code.** Every recurring problem
  on this codebase has traced back to misunderstanding or misusing
  someone else's API. If you're calling a library or external
  service, find its docs FIRST — `~/.hermes/hermes-agent/gateway/`
  for hermes, the official docs for npm packages, the project's
  own CONTRACT.md / docs/ for in-tree contracts. "I'll figure it
  out from the type signatures" is the path to the multi-hour
  thrash.

- **For bugs at integration boundaries, write a failing test first.**
  The test pins the misbehavior at the lowest layer where it's
  observable. Adding instrumentation to "see what's happening" is
  almost always the wrong instinct — the test stays as regression
  armor; the instrumentation gets ripped out the next day.

- **Hermetic test harness is load-bearing, not premature.** If you're
  adding a feature that touches shared state (state.db, sessions.json,
  IDB), build the mock / scratch path before the feature. The proxy
  test suite at `proxy/backends/hermes-gateway/__tests__/` is
  the template.

- **Use the Plan agent for tasks > 30 minutes.** Five minutes of
  planning saves hours of thrash. Pattern: dispatch the Plan agent
  with concrete context, review the plan, execute in commits.

- **Don't fix more than one thing per commit.** Each commit must be
  independently rollback-safe; the user tests at branch tip and
  needs to be able to revert one bad commit without losing others.

- **If a fix takes more than 2 attempts, stop.** Write a test that
  pins what's actually happening. Fix once, with confidence.

## Test before committing

Always run, in this order:
```
npm test           # ~1.4s, 120+ tests
npm run typecheck  # ~3s
```

If your change touches `proxy/backends/hermes-gateway/*`, also:
```
npm test -- proxy/backends/hermes-gateway/__tests__/proxy.test.ts
```
to surface failures with proxy-test-only output. The full suite hides
the per-test detail.

For UI-touching changes, run the relevant Playwright smoke:
```
npm run smoke -- --filter drawer-switch    # specific scenario
npm run smoke                              # all scenarios
```
Smoke runs use the mock backend by default. Real-backend runs are for
when you're validating that mock matches reality.

## Backend-specific changes

The repo is meant to be modular. Hermes is the default backend but
not the only one — `src/proxyClientTypes.ts` defines the abstraction
and `src/{hermes-gateway,openai-compat,openclaw}.ts` are the
implementations.

If you're changing **only** hermes-specific code: edit under
`proxy/backends/hermes-gateway/` (server side) or
`src/hermes-gateway.ts` (client side). Tests go under
`proxy/backends/hermes-gateway/__tests__/`.

If you're changing **shared / generic** behavior (composer, drawer,
chat, voice): edit under `src/`, with tests in `test/`. These must
work against any backend.

If you find yourself editing `src/main.ts` or `src/composer.ts` to
add backend-specific behavior, stop — that's a leaky abstraction. Add
a method to the backend adapter interface instead.

## Local hermes patches

If you're editing hermes-agent itself (`~/.hermes/hermes-agent/`),
you're outside this repo. Read `~/code/hermes-agent-private/HERMES_PATCHES.md`
first — it documents the long-lived patch branches, the rebase
workflow before `pip install -U hermes-agent`, and the upstream-PR
plan. Don't add patches without updating that ledger.

## Restarting services during development

**Two long-running services**:
- `hermes-gateway.service` — hermes-agent (Python, in `~/.hermes/hermes-agent/`)
- `sidekick.service` — sidekick proxy (`server.ts` + `proxy/`)

If you change Python code under `~/.hermes/hermes-agent/`, restart
hermes-gateway. If you change anything under `proxy/` or
`server.ts`, **restart sidekick.service**. The PWA bundle
(`build/*`) is served by the proxy and re-loaded on browser hard-
reload, so frontend changes don't need a service restart — just
`npm run build` + reload — but proxy code is loaded once at process
start.

```
systemctl --user restart hermes-gateway   # after hermes-agent code changes
systemctl --user restart sidekick         # after proxy code changes
```

**Gotcha**: smoke tests using the mock backend (`BACKEND='mocked'`)
intercept HTTP at the BROWSER side via Playwright `page.route()`,
so they bypass the proxy entirely. They will pass even if the
deployed proxy is running stale code. To verify a proxy fix is
actually live, hit the proxy directly with `curl` after restart, or
run a `BACKEND='real'` smoke scenario.

State.db / sessions.json / IDB survive both restarts. The user
(Jonathan) has consented to autonomous restarts during dev sessions.
