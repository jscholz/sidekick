// Scenario: fresh chat, send "hi", expect at least one finalized agent
// bubble with real text (not a placeholder). Captures the basic
// send→render round-trip.
//
// On a fresh sidekick install (no SIDEKICK_HOME_CHANNEL in config),
// hermes also fires a home-channel onboarding nudge as a SECOND bubble
// before the agent's reply. With SIDEKICK_HOME_CHANNEL set (typical
// post-/sethome) the nudge is skipped and there's just the one reply.
// Test accepts either shape.
//
// Catches:
//   - Render gate dropping envelopes when getViewed is null.
//   - handleReplyFinal wiping the bubble when envelope text is empty
//     (agent reply finalizes then disappears, only visible after a
//     session-switch-and-back).
//   - Stuck on "sending…" indefinitely.

import { waitForReady, clickNewChat, send, SEL, assert } from './lib.mjs';

export const NAME = 'text-turn';
export const DESCRIPTION = 'Fresh chat → "hi" → finalized agent bubble with non-placeholder text';
export const STATUS = 'implemented';

export default async function run({ page, log }) {
  await waitForReady(page);
  await clickNewChat(page);

  const t0 = await send(page, 'hi');

  // Wait for the first finalized agent bubble.
  await page.waitForSelector(SEL.agentFinal, { timeout: 60_000 });
  const t1 = Date.now();

  // Give the stream a beat to flush any follow-up bubble (home-channel
  // nudge etc.) so we assert against the steady-state DOM, not a
  // mid-stream snapshot.
  await page.waitForTimeout(500);

  const texts = await page.locator(`${SEL.agentFinal} .text`).allInnerTexts();
  for (let i = 0; i < texts.length; i++) {
    log(`bubble[${i}]: ${JSON.stringify(texts[i]?.slice(0, 80))}`);
  }
  assert(texts.length >= 1, `expected ≥1 finalized agent bubble, got 0`);
  for (let i = 0; i < texts.length; i++) {
    assert(texts[i].trim().length > 0, `bubble[${i}] empty`);
    assert(
      !/^(thinking|using \w+|pending)…?$/i.test(texts[i].trim()),
      `bubble[${i}] looks like a placeholder: ${JSON.stringify(texts[i])}`,
    );
  }

  log(`timing: send → first bubble = ${t1 - t0} ms`);
}
