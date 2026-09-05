import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseApprovalPrompt, approvalPreview } from './approvalText.ts';

const PROMPT =
  '⚠️ Dangerous command requires approval:\n\n' +
  'rm -rf /tmp/scratch\n' +
  'echo done\n\n' +
  'Reason: destructive file operation\n' +
  'Reply /approve to execute, /approve session to approve this pattern for the session, or /deny to cancel.';

describe('approvalText', () => {
  it('splits the gateway prompt into command + reason', () => {
    const p = parseApprovalPrompt(PROMPT);
    assert.equal(p.command, 'rm -rf /tmp/scratch\necho done');
    assert.equal(p.reason, 'destructive file operation');
  });

  it('skips leading metadata lines and separators', () => {
    const p = parseApprovalPrompt('session_id: abc\n---\n' + PROMPT);
    assert.equal(p.command, 'rm -rf /tmp/scratch\necho done');
  });

  it('unmatched text yields empty command and a raw preview', () => {
    assert.deepEqual(parseApprovalPrompt('hello'), { command: '', reason: '' });
    assert.equal(approvalPreview('hello'), 'hello');
  });

  it('preview joins reason and command', () => {
    assert.equal(approvalPreview(PROMPT), 'destructive file operation: rm -rf /tmp/scratch\necho done');
  });
});
