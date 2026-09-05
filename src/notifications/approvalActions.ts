/**
 * @fileoverview Tiny registry so any surface that renders an approval
 * (transcript card, Activity tray, in-app banner) can fire the same
 * Approve / Approve session / Deny action without importing the shell.
 * main.ts registers the real sender at boot (it needs drill + composer
 * + backend wiring); before that, actions are dropped with a log line.
 */

import { log } from '../util/log.ts';

export type ApprovalAction = 'approve' | 'approve_session' | 'deny';

export type ApprovalActionHandler = (
  chatId: string | null,
  action: ApprovalAction,
  msgId: string | null,
) => void | Promise<void>;

let handler: ApprovalActionHandler | null = null;

export function setApprovalActionHandler(h: ApprovalActionHandler | null): void {
  handler = h;
}

export function sendApprovalAction(
  chatId: string | null,
  action: ApprovalAction,
  msgId: string | null,
): void {
  if (!handler) {
    log(`[approval] no action handler registered — dropped ${action} for ${chatId ?? '∅'}`);
    return;
  }
  void handler(chatId, action, msgId);
}

export const APPROVAL_ACTION_LABELS: ReadonlyArray<readonly [string, ApprovalAction]> = [
  ['Approve', 'approve'],
  ['Approve session', 'approve_session'],
  ['Deny', 'deny'],
];

/** Clear-at-a-glance outcome labels. The Activity tray smokes assert on
 *  these exact strings (activity-approval-resolves-with-outcome etc.). */
export const APPROVAL_RESOLUTION_LABELS: Record<string, string> = {
  approved: '✓ Approved',
  approved_session: '✓ Approved (session)',
  denied: '✗ Denied',
  dismissed: 'Dismissed',
  stale: 'Stale',
};
