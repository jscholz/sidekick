// Scenario: tool-using prompt → activity row appears AND a new
// finalized agent bubble lands after it. Validates the Phase 3
// tool_call / tool_result envelope rendering path.
//
// Catches:
//   - Tool envelopes flow but activity row doesn't render.
//   - Tool round-trip but reply_final never finalizes (stuck mid-stream).
//   - .activity-row exists but no tool rows inside.

import { waitForReady, clickNewChat, send, deleteChat, SEL, assert } from './lib.mjs';

export const NAME = 'tool-turn';
export const DESCRIPTION = 'Tool-using prompt → activity row + finalized reply';
export const STATUS = 'implemented';
// Tool turn requires a real model to decide to call a tool. Mock can't
// simulate Phase 3's tool_call/tool_result envelopes faithfully (that's
// the thing we're testing).
export const BACKEND = 'real';

const TOOL_PROMPT = 'Search the web for today\'s weather in London and tell me the high temperature.';

function captureNextChatId(page) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('new-session log not seen in 5s')), 5000);
    const handler = (msg) => {
      const m = /new session \(chat_id=([0-9a-f-]+)\)/.exec(msg.text());
      if (m) {
        clearTimeout(t);
        page.off('console', handler);
        resolve(m[1]);
      }
    };
    page.on('console', handler);
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  const chatIdP = captureNextChatId(page);
  await clickNewChat(page);
  const chatId = await chatIdP;

  // Skip the greeting — go straight to the tool prompt. (The greeting
  // round-trip is covered by text-turn.mjs.)
  const t0 = await send(page, TOOL_PROMPT);

  // Activity row should appear when the first tool_call envelope arrives.
  await page.waitForSelector(SEL.activityRow, { timeout: 30_000 });
  const tActivity = Date.now();
  log(`activity row appeared in ${tActivity - t0} ms`);

  // Eventually a finalized agent bubble lands (the reply post-tool).
  // Count baseline first since the home-channel nudge from earlier
  // chats may already be present.
  const baselineCount = await page.locator(SEL.agentFinal).count();
  await page.waitForFunction(
    ({ sel, baseline }) => document.querySelectorAll(sel).length > baseline,
    { sel: SEL.agentFinal, baseline: baselineCount },
    { timeout: 60_000, polling: 250 },
  );
  const tReply = Date.now();
  log(`reply finalized in ${tReply - t0} ms`);

  // Tool rows: at least one .tool-row in DOM (collapsed under summary
  // in 'summary' mode but still in the DOM tree).
  const toolRowCount = await page.locator(SEL.toolRow).count();
  log(`tool rows in DOM: ${toolRowCount}`);
  assert(toolRowCount >= 1, `expected ≥1 tool row, got ${toolRowCount}`);

  await deleteChat(page, chatId);
}
