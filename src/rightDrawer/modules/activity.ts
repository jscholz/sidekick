import type { RightDrawerModule, RightDrawerModuleContext } from '../host.ts';
import { miniMarkdown } from '../../util/markdown.ts';
import { approvalPreview } from '../../notifications/approvalText.ts';
import {
  clearDismissible as clearDismissibleActivity,
  dismissActivity,
  listActivity,
  refreshFromServer,
  markRead,
  type ActivityItem,
} from '../../notifications/activityStore.ts';
import { chatLabelFor, formatRelativeTime } from './common.ts';

export type ActivityOpenHandler = (chatId: string, msgId: string | null) => boolean | Promise<boolean | void> | void;
export type ApprovalActionHandler = (chatId: string, action: 'approve' | 'approve_session' | 'deny', msgId: string | null) => void | Promise<void>;

export function createActivityModule(opts: {
  panel: HTMLElement;
  list: HTMLElement;
  empty: HTMLElement;
  onOpen?: ActivityOpenHandler | null;
  onApprovalAction?: ApprovalActionHandler | null;
  onSelect?: () => void;
}): RightDrawerModule {
  const render = (ctx: RightDrawerModuleContext) => {
    void refreshFromServer();
    const items = listActivity();
    opts.list.innerHTML = '';
    const clearable = items.some((item) => item.kind !== 'approval' || !!item.resolved);
    if (ctx.clearButton) {
      ctx.clearButton.hidden = !clearable;
      ctx.clearButton.textContent = 'Clear';
      ctx.clearButton.setAttribute('aria-label', 'Clear activity');
      ctx.clearButton.setAttribute('title', 'Clear activity');
    }
    if (items.length === 0) {
      opts.empty.hidden = false;
      opts.list.hidden = true;
      return;
    }
    opts.empty.hidden = true;
    opts.list.hidden = false;
    for (const item of items) opts.list.appendChild(renderActivityItem(item, opts));
  };
  return {
    id: 'activity',
    title: 'Activity',
    panel: opts.panel,
    toggleIds: ['btn-activity-drawer-rail'],
    render,
    onClear: () => { clearDismissibleActivity(); },
    onSelect: () => { opts.onSelect?.(); },
  };
}

function renderActivityItem(item: ActivityItem, opts: {
  onOpen?: ActivityOpenHandler | null;
  onApprovalAction?: ApprovalActionHandler | null;
}): HTMLElement {
  const li = document.createElement('li');
  li.className = 'activity-drawer-item';
  li.classList.toggle('activity-approval', item.kind === 'approval');
  li.classList.toggle('activity-unread', !item.read && !item.resolved);
  li.classList.toggle('activity-resolved', !!item.resolved);
  li.dataset.activityId = item.id;

  const meta = document.createElement('div');
  meta.className = 'activity-item-meta';
  const title = document.createElement('span');
  title.className = 'activity-item-title';
  title.textContent = item.title;
  const when = document.createElement('span');
  when.className = 'activity-item-time';
  when.textContent = formatRelativeTime(item.createdAt);
  when.title = new Date(item.createdAt).toLocaleString();
  const state = document.createElement('span');
  state.className = 'activity-item-read-state';
  state.textContent = item.kind === 'approval' && !item.resolved
    ? 'Action needed'
    : (!item.read && !item.resolved ? 'New' : 'Read');
  meta.appendChild(title);
  meta.appendChild(state);
  meta.appendChild(when);

  const body = document.createElement('div');
  body.className = 'activity-item-body';
  body.innerHTML = miniMarkdown(activityPreview(item));
  li.appendChild(meta);
  li.appendChild(body);

  if (item.kind === 'approval' && !item.resolved && item.chatId) {
    const actions = document.createElement('div');
    actions.className = 'activity-item-actions';
    for (const [label, action] of [['Approve', 'approve'], ['Session', 'approve_session'], ['Deny', 'deny']] as const) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.onclick = (e) => {
        e.stopPropagation();
        // Don't locally dismiss — the user_message echo from sending the
        // slash command flows through backendEvents.handleUserMessage,
        // which calls resolveApprovalsForChat with the right outcome.
        // The row STAYS in the tray, just transitions to resolved with
        // the outcome pill (a3177a3's local-dismiss tightening reversed,
        // 2026-05-28).
        void opts.onApprovalAction?.(item.chatId!, action, item.messageId || null);
      };
      actions.appendChild(btn);
    }
    li.appendChild(actions);
  } else if (item.resolved) {
    const state = document.createElement('div');
    state.className = 'activity-item-state';
    state.dataset.resolution = item.resolved;
    // Clear-at-a-glance pill labels — these are the strings the user
    // reads in the tray to know "what happened to this approval." The
    // smokes (activity-approval-resolves-with-outcome,
    // -auto-dismisses-on-real-reply, -stale-auto-dismiss) assert on the
    // exact text; if changed, update those too.
    const LABELS: Record<string, string> = {
      approved: '✓ Approved',
      approved_session: '✓ Approved (session)',
      denied: '✗ Denied',
      dismissed: 'Dismissed',
      stale: 'Stale',
    };
    state.textContent = LABELS[item.resolved] || item.resolved.replace('_', ' ');
    li.appendChild(state);
  }

  const footer = document.createElement('div');
  footer.className = 'activity-item-footer';
  const chat = document.createElement('span');
  chat.className = 'pin-item-chat';
  chat.textContent = item.chatId ? chatLabelFor(item.chatId) : 'No chat';
  const dismiss = document.createElement('button');
  dismiss.className = 'pin-item-unpin-btn';
  dismiss.type = 'button';
  dismiss.title = 'Dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss activity');
  dismiss.textContent = 'x';
  dismiss.onclick = (e) => { e.stopPropagation(); dismissActivity(item.id); };
  footer.appendChild(chat);
  footer.appendChild(dismiss);
  li.appendChild(footer);

  li.onclick = () => {
    markRead(item.id);
    if (item.chatId && opts.onOpen) {
      void Promise.resolve(opts.onOpen(item.chatId, item.messageId || null))
        .then((ok) => { if (ok === false) dismissActivity(item.id); });
    }
  };
  return li;
}

function activityPreview(item: ActivityItem): string {
  let body = item.body || '';
  if (item.kind === 'approval') body = approvalPreview(body);
  else if (item.kind === 'cron') {
    const headerRe = /^Cronjob Response:\s*(.+?)\s*\n\(job_id:\s*([^)]+)\)\s*\n-+\s*\n+([\s\S]*?)(?:\n+To stop or manage this job[^\n]*\.?\s*)?$/;
    const m = headerRe.exec(body);
    if (m) body = m[1].trim() + ': ' + m[3].trim();
  }
  return body.length > 500 ? body.slice(0, 497) + '...' : body;
}

