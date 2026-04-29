# Agent guide for sidekick

Read this first if you're an AI coding agent (Claude Code, Cursor,
etc.) about to make non-trivial changes. Five-minute orientation,
saves a multi-hour thrash later.

## Before you change anything

1. **`CONTRIBUTING.md`** — dev setup, test commands, code style, and
   the test-layout convention. Read the "Tests" section in full; the
   diagnostic recipes alone will save you hours.
2. **`server-lib/backends/hermes-gateway/CONTRACT.md`** — if your
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

- **For bugs at integration boundaries, write a failing test first.**
  The test pins the misbehavior at the lowest layer where it's
  observable. Adding instrumentation to "see what's happening" is
  almost always the wrong instinct — the test stays as regression
  armor; the instrumentation gets ripped out the next day.

- **Hermetic test harness is load-bearing, not premature.** If you're
  adding a feature that touches shared state (state.db, sessions.json,
  IDB), build the mock / scratch path before the feature. The proxy
  test suite at `server-lib/backends/hermes-gateway/__tests__/` is
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

If your change touches `server-lib/backends/hermes-gateway/*`, also:
```
npm test -- server-lib/backends/hermes-gateway/__tests__/proxy.test.ts
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
not the only one — `src/backends/types.ts` defines the abstraction
and `src/backends/{hermes-gateway,openai-compat,openclaw}.ts` are the
implementations.

If you're changing **only** hermes-specific code: edit under
`server-lib/backends/hermes-gateway/` (server side) or
`src/backends/hermes-gateway.ts` (client side). Tests go under
`server-lib/backends/hermes-gateway/__tests__/`.

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

## Restarting hermes during development

If a hermes-agent code change needs to take effect, restart the
gateway:
```
systemctl --user restart hermes-gateway
```
The user (Jonathan) has consented to autonomous restarts during dev
sessions. State.db / sessions.json survive the restart.
