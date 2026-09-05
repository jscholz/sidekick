// Transcript approval card (2026-09-05 redesign).
//
// Contract:
//   * An approval notification renders as ONE warning line (the speaker)
//     + reason + the command collapsed by default + Approve / Approve
//     session / Deny buttons. No second "⚠️ Dangerous command…" header
//     and no "Reply /approve …" instructions inside the body.
//   * The card's Approve button sends /approve; the user_message echo
//     resolves the tray record and the card flips to data-approval-state
//     "approved" with the "✓ Approved" pill and no buttons.
//   * Approving from the Activity tray flips the in-chat card the same
//     way (field: tray approve left the chat card orange/pending).
//   * The in-app banner for a focused-chat approval is sticky and hides
//     once the approval resolves.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'approval-card-actions';
export const DESCRIPTION = 'in-chat approval card: compact layout, collapsed command, action buttons, resolves from card or tray, banner retires on resolve';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-approval-card';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(CHAT_ID, {
    title: 'Approval card chat',
    messages: [{ role: 'user', content: 'card seed', parley_id: 'umsg_card_seed', timestamp: t0 }],
    lastActiveAt: Date.now() - 1000,
  });
}

function approvalEnvelope(parleyId, reason) {
  return {
    type: 'notification',
    chat_id: CHAT_ID,
    kind: 'approval',
    content:
      '⚠️ Dangerous command requires approval:\n\n' +
      `printf ${parleyId}\nrm -rf /tmp/${parleyId}\n\n` +
      `Reason: ${reason}\n` +
      'Reply /approve to execute, /approve session to approve this pattern for the session, or /deny to cancel.',
    parley_id: parleyId,
    urgent: true,
  };
}

async function inspectCard(page, key) {
  return page.evaluate((k) => {
    const el = document.querySelector(`#transcript .line.notification-approval[data-key="${k}"]`);
    if (!el) return { present: false };
    const text = el.textContent || '';
    return {
      present: true,
      state: el.getAttribute('data-approval-state') || '',
      speaker: (el.querySelector('.speaker')?.textContent || '').trim(),
      triangles: (text.match(/⚠️/g) || []).length,
      hasReplyInstructions: /Reply \/approve/i.test(text),
      reason: (el.querySelector('.approval-reason')?.textContent || '').trim(),
      commandOpen: !!el.querySelector('details.approval-command[open]'),
      peek: (el.querySelector('.approval-command-peek')?.textContent || '').trim(),
      buttons: Array.from(el.querySelectorAll('.approval-actions button')).map(b => b.textContent.trim()),
      pill: (el.querySelector('.approval-state')?.textContent || '').trim(),
      pillResolution: el.querySelector('.approval-state')?.getAttribute('data-resolution') || '',
    };
  }, key);
}

async function waitForCardState(page, key, state) {
  await page.waitForFunction(
    ([k, s]) => document.querySelector(`#transcript .line.notification-approval[data-key="${k}"]`)?.getAttribute('data-approval-state') === s,
    [key, state], { timeout: 5_000, polling: 100 },
  );
}

async function bannerVisible(page) {
  return page.evaluate(() => {
    const el = document.getElementById('in-app-banner');
    return !!el && el.classList.contains('visible');
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  await page.waitForFunction(
    () => /card seed/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 4_000, polling: 50 },
  );

  // ─── 1. Layout + card Approve ─────────────────────────────────────────
  const id1 = 'notif_card_approve';
  mock.pushEnvelope(approvalEnvelope(id1, 'card layout smoke'));
  await waitForCardState(page, id1, 'pending');
  const before = await inspectCard(page, id1);
  assert(before.present, 'approval card must render in the transcript');
  assert(before.triangles === 1, `exactly one ⚠️ on the card (got ${before.triangles}) — single warning line, no stacked header`);
  assert(/Dangerous command requires approval/i.test(before.speaker), `speaker is the warning line, got "${before.speaker}"`);
  assert(!before.hasReplyInstructions, 'the "Reply /approve …" instructions must not render in the card');
  assert(before.reason === 'card layout smoke', `reason line rendered, got "${before.reason}"`);
  assert(!before.commandOpen, 'command must be collapsed by default');
  assert(/printf notif_card_approve/.test(before.peek) && /\+1 more/.test(before.peek),
    `collapsed peek shows first line + count, got "${before.peek}"`);
  assert(before.buttons.join('|') === 'Approve|Approve session|Deny',
    `pending card has Approve / Approve session / Deny, got ${JSON.stringify(before.buttons)}`);
  assert(await bannerVisible(page), 'focused-chat approval raises the (sticky) in-app banner');
  log('card layout ✓ (one warning line, collapsed command, 3 buttons, banner up)');

  await page.locator(`#transcript .line.notification-approval[data-key="${id1}"] .approval-actions button`, { hasText: /^Approve$/ }).click();
  await waitForCardState(page, id1, 'approved');
  const after1 = await inspectCard(page, id1);
  assert(after1.buttons.length === 0, `resolved card has no buttons (got ${after1.buttons.length})`);
  assert(after1.pillResolution === 'approved' && /^✓\s*Approved$/.test(after1.pill),
    `resolved card shows the "✓ Approved" pill, got "${after1.pill}" (${after1.pillResolution})`);
  await page.waitForFunction(
    () => !document.getElementById('in-app-banner')?.classList.contains('visible'),
    null, { timeout: 3_000, polling: 100 },
  );
  log('card Approve → approved pill, banner retired ✓');

  // ─── 2. Tray Approve flips the card too ───────────────────────────────
  const id2 = 'notif_card_tray';
  mock.pushEnvelope(approvalEnvelope(id2, 'tray flips card smoke'));
  await waitForCardState(page, id2, 'pending');
  await page.click('#btn-activity-drawer-rail');
  await page.waitForSelector(
    `#activity-drawer-panel .activity-drawer-item[data-activity-id="${id2}"] .activity-item-actions button`,
    { timeout: 3_000 },
  );
  await page.locator(
    `#activity-drawer-panel .activity-drawer-item[data-activity-id="${id2}"] .activity-item-actions button`,
    { hasText: 'Deny' },
  ).first().click();
  await waitForCardState(page, id2, 'denied');
  const after2 = await inspectCard(page, id2);
  assert(after2.buttons.length === 0 && after2.pillResolution === 'denied' && /Denied/.test(after2.pill),
    `tray Deny must flip the in-chat card to denied, got state=${after2.state} pill="${after2.pill}"`);
  // The first card must be untouched by the second decision.
  const first = await inspectCard(page, id1);
  assert(first.pillResolution === 'approved', `earlier card keeps its own outcome, got ${first.pillResolution}`);
  log('tray Deny → in-chat card denied ✓');
}
