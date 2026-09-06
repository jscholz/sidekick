# UX determinism plan — session selection and transcript scroll

Written 2026-09-06 after two field reports from the CAP (iOS) build:

1. A dictated dream log, composed after tapping the **Time management**
   session, landed in **Notion MCP Health Monitoring**.
2. The transcript still jumps under the finger while scrolling on the
   phone. Less than it used to, never on the laptop.

This document reconstructs both from logs and code, names the design
choices that make them possible, compares against how mature chat clients
avoid the same class of bug, and lays out a phased plan with acceptance
tests. It is a plan, not a change set.

---

## 1. What happened this morning (from the logs)

Source: proxy `[messages-trace]` lines (journal) and the plugin's aiohttp
access log. Times are BST.

| Time | Request | Meaning |
|---|---|---|
| 14:58:02–:17 | `GET /v1/gateway/conversations` every 5 s | App booting on a slow radio; the session list retried four times. Boot was **slow**. |
| 14:58:19 | boot burst: settings, pins, activity, unread, prefs | Boot proper. Also `ae6435b5 … around=pending:turn:umsg_…` → a pin/activity prewarm using a saved anchor keyed by a **placeholder id** (n=0). Separate bug, noted in §5. |
| **14:58:21** | `168b02fb (Time management) limit=200&after=…` | **His tap.** Delta resume of Time management. |
| 14:58:24 | `168b02fb limit=60&before=114848` (267 KB) | Time management's windowed backfill. His switch **was painting**. |
| **14:58:24** | `2ae9dc43 (Notion MCP Health Monitoring) limit=200&after=149570` | A **second resume, 3 s after his tap, with no user action.** Same shape as a `resumeSession`. |
| 15:05–15:07 | `POST /v1/push/visibility` every 8 s | App foregrounded, he is dictating. The plugin's push gate logs `user_engaged` for **2ae9dc43** — the phone was reporting Notion as the viewed chat. |
| 15:07:28 | `POST /v1/responses` → 2ae9dc43 | The send. |

The 14:58:24 resume of Notion is the boot restore of the **last-viewed
chat** finally reaching its `switchCtl.begin(restoredSid)` in `main.ts`
(he had read yesterday's health alert in that session). Sequence inside
the client:

1. Tap → `resume('168b02fb')` → `switchCtl.begin()` (gen N), optimistic
   highlight, mem paint, `backend.resumeSession()` → `activeChatId =
   Time management`.
2. Boot restore, delayed by the slow list fetch, reaches
   `switchCtl.begin(Notion)` (gen N+1). This **supersedes his switch**:
   every continuation of his tap bails at `isCurrent(tok)`. Boot paints
   Notion, commits `viewed = Notion`, and `resumeSession(Notion)` sets
   `activeChatId = Notion`.
3. Nine minutes later the composer's `currentChatId()` reads
   `focusedId()` = Notion. The send was **correctly addressed to what the
   app believed was on screen**. The UI was not lying at send time; it had
   been re-navigated under him at 14:58:24, and nothing on screen said so.

The code comment at the boot site says the token exists "so a user click
landing DURING the slow boot fetch supersedes it and this paint refuses".
That covers a click *after* boot's `begin()`. A click *before* it is
superseded *by* boot. That is the bug, and it is a property of the design
rather than a typo: **the epoch is last-writer-wins, and a programmatic
navigation has the same standing as a user gesture.**

Why "something came up" felt like loading: the switch UI is a blank pane
plus a spinner with no name on it, and the header shows only the brand.
After the drawer closes on mobile there is **nothing on screen that
identifies the current session**. WhatsApp, Discord, Slack, ChatGPT and
Claude all keep the conversation title in the header at all times; this is
the single cheapest fix in this document and would have prevented the
mis-send on its own.

## 2. Why the transcript jumps on the phone and not the laptop

- Every `.line` is `content-visibility: auto` with
  `contain-intrinsic-size: auto 100px`. Rows above the viewport are 100 px
  placeholders that settle to their real height when they become
  render-relevant. Scrolling up through never-rendered rows churns
  `scrollHeight` by 30–105 px per frame (measured by
  `scripts/scroll-jump-diag-harness.mjs`).
- Chrome on the laptop has CSS scroll anchoring (`overflow-anchor: auto`)
  and silently absorbs every one of those shifts. **WKWebView has none.**
  That is the entire laptop/phone difference.
- We built a compensator (207c605, c427f95): a ResizeObserver plus rAF loop
  that applies `scrollTop += d` when content above the anchor row changes
  height. In the lab it took 19 jumps per run to 0. Its residuals are
  structural, and documented in-code:
  1. iOS ignores or truncates programmatic `scrollTop` writes **during a
     momentum fling**. A correction issued mid-fling is lost; the eye sees
     the jump.
  2. Rubber-band clamping at the edges.
  3. Any height change the observer cannot see in the same frame (node
     inserts, image/card/KaTeX loads, timestamp date sub-lines) paints one
     shifted frame before the rAF backstop corrects it.

The deeper point: **we compensate after layout shifts instead of preventing
them.** Every mature chat list prevents: measured or known heights,
reserved space for media, no re-measurement of rows above the viewport,
and prepends whose scroll effect is computed and applied before paint.

## 3. Where we went wrong (the pattern, not the incidents)

Both bugs come from the same shape of decision. We kept the foundations
loose and stacked compensating machinery on top:

| Foundation left loose | Machinery stacked on it |
|---|---|
| "Current chat" lives in two places (`switchCtl.focusedId()` and `proxyClient.activeChatId`) and navigation is a race of equals | SwitchToken/ViewToken/PaintToken, `canPaint`, `ifStillFocused`, `clearOptimisticIfCurrent`, per-site `isCurrent` checks, the `chatId` override on `sendMessage`, `currentChatId()` reading view-state first |
| Row heights are discovered lazily during scroll | settle compensator, `restoreDomAnchor`, `noteAbsoluteScrollSeat` generations, `holdUnpinnedFor`, `pinRelatchHoldUntil`, gesture-beats-geometry, drill hold, at-bottom repin observer, `scheduleAtBottomRepin` yield |

Each mechanism is locally correct and well-commented. Together they are
non-deterministic because their *interactions* depend on timing: radio
speed decides whether boot or the tap wins; fling velocity decides whether
a correction lands. A user cannot form a model of a system whose outcome
depends on things they cannot see.

Mature clients are deterministic because the foundations are strict, not
because their compensators are cleverer:

- **One navigation state machine with explicit authority.** A user gesture
  is never superseded by anything programmatic. Boot restore, deep links
  opened by the OS, reconciles and prefetches are *requests* that a user
  action can veto; the reverse never happens.
- **Every action carries the identity it was created under.** A draft, a
  dictation, a send, a scroll position all belong to a conversation id
  captured at intent time. The current view is never consulted at
  completion time.
- **The conversation identity is always visible.** Header title, always.
- **Known geometry.** Heights are measured once and cached per message id;
  media reserves its box from known dimensions; content above the viewport
  is never re-laid-out while the user scrolls. Position is stored as
  "anchor message + offset", not `scrollTop`.
- **Prevent shifts; do not correct them.** Where a shift is unavoidable
  (prepend), the delta is computed and applied in the same frame, before
  paint, from measured heights — never observed after the fact.

## 4. How the reference apps do it

Pointers, not guarantees — worth reading before Phase 2 design.

- **Discord.** Virtualized message list with a per-message height cache;
  position stored as anchor message + offset-from-bottom; prepends adjust
  from cached heights; attachments carry width/height from the API so
  images reserve their box before loading. Channel switch is a route
  change; fetches are keyed by channel id and dropped if the route has
  moved on; the channel name is always in the header.
- **WhatsApp Web.** Bottom-anchored list; media placeholders sized from
  known aspect ratios (blurhash thumbnails); persistent chat header;
  per-chat drafts; sends are bound to the chat they were composed in.
- **Slack.** Virtualized list with a height cache; the channel name and
  a per-channel draft are always visible; a message posts to the channel
  the composer was opened in.
- **ChatGPT / Claude.** No virtualization needed for one conversation,
  but the title is always visible and the URL is the navigation state;
  sends carry the conversation id.
- **Open source to read:**
  - **Element Web** (`matrix-react-sdk` `ScrollPanel.tsx`) — the canonical
    manual scroll-anchoring implementation for engines without native
    anchoring: a "scroll token" anchored to a DOM node, `stickyBottom`,
    measure-before/after around fills. Closest to our problem.
  - **Zulip web** (`message_scroll`, `message_viewport`) — anchor-based
    restoration using a selected message as the anchor.
  - **Mattermost webapp** (`DynamicSizeList`, a fork of `react-window`
    with a height cache) — they fought exactly our jump class for years;
    the commit history is instructive.
  - **Signal Desktop** timeline, **Rocket.Chat** — further examples of
    height caches plus bottom anchoring.
  - **Native reference:** `UICollectionView` estimated heights +
    prefetching, and iMessage's inverted list. Same principles in the
    platform we are hosted in.

## 5. Plan

Phased so that each phase ships on its own and leaves the suite green.
Acceptance tests are named so "done" is checkable, not felt.

### Phase 0 — make the current session visible; instrument (1–2 days)

1. **Session title in the header**, mobile and desktop. During an
   in-flight switch it shows the *target* ("Opening Time management…"),
   then the committed title. Smoke: after a switch the header equals the
   viewed session's title; during a slowed switch it names the target.
2. **Named loading state.** The blank-pane spinner gains the target
   title. Same smoke.
3. **Navigation ledger.** Client ring buffer of switch events
   `{source: user-tap | cmdk | boot | deep-link | drill | reconcile |
   prewarm, gen, id, outcome: committed | superseded | refused}`,
   dumped to the diag console and attached to every send as `nav_gen`.
   This is the evidence we did not have this morning and had to
   reconstruct from server logs.
4. **Voice send binding.** A dictation is bound to the chat that was
   focused when recording *started*; if focus has moved by send time,
   the composer shows an inline "Sending to <title>" chip and the send
   goes to the bound chat. (Check `composerDrafts` — drafts are already
   per-chat; extend the binding to the dictation buffer.)

### Phase 1 — navigation authority (the actual fix; 2–3 days)

1. **Authority classes in `switchController`.** `begin()` takes a
   source. `user` sources (tap, keyboard, cmd-K, a push notification the
   user tapped) outrank `programmatic` sources (boot restore, most-recent
   fallback, reconcile, prewarm). A programmatic `begin()` is **refused**
   if any user navigation has occurred this app-session; a user `begin()`
   always succeeds. Boot restore checks `hasUserNavigated()` and abandons
   instead of racing. Unit tests pin the rules.
2. **One source of truth.** Retire `proxyClient.activeChatId` as an
   authority: `resumeSession()` stops re-aiming a pointer;
   `sendMessage()` requires an explicit `chatId` (every caller already
   resolves one via `currentChatId()`; make the fallback a thrown
   programming error in dev, a diag in prod).
3. **Smoke: tap during slow boot.** Mock delays the boot list fetch by
   3 s; the test taps a row at 1 s; asserts viewed id, header title and
   the next send's target all equal the tapped session, and that the boot
   ledger entry reads `refused`.
4. **Placeholder-key anchors.** Never persist a scroll anchor or pin
   whose key starts with `pending:turn:` (this morning's `around=` fetch
   for `ae6435b5` returned nothing because of one). Validate at write.

### Phase 2 — transcript geometry (1–2 weeks, staged, each stage ships)

**Stage A — measure once, stop the churn.** Cache the measured height
per row key the first time a row renders; write it into
`contain-intrinsic-size` so placeholders above the viewport are exact,
not 100 px. Reserve media boxes from known dimensions (the media
registry can carry width/height; the plugin's image/attachment envelopes
should too). Re-render markdown/KaTeX only when text changes (partly done
in b100521). Expected effect: most settle deltas become zero, so the
compensator has nothing to correct.

**Stage B — prepend without observation.** On load-earlier, compute the
inserted block's height from cached measurements (or measure it in a
hidden container) and apply the scroll delta in the same frame, before
paint. On WebKit, **defer prepends while a fling is in progress** (touch
end plus momentum settle) and show the edge loader without inserting.
Never mutate above the viewport mid-fling; that is the one case no
compensator can win.

**Stage C — only if A+B leave residuals.** True virtualization with a
height cache and a "reference message + offset" coordinate system
(Element `ScrollPanel` / Mattermost `DynamicSizeList` model), replacing
`content-visibility` entirely.

**Acceptance.** Run `scroll-jump-diag-harness` under Playwright's real
**WebKit** engine (no native anchoring, no emulation) as a gated smoke:
0 jumps under scroll-while-backfill and under fling-while-prepend. On
device, count `[scroll-jump] settle-compensate` diag lines per session;
the target is **zero corrections because nothing shifts**, not zero
visible jumps because corrections won.

### Phase 3 — retire what Phase 2 makes unnecessary

Remove the settle compensator, the holds and the re-latch heuristics
that only exist to fight lazy height discovery, keeping the WebKit
harness as the permanent regression guard. Fewer mechanisms is the goal;
determinism is a property of a small system.

## 6. Principles to adopt (proposed for CONTRIBUTING)

1. A user gesture is never superseded by programmatic navigation.
2. There is exactly one source of truth for "current conversation".
3. Every send, draft, dictation and scroll position is addressed to a
   conversation id captured at intent time, never read at completion.
4. The current conversation is always identifiable on screen.
5. Prevent layout shift above the viewport; do not compensate for it.
6. Every async continuation carries the identity it was started for and
   checks it at write time (the token model — keep it, but under rule 1).

## 7. Side findings from the same logs

- 14:58:27: the proxy opened **27 `GET /v1/events` subscriptions to the
  plugin in one second**, then logged "subscription dropped: terminated"
  at :31. An upstream SSE reconnect storm. Not today's bug; worth its own
  ticket.
- The boot fetched the session list four times before it succeeded
  (14:58:02–:17). A slow first paint is exactly the window in which a
  user taps and the race in §1 becomes reachable.

## 8. Recommendation

Phase 0 and Phase 1 are small, high-value and independent of the scroll
work; together they make this morning's failure impossible and visible.
Phase 2 is the real investment and should start with Stage A, which is
cheap and may remove most of the remaining jumps on its own. Decide on
Stage C only after measuring A and B on the phone.
