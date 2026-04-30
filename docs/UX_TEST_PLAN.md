# UX-Layer Test Plan

Research pass after the proxy contract suite landed. Goal: identify
the smallest set of tests that, once green, gives high confidence the
PWA works in normal use — without ballooning the codebase with
retroactive bug-by-bug coverage.

**Status: proposed, awaiting review.** The reviewer (Jonathan) decides
which Tier-1 tests get implemented; this doc is the menu.

---

## TL;DR

- **Existing coverage is backend-heavy.** 137 unit tests cover proxy
  contract, markdown, card validation, voice state machines (commit
  word, orphan-interim promotion). The PWA UX layer — composer
  cursor, drawer click reliability, SSE envelope routing, chat
  persistence — has 4 implemented Playwright smokes and 6 stubs.
- **Tier 1 is ~5–8 tests** on the load-bearing seams: cursor position
  during dictation, drawer click reliability, envelope-gate routing,
  reload persistence, send-button state. These address the user's
  explicit concerns ("cursor should always be visible", "live
  dictation should inject at the cursor") and the highest-impact bug
  classes seen this month.
- **Tier 3 is intentionally large.** iOS lifecycle, WebRTC packet-loss,
  LLM nondeterminism, and one-off polish bugs all skip headless
  testing; manual QA on device wins those cases.

---

## Test layout convention

**Sidekick proxy contract tests live with the proxy code.** They
belong at `server-lib/sidekick/__tests__/` (or a new harness — the
WS-shaped fixture was removed during the agent-contract refactor;
HTTP-shaped follow-up is queued). The PWA-side `hermes-plugin/`
package is independently extractable. Rationale: sidekick is meant
to be modular — a fork pointing at a different agent should be able
to delete `hermes-plugin/` (or replace it with their own plugin) and
not lose anything elsewhere.

Generic / backend-agnostic tests (markdown, voice state machines,
card validation, session filter) stay in `test/`.

UX tests (the Tier-1 set below) belong in `test/` because they test
the PWA shell, not a backend. UX tests that need a backend MUST use
the mock — see T6 — and never depend on a specific backend's
behavior. (If a UX test fails one way against hermes-gateway and a
different way against another backend, the test is wrong, not the
backend.)

---

## Existing coverage

### Unit tests (`test/*.test.ts`, `node --test`, ~137 tests)

| Concern | Files | Depth |
|---|---|---|
| Proxy HTTP+SSE contract | `proxy.test.ts`, `proxy-harness.ts` | Deep — 8 contract tests, FakePlugin WS + scratch state.db |
| Card validation, fallback URL extraction | `validate.test.ts`, `pipeline.test.ts`, `fallback.test.ts` | Pure logic |
| Markdown rendering | `markdown.test.ts` | Pure logic |
| Voice state machines | `commit-word.test.ts`, `voice-interim-promote.test.ts` | Pure state machine |
| TTS sanitization | `tts-clean.test.ts` | Pure transformation |
| Session search filter | `sessionFilter.test.ts` | Pure logic |

### Playwright smoke (`scripts/smoke/*.mjs`, 4 implemented + 6 stubs)

| Scenario | Backend | Asserts | Status |
|---|---|---|---|
| `text-turn` | real | message → finalized reply renders | implemented |
| `tool-turn` | real | tool prompt → activity row + reply + tool row | implemented |
| `drawer-switch` | mock | 5 chats, click sequence switches view first-try | implemented |
| `drawer-empty-cleanup` | real | rapid new-chat clicks don't pollute drawer | implemented |
| `tool-summary-collapse` | — | (stub) summary mode collapses tool rows | not started |
| `title-update` | — | (stub) `session_changed` updates drawer title in place | not started |
| `persistence-reload` | — | (stub) reload restores chat from IDB snapshot | not started |
| `reconcile-on-reconnect` | — | (stub) forceReconnect restores stream | not started |
| `slash-commands` | — | (stub) /new /clear /sethome /compress | not started |
| `settings-mid-chat` | — | (stub) toggling settings takes effect immediately | not started |

**Gap**: composer dictation mechanics, cursor guarantees, SSE envelope
routing to active chat, chat persistence — all untested.

---

## Tier 1 — recommended tests now (the disciplined core)

Each test exercises ONE load-bearing seam. Together they cover the
mechanisms that make sidekick usable.

### T1: dictation cursor injection
- **Asserts**: voice interim → cursor advances to end of interim;
  final → cursor at end of final; UtteranceEnd → cursor stays for
  next utterance to capture from there.
- **Type**: Playwright (mock backend; voice doesn't need real LLM)
- **Files**: `src/pipelines/webrtc/dictate.ts`, `src/composer.ts`
- **Complexity**: Medium-High — **blocked on STT pluggability**
- **Addresses**: ✓ "cursor should always be visible" ✓ "live
  dictation should inject at the cursor"
- **⚠️ Pre-req — STT modularity gap (audit 2026-04-29)**:
  - No `STTProvider` interface exists; `dictate.ts` is bound directly
    to the WebRTC data channel via `connection.ts`.
  - "Deepgram" is named in shell-code comments (`connection.ts:73`,
    `main.ts:838`), suggesting an implicit assumption.
  - To mock at the right layer, extract `STTProvider` ({`start`,
    `stop`, `onTranscript`}) and pass it to `dictate.start()`. Then
    `MockSTTProvider` fires synthetic events; tests don't need WebRTC.
  - **Estimated refactor cost: 2–3 hours** (touches `connection.ts`,
    `dictate.ts`, `main.ts`, new `src/audio/stt-provider.ts`).
  - Without this refactor, T1 collapses into either an integration
    test (real audio bridge + real Deepgram, slow + flaky) or a
    mock-at-the-wrong-layer (stubs `connection.ts` internals,
    fragile). **Do the STT refactor before T1.**

### T2: composer send-button state
- **Asserts**: send button enabled iff (typed text > 0 ||
  `draft.hasContent()` || memo recording || pending attachments).
  Each transition matches state changes; `appendText()` fires
  `input` event so the button wakes up after voice append.
- **Type**: Unit (mock composer/draft/attachments) + smoke (verify
  input-event dispatch wakes the listener)
- **Files**: `src/main.ts:updateSendButtonState()`, `src/composer.ts`
- **Complexity**: Low (unit), Medium (smoke)
- **Addresses**: voice-append-but-button-stays-grey class of bug

### T3: drawer click switches on first try (extend existing)
- **Asserts**: 5 mock chats, click each in sequence; each click
  switches transcript on FIRST try (no stale-callback bounce-back);
  hold 600ms after each click to detect delayed race.
- **Type**: Playwright (mock backend)
- **Files**: `src/sessionDrawer.ts:resume()`, `src/backends/hermes-gateway.ts`
- **Complexity**: Medium (already prototyped — `drawer-switch.mjs`
  has the throttling pattern; just enforce mock setup)
- **Addresses**: the iOS Safari "1/3 of clicks fail" bug class

### T4: SSE envelope routed to active chat only
- **Asserts**: Send in chat A, switch to chat B before reply lands.
  Chat A's incoming reply_delta does NOT render in B (gate blocks
  by chat_id). Switch back to A → A's reply renders.
- **Type**: Playwright (mock backend can sequence cross-chat
  envelopes deterministically)
- **Files**: `src/backends/hermes-gateway.ts` (envelope handlers),
  `src/main.ts:handleReplyDelta()`, `src/sessionDrawer.ts:getViewed()`
- **Complexity**: Medium
- **Addresses**: the "three replies in active chat" bug class — the
  exact seam we narrowed to PWA-side this evening. Once T4 is green,
  any future cross-chat leak is a regression with a name.

### T5: chat snapshot persists across reload
- **Asserts**: send message in fresh chat → reload → chat_id +
  transcript restore from IDB snapshot, drawer highlights same row.
- **Type**: Playwright (mock backend)
- **Files**: `src/chat.ts:saveSnapshot()/loadSnapshot()`,
  `src/sessionDrawer.ts:getRestoredViewedSessionId()`,
  `src/conversations.ts`
- **Complexity**: Medium
- **Addresses**: mobile-critical — iOS PWA backgrounding kills tab
  state; restoration must be reliable.

### T6: session_changed updates drawer title in place
- **Asserts**: send first message → mock backend emits a
  `session_changed` envelope with title "Mocked Title" → within
  500ms drawer entry title changes from "New chat" to "Mocked Title"
  (not just on reload).
- **Type**: Playwright (mock backend — fires `session_changed`
  envelope synthetically; default mocked, real-backend run is
  manual / on-demand when touching adjacent code).
- **Files**: `src/sessionDrawer.ts:refresh()`,
  `src/backends/hermes-gateway.ts` session_changed handler
- **Complexity**: Low (this is the existing stub; just implement)
- **Addresses**: user-reported bug; stub already named.
- **Note**: this is a UX test, not a hermes integration test. Mocked
  output catches every bug except timing-of-replies (since mock is
  instant). For real-backend coverage, run on-demand when changing
  the title-generation path or `session_changed` envelope handling.

### T7: dictation append-and-send end-to-end
- **Asserts**: start voice capture → say "hello world over" →
  transcript finalizes "hello world" (commit-phrase stripped) →
  composer has "hello world" at cursor → send button enabled →
  click send → user bubble appears in transcript.
- **Type**: Playwright (mock backend)
- **Files**: `src/pipelines/webrtc/dictate.ts`,
  `src/pipelines/webrtc/dictation.ts`, `src/composer.ts`,
  `src/main.ts`
- **Complexity**: Medium-High (orchestrate voice→composer→send
  state machine through synthetic Deepgram events)
- **Addresses**: end-to-end sanity for the most-used feature path

### T8: tool activity row renders
- **Asserts**: tool-using prompt → tool_call envelope → activity row
  in DOM within 5s, has `.activity-row` + ≥1 `.tool-row` child.
- **Type**: Playwright (real backend — needs tool-using LLM turn)
- **Files**: `src/main.ts:handleToolCall()`, `src/activityRow.ts`,
  `src/chat.ts`
- **Complexity**: Medium
- **Addresses**: tool calls dropped mid-stream class of bug
- **Note**: extends existing `tool-turn.mjs` which already covers
  the happy path. T8 isolates the activity-row existence as the
  prerequisite for future collapse/expand tests (Tier 2).

---

## Tier 2 — playwright candidates

Stubs already named in `scripts/smoke/`. Lower priority because the
seam is either less-trafficked or depends on Tier-1 infra.

1. **tool-summary-collapse** — `agentActivity='summary'` collapses
   tool rows; click expands; mid-conversation toggle takes effect.
2. **slash-commands** — `/new`, `/clear`, `/sethome`, `/compress`
   produce expected side effects. /compress needs LLM.
3. **settings-mid-chat** — toggle setting → next event/message
   reflects new setting (not cached at boot).
4. **attachment-lifecycle** — attach file → send button enables →
   send → attachment transmitted, UI clears.
5. **scroll-to-bottom triggers** — reply_delta does NOT scroll;
   reply_final does. 10 replies, check position after each.
6. **draft segment tracking** — voice mode creates draft block,
   speaker prefix suppressed when composer has content.

---

## Tier 3 — explicitly skipping (one-line reasons)

| What | Why skip |
|---|---|
| iOS lifecycle (audio context, app backgrounding, cellular handoff) | Too entangled with OS; manual QA on device wins |
| WebRTC connection stability (packet loss, latency, device enumeration) | External vendor; the state machine that consumes transcripts is already tested |
| LLM output shape variance (tool availability, response shapes) | Infinite regression armor; payload-agnostic handlers; real-backend smoke + manual cases |
| Service worker cache lifecycle, skip-waiting races | Browser API integration; the real test is "new code visible after deploy" — staged deploy, not headless |
| Reconnect-on-EventSource-kill | Hard to fake headless reliably; flag as manual QA |
| Retroactive coverage of every reported bug | Test the seams, not the symptoms — once a fix lands, the regression test exists per-bug as needed |

---

## Risks / unknowns

- **WebRTC dictation mocking complexity**: tests that exercise voice
  need synthetic Deepgram-shaped events. No mock peer exists yet —
  could be in-process simulator that injects messages directly into
  the bridge handler. Need to scaffold this once; reusable for T1, T7.
- **LLM-dependent tests flake on slow backend**: text-turn / tool-turn
  / T6 / T8 wait for real replies. Bumped timeouts and dedicated
  "real-backend" CI lane mitigates.
- **Cross-browser cursor semantics**: `selectionStart`/`selectionEnd`
  behavior may differ on iOS Safari. Use `page.evaluate()` to read
  exact values rather than relying on Playwright's helpers.
- **Drawer race may not reproduce on fast localhost**: `drawer-switch.mjs`
  throttles history endpoint to provoke the race; keep the throttle
  in T3.

---

## Suggested implementation order

If we do Tier 1, this order minimizes infra cost and front-loads the
highest-confidence tests:

1. **T3** (drawer click) — extends existing scenario, low ceiling
2. **T6** (title-update) — implement the stub, low complexity, real backend
3. **T2** (send-button) — unit-testable, foundational
4. **T5** (persistence-reload) — implement the stub, mobile-critical
5. **T4** (envelope gate) — pins the routing layer
6. **T1** (dictation cursor) — needs voice-event injection infra
7. **T7** (dictation end-to-end) — reuses T1's infra
8. **T8** (tool activity row) — extends existing scenario

Implementing T1–T4 alone covers ~80% of the recurring failure modes.
T5–T8 round out the surface but can defer if time-constrained.
