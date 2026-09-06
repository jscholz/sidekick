// A dictation belongs to the chat it was SPOKEN INTO, not to whatever
// composer happens to be on screen when the transcript finally arrives.
//
// Jonathan, 2026-09-06 (after the mis-send reconstructed in
// docs/UX_DETERMINISM_PLAN.md §1):
//
//   "The Send button always sends what is in the current composer to the
//    session on screen. A dictation is bound to the chat where recording
//    STARTED. The checkmark dumps the transcript into the composer DRAFT
//    of that origin chat. If you switched sessions mid-dictation the
//    visible composer is untouched; the draft is waiting in the origin
//    chat, where you can switch, edit and send."
//
// Before this change every delivery path ended at composer.appendText,
// which writes the VISIBLE textarea. Invisible in the no-switch case —
// which is why it lasted — and wrong in exactly the case that costs
// minutes of speech: the slow upload, the chunked retry, the durable
// outbox draining after a reconnect. §1's dream log landed in the wrong
// chat this way.
//
// Two scenarios, both with the transcript deliberately in flight ACROSS
// the switch (a stubbed /transcribe that sleeps), because a delivery
// that lands before the user moves proves nothing:
//
//   A. CHECKMARK, THEN SWITCH. Dictate in A, press the checkmark, switch
//      to B before the transcript lands. B's composer stays empty, the
//      words are nowhere on B's screen, A's row grows a "Draft:" badge,
//      switching back to A puts them in the box, and Send from A posts
//      to A.
//   B. SWITCH WHILE STILL RECORDING, CHECKMARK PRESSED IN B — the flow
//      he actually described. The recording keeps running (nothing is
//      truncated), and the checkmark pressed from B files the transcript
//      in A's draft rather than in the composer under his thumb.
//   C. THE REALTIME MODE (the default), where words stream into the
//      visible textarea live: the switch ends the session, the words so
//      far are in A's draft, and a straggler final fired afterwards is
//      filed there too rather than spliced into B.
//
// A and B run in batch mode (dictateRealtime=false): it is the mode with a
// checkmark, and its transcript arrives long after the gesture, which is
// where the binding has to hold. C covers the realtime default, whose
// failure mode is the mirror image.

import {
  waitForReady, resetServerSettings, assert, openSidebar, clickRow,
  send, waitForDrawerQuiet, pollUntil,
} from './lib.mjs';

export const NAME = 'dictation-draft-binds-to-origin';
export const DESCRIPTION = 'A dictation lands in the draft of the chat it started in, never in the composer of the chat you switched to';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-dictation-origin-a';
const CHAT_B = 'mock-dictation-other-b';
const TRANSCRIPT_A = 'remember the dream about the flooded parking garage';
const TRANSCRIPT_B = 'and the second one about the elevator';

/** Long enough that the switch is comfortably mid-flight, short enough
 *  that the smoke stays quick. The routing decision is read at DELIVERY
 *  time, so the whole test hinges on this delay outliving the click. */
const TRANSCRIBE_DELAY_MS = 3_000;

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 300;
  mock.addChat(CHAT_A, {
    title: 'Dream log',
    messages: [{ role: 'user', content: 'DICT-A-SEED', parley_id: 'umsg_dict_a', timestamp: t0 }],
    lastActiveAt: Date.now() - 2000,
  });
  mock.addChat(CHAT_B, {
    title: 'Health monitoring',
    messages: [{ role: 'user', content: 'DICT-B-SEED', parley_id: 'umsg_dict_b', timestamp: t0 + 10 }],
    lastActiveAt: Date.now() - 1000,
  });
}

const composerValue = (page) =>
  page.evaluate(() => document.getElementById('composer-input')?.value ?? '');

const transcriptText = (page) =>
  page.evaluate(() => document.getElementById('transcript')?.textContent ?? '');

const memoBarPresent = (page) =>
  page.evaluate(() => !!document.querySelector('.memo-bar'));

/** Read a chat's persisted draft straight from the module that owns it —
 *  more precise than the row snippet (which truncates at 60 chars) and
 *  the same source the composer restores from on a switch. */
const draftFor = (page, chatId) =>
  page.evaluate(async (id) => {
    const drafts = await import('/build/composerDrafts.mjs');
    return drafts.getDraft(id);
  }, chatId);

const dictateIsActive = (page) =>
  page.evaluate(async () => {
    const dictate = await import('/build/audio/realtime/dictate.mjs');
    return dictate.isActive();
  });

const rowDraftBadge = (page, chatId) =>
  page.evaluate((id) => {
    const el = document.querySelector(`#sessions-list li[data-chat-id="${id}"] .sess-draft-badge`);
    return el ? el.textContent : null;
  }, chatId);

/** Wait until `chatId`'s transcript is the one painted. Mirrors
 *  composer-drafts-per-session's settleAt — the drawer's own quiet gate
 *  plus a marker from the chat's canned history. */
async function settleAt(page, needle) {
  await page.waitForFunction(
    (n) => (document.getElementById('transcript')?.textContent || '').includes(n),
    needle, { timeout: 8_000, polling: 50 },
  );
  await waitForDrawerQuiet(page);
}

/** Start a batch dictation and let MediaRecorder capture a few hundred
 *  ms of the fake device's (silent) audio — an instant stop yields an
 *  empty blob and there would be nothing to transcribe. */
async function startDictating(page) {
  await page.evaluate(() => window.__micDispatch('tap'));
  await page.waitForSelector('.memo-bar', { timeout: 8_000 });
  await page.waitForTimeout(600);
}

/** Press the checkmark (the relocated send button in accept-mode) —
 *  the gesture that ends a batch dictation. */
const pressCheckmark = (page) =>
  page.evaluate(() => document.getElementById('composer-send')?.click());

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  // Batch dictation: the mode with a checkmark, and the one whose
  // transcript arrives long enough after the gesture for a switch to
  // fit inside the gap.
  await resetServerSettings(page, {
    streamingEngine: 'server', micAutoSend: false, dictateRealtime: false,
  });
  await page.evaluate(async () => {
    // resetServerSettings writes the server row; the in-memory settings
    // object is what startDictate forks on, so pin it here too (same
    // belt-and-braces dictate-realtime-toggle uses).
    const settings = await import('/build/settings.mjs');
    settings.set('dictateRealtime', false);
  });

  // A /transcribe that sleeps, so the transcript is genuinely in flight
  // while the user switches chats. Without the sleep the delivery lands
  // before the click and the test grades nothing.
  let transcript = TRANSCRIPT_A;
  await page.route(/\/transcribe(\?|$)/, async (route) => {
    await new Promise((r) => setTimeout(r, TRANSCRIBE_DELAY_MS));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, transcript }),
    });
  });

  await openSidebar(page);

  // ── A: CHECKMARK IN A, SWITCH TO B BEFORE THE TRANSCRIPT LANDS ───────
  await clickRow(page, CHAT_A);
  await settleAt(page, 'DICT-A-SEED');
  await startDictating(page);
  log('A: dictating in "Dream log"');
  await pressCheckmark(page);

  // The switch, while /transcribe is still asleep.
  await clickRow(page, CHAT_B);
  await settleAt(page, 'DICT-B-SEED');
  assert(await composerValue(page) === '',
    `A: B's composer must be empty the moment we arrive, got "${await composerValue(page)}"`);

  // Now outlive the stub's delay and then some, so the delivery has
  // definitely happened before we assert it did NOT go to B.
  await page.waitForTimeout(TRANSCRIBE_DELAY_MS + 1_500);
  assert(!(await composerValue(page)).includes(TRANSCRIPT_A),
    `A: the transcript landed in the composer of the chat he switched TO — the §1 bug. Composer: "${await composerValue(page)}"`);
  assert(!(await transcriptText(page)).includes(TRANSCRIPT_A),
    'A: the transcript must not appear anywhere in B (no bubble, no card) — dictation is input, not a message');
  log('A ✓ nothing of the dictation reached the chat he switched to');

  // …and it is not lost: it is parked in A's draft, visible from the list.
  await page.waitForFunction(
    (id) => !!document.querySelector(`#sessions-list li[data-chat-id="${id}"] .sess-draft-badge`),
    CHAT_A, { timeout: 6_000, polling: 100 },
  );
  const badge = await rowDraftBadge(page, CHAT_A);
  assert(badge && badge.includes(TRANSCRIPT_A.slice(0, 20)),
    `A: the origin row should advertise the waiting draft, got: ${badge}`);
  log('A ✓ "Dream log" row shows the waiting draft');

  // Switching back restores it into the composer — via the ordinary
  // per-chat draft restore, nothing dictation-specific.
  await clickRow(page, CHAT_A);
  await settleAt(page, 'DICT-A-SEED');
  await pollUntil(page, (t) => (document.getElementById('composer-input')?.value ?? '').includes(t),
    TRANSCRIPT_A,
    { timeout: 6_000, label: "A: the dictation never came back in the origin chat's composer" });
  assert((await composerValue(page)).trim() === TRANSCRIPT_A,
    `A: the composer should hold exactly the dictation, got "${await composerValue(page)}"`);
  log('A ✓ switching back to the origin puts the dictation in the box');

  // Send goes where the composer is — the rule that did NOT change.
  await send(page, await composerValue(page));
  await page.waitForTimeout(1_000);
  const inA = mock.getChat(CHAT_A)?.messages.some((m) => (m.content || '').includes(TRANSCRIPT_A));
  const inB = mock.getChat(CHAT_B)?.messages.some((m) => (m.content || '').includes(TRANSCRIPT_A));
  assert(inA, 'A: Send from the origin chat must POST to the origin chat');
  assert(!inB, 'A: the dictation must never reach the chat he had switched to');
  log('A ✓ Send from "Dream log" posted to "Dream log"');

  // ── B: SWITCH WHILE STILL RECORDING; CHECKMARK PRESSED FROM B ────────
  // His literal description. The recording must survive the switch (a
  // stop here would truncate the sentence he is still speaking) and the
  // checkmark must still file its transcript in the origin.
  transcript = TRANSCRIPT_B;
  await clickRow(page, CHAT_A);
  await settleAt(page, 'DICT-A-SEED');
  await startDictating(page);
  log('B: dictating in "Dream log", switching away mid-recording');

  await clickRow(page, CHAT_B);
  await settleAt(page, 'DICT-B-SEED');
  assert(await memoBarPresent(page),
    'B: the recording must keep running across a chat switch — a torn-down memo bar means the rest of the sentence was dropped');
  assert(await composerValue(page) === '',
    `B: B's composer must be untouched while A's dictation runs, got "${await composerValue(page)}"`);

  await pressCheckmark(page);
  await page.waitForTimeout(TRANSCRIBE_DELAY_MS + 1_500);
  assert(!(await composerValue(page)).includes(TRANSCRIPT_B),
    `B: the checkmark filled the composer of the wrong chat, got "${await composerValue(page)}"`);
  assert(!(await transcriptText(page)).includes(TRANSCRIPT_B),
    'B: nothing of the dictation may appear in the chat on screen');
  log('B ✓ checkmark pressed from another chat left that chat untouched');

  await clickRow(page, CHAT_A);
  await settleAt(page, 'DICT-A-SEED');
  await pollUntil(page, (t) => (document.getElementById('composer-input')?.value ?? '').includes(t),
    TRANSCRIPT_B,
    { timeout: 6_000, label: 'B: the mid-recording dictation never reached the origin draft' });
  log('B ✓ the transcript was waiting in the origin chat');


  // ── C: REALTIME DICTATION ACROSS A SWITCH ────────────────────────────
  // dictateRealtime is ON by default, so this is the mode he actually
  // uses, and its exposure is different: words stream into the VISIBLE
  // textarea as he speaks, so there is no delivery gap to exploit — the
  // splice machine is simply left aimed at a textarea that now belongs
  // to another conversation. Two halves:
  //   C1 the switch ENDS the live session (auto-commit), the words so
  //      far are already saved into the origin's draft by the same
  //      view-commit seam, and the chat he arrived at is untouched;
  //   C2 the straggler final a provider flushes during teardown, fired
  //      while the view is elsewhere, files itself in the origin's draft
  //      instead of splicing into the composer under his thumb.
  // Driven with a MockSTTProvider exactly as dictate-cursor-injection
  // does — no WebRTC, no network.
  const REALTIME_TEXT = 'live dictation into the dream log';
  const STRAGGLER = 'the straggler final flushed during teardown';

  await clickRow(page, CHAT_A);
  await settleAt(page, 'DICT-A-SEED');
  await page.evaluate(async (origin) => {
    const dictate = await import('/build/audio/realtime/dictate.mjs');
    class MockSTTProvider {
      constructor() { this.listener = null; }
      async start() { /* nothing real to spin up */ }
      async stop() { /* no-op */ }
      onTranscript(cb) {
        this.listener = cb;
        return () => { if (this.listener === cb) this.listener = null; };
      }
      fire(ev) { if (this.listener) this.listener(ev); }
    }
    window.__dictateMock = new MockSTTProvider();
    const ta = document.getElementById('composer-input');
    ta.focus();
    ta.value = '';
    ta.setSelectionRange(0, 0);
    await dictate.start({
      sessionId: origin, chatId: origin, originChatId: origin,
      initialCursor: 0, provider: window.__dictateMock,
    });
  }, CHAT_A);
  await page.evaluate((t) => window.__dictateMock.fire({
    type: 'transcript', role: 'user', is_final: true, text: t,
  }), REALTIME_TEXT);
  assert((await composerValue(page)).includes(REALTIME_TEXT),
    `C1: realtime dictation must land in the composer of the chat it is aimed at, got "${await composerValue(page)}"`);
  log('C1: dictating live in "Dream log"');

  await clickRow(page, CHAT_B);
  await settleAt(page, 'DICT-B-SEED');
  assert(!(await dictateIsActive(page)),
    'C1: a switch must end the live dictation — a stream left running writes nowhere visible and leaves a lit mic with no effect');
  assert(await composerValue(page) === '',
    `C1: the chat he switched to must keep its own (empty) composer, got "${await composerValue(page)}"`);
  assert((await draftFor(page, CHAT_A)).includes(REALTIME_TEXT),
    'C1: everything dictated before the switch must be waiting in the origin draft');
  log('C1 ✓ switch ended the live session and parked the words in the origin');

  // C2: the teardown straggler. Same binding, view already elsewhere.
  await page.evaluate(async (origin) => {
    const dictate = await import('/build/audio/realtime/dictate.mjs');
    await dictate.start({
      originChatId: origin, initialCursor: 0, provider: window.__dictateMock,
    });
  }, CHAT_A);
  await page.evaluate((t) => window.__dictateMock.fire({
    type: 'transcript', role: 'user', is_final: true, text: t,
  }), STRAGGLER);
  assert(!(await composerValue(page)).includes(STRAGGLER),
    `C2: a final for another chat must never splice into the visible composer, got "${await composerValue(page)}"`);
  assert((await draftFor(page, CHAT_A)).includes(STRAGGLER),
    'C2: the straggler must be kept — in the origin chat\'s draft');
  await page.evaluate(async () => {
    const dictate = await import('/build/audio/realtime/dictate.mjs');
    await dictate.stop();
  });
  log('C2 ✓ a late final for a chat he has left goes to that chat\'s draft, not to the box in front of him');

  // The proxy's settings table is shared across scenarios; put the
  // mic-mode default back so a later scenario doesn't inherit batch
  // dictation from us. (lib's resetServerSettings also restores it, but
  // only for scenarios that call it.)
  await resetServerSettings(page, { dictateRealtime: true });

  log('PASS: a dictation is bound to the chat it started in — the composer on screen is never written by someone else\'s speech');
}
