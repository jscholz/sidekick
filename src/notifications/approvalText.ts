/**
 * @fileoverview Hermes approval-prompt parsing shared by every surface
 * that renders one (transcript card, in-app banner, Activity tray).
 *
 * The gateway's prompt has a fixed shape:
 *
 *     ⚠️ Dangerous command requires approval:
 *
 *     <command, possibly multi-line>
 *
 *     Reason: <why the gate fired>
 *     Reply /approve to execute, /approve session to …, or /deny to cancel.
 *
 * Some producers prefix metadata lines (session_id: …) — stripped first.
 */

export interface ApprovalPrompt {
  /** The gated command, trimmed; '' when the prompt didn't match. */
  command: string;
  /** The "Reason:" line body, '' when absent. */
  reason: string;
}

const META_LINE_RE = /^\s*(?:session_id|job_id|chat_id|message_id|user_id|run_id|trace_id)\s*:\s*\S/i;
const SEP_OR_BLANK_RE = /^\s*(?:-{3,}|=+|\*+)?\s*$/;

export function stripLeadingMetadata(s: string): string {
  const lines = (s || '').split('\n');
  let i = 0;
  while (i < lines.length && (META_LINE_RE.test(lines[i]) || SEP_OR_BLANK_RE.test(lines[i]))) i++;
  return lines.slice(i).join('\n');
}

export function parseApprovalPrompt(raw: string): ApprovalPrompt {
  const text = stripLeadingMetadata(raw || '');
  const reason = /^Reason:\s*(.+)$/im.exec(text)?.[1]?.trim() || '';
  const lines = text.split('\n');
  const command: string[] = [];
  let inCommand = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/Dangerous command requires approval/i.test(trimmed)) {
      inCommand = true;
      continue;
    }
    if (!inCommand) continue;
    if (!trimmed) {
      if (command.length) command.push('');
      continue;
    }
    if (/^Reason:/i.test(trimmed) || /^Reply\s+\/approve/i.test(trimmed)) break;
    command.push(line.replace(/\s+$/, ''));
  }
  return {
    command: command.join('\n').trim().replace(/\n{3,}/g, '\n\n'),
    reason,
  };
}

/** One-line preview for banner / tray rows: "reason: command", falling
 *  back to whichever half exists, then the raw text. */
export function approvalPreview(raw: string): string {
  const { command, reason } = parseApprovalPrompt(raw);
  if (reason && command) return `${reason}: ${command}`;
  return reason || command || stripLeadingMetadata(raw || '');
}
