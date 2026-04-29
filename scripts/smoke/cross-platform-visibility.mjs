// Scenario: cross-platform sessions (telegram, slack, etc.) appear in
// the drawer alongside sidekick chats, render with a source badge,
// and the composer goes read-only when one is viewed (cross-platform
// send isn't supported — would route through the wrong adapter).
//
// Phase 1 of the cross-platform-visibility design (see Jonathan's
// 2026-04-29 ask: "i want sidekick to be 1:1 with my state.db /
// sessions transcripts on disk").
//
// Test plan (mocked):
//   1. Pre-populate 1 sidekick chat (with content) + 1 telegram chat.
//   2. Click sidekick chat → assert composer ENABLED + no badge on
//      this row's neighbors that we care about (sidekick is the
//      default; no badge for it is expected).
//   3. Click telegram chat → assert composer DISABLED + placeholder
//      reflects the platform name + transcript shows the chat's
//      messages + drawer row has TELEGRAM badge.
//   4. Click sidekick chat → composer ENABLED again.

import { waitForReady, openSidebar, SEL, assert } from './lib.mjs';

export const NAME = 'cross-platform-visibility';
export const DESCRIPTION = 'Telegram session appears in drawer with badge; composer goes read-only';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const SK_CHAT = 'mock-sk-chat';
const TG_CHAT = '12345';
const SK_MARKER = 'sidekick-marker';
const TG_MARKER = 'telegram-marker';

export function MOCK_SETUP(mock) {
  mock.addChat(SK_CHAT, {
    source: 'sidekick',
    title: 'Sidekick chat',
    messages: [
      { role: 'user', content: SK_MARKER, timestamp: Date.now() / 1000 - 60 },
      { role: 'assistant', content: 'sidekick reply', timestamp: Date.now() / 1000 - 59 },
    ],
    lastActiveAt: Date.now() - 60_000,
  });
  mock.addChat(TG_CHAT, {
    source: 'telegram',
    title: 'Telegram chat',
    messages: [
      { role: 'user', content: TG_MARKER, timestamp: Date.now() / 1000 - 30 },
      { role: 'assistant', content: 'telegram reply', timestamp: Date.now() / 1000 - 29 },
    ],
    lastActiveAt: Date.now() - 30_000,
  });
}

async function clickRow(page, chatId) {
  await page.locator(`#sessions-list li[data-chat-id="${chatId}"] .sess-body`).first().click();
}

async function composerState(page) {
  return page.evaluate(() => {
    const input = document.getElementById('composer-input');
    const send = document.getElementById('composer-send');
    return {
      inputDisabled: input?.disabled ?? null,
      placeholder: input?.placeholder ?? '',
      sendDisabled: send?.disabled ?? null,
      hasReadonlyClass: input?.classList?.contains('readonly') ?? false,
    };
  });
}

async function transcriptText(page) {
  return page.evaluate(() => document.getElementById('transcript')?.textContent || '');
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  await page.waitForSelector(`#sessions-list li[data-chat-id="${SK_CHAT}"]`, { timeout: 5_000 });
  await page.waitForSelector(`#sessions-list li[data-chat-id="${TG_CHAT}"]`, { timeout: 5_000 });
  log('drawer pre-populated: 1 sidekick + 1 telegram chat ✓');

  // 1. Source badge on telegram row but NOT sidekick row.
  //    The badge is a <span> inside .sess-meta with the platform name
  //    as text. Count badge spans (which have inline text-transform).
  const badgeInfo = await page.evaluate(({ sk, tg }) => {
    function scan(chatId) {
      const li = document.querySelector(`#sessions-list li[data-chat-id="${chatId}"]`);
      if (!li) return null;
      const meta = li.querySelector('.sess-meta');
      if (!meta) return null;
      // Badge = span with inline `text-transform:uppercase` (renders ALLCAPS).
      const spans = Array.from(meta.querySelectorAll('span'));
      const badges = spans
        .filter(s => /text-transform\s*:\s*uppercase/i.test(s.getAttribute('style') || ''))
        .map(s => (s.textContent || '').trim().toLowerCase());
      return badges;
    }
    return { sidekick: scan(sk), telegram: scan(tg) };
  }, { sk: SK_CHAT, tg: TG_CHAT });
  assert(
    Array.isArray(badgeInfo.telegram) && badgeInfo.telegram.includes('telegram'),
    `telegram row should have a TELEGRAM badge, got ${JSON.stringify(badgeInfo.telegram)}`,
  );
  assert(
    Array.isArray(badgeInfo.sidekick) && badgeInfo.sidekick.length === 0,
    `sidekick row should have no source badge, got ${JSON.stringify(badgeInfo.sidekick)}`,
  );
  log(`telegram badge present; sidekick row has no badge ✓`);

  // 2. Click sidekick — composer enabled.
  await clickRow(page, SK_CHAT);
  await page.waitForFunction(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(m),
    SK_MARKER,
    { timeout: 3_000, polling: 50 },
  );
  let state = await composerState(page);
  assert(state.inputDisabled === false, `step 2: composer should be enabled on sidekick chat, got disabled=${state.inputDisabled}`);
  assert(!state.hasReadonlyClass, `step 2: composer should NOT have .readonly class on sidekick`);
  log(`sidekick chat: composer enabled ✓`);

  // 3. Click telegram — composer disabled with hint.
  await clickRow(page, TG_CHAT);
  await page.waitForFunction(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(m),
    TG_MARKER,
    { timeout: 3_000, polling: 50 },
  );
  // Give setComposerReadOnly a beat to settle (it's called from
  // replaySessionMessages, runs synchronously after the renders).
  await page.waitForTimeout(100);
  state = await composerState(page);
  assert(state.inputDisabled === true, `step 3: composer should be DISABLED on telegram chat, got disabled=${state.inputDisabled}`);
  assert(state.hasReadonlyClass, `step 3: composer should have .readonly class`);
  assert(
    /telegram/i.test(state.placeholder),
    `step 3: composer placeholder should mention telegram, got ${JSON.stringify(state.placeholder)}`,
  );
  assert(state.sendDisabled === true, `step 3: send button should be disabled`);
  // Transcript should contain only telegram marker now.
  const txt = await transcriptText(page);
  assert(
    !txt.includes(SK_MARKER),
    `step 3: sidekick marker should not appear in telegram chat`,
  );
  log(`telegram chat: composer disabled with read-only placeholder ✓`);

  // 4. Click back to sidekick — composer re-enabled.
  await clickRow(page, SK_CHAT);
  await page.waitForFunction(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(m),
    SK_MARKER,
    { timeout: 3_000, polling: 50 },
  );
  await page.waitForTimeout(100);
  state = await composerState(page);
  assert(state.inputDisabled === false, `step 4: composer should be enabled after returning to sidekick, got disabled=${state.inputDisabled}`);
  assert(!state.hasReadonlyClass, `step 4: composer should NOT have .readonly class`);
  log(`returned to sidekick: composer re-enabled ✓`);
}
