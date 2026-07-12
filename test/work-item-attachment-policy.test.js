import { describe, expect, it } from 'vitest';
import * as agentPolicy from '../agent/yeaft/work-center/attachment-policy.js';
import * as serverPolicy from '../server/work-item-attachment-policy.js';

const CASES = [
  ['screen.png', 'image/png', 'image'],
  ['photo.jpg', 'image/jpeg', 'image'],
  ['requirements.pdf', 'application/pdf', 'pdf'],
  ['notes.md', 'text/markdown', 'text'],
  ['config.json', 'application/json', 'text'],
  ['script.js', 'application/octet-stream', 'text'],
  ['payload.zip', 'text/plain', null],
  ['payload.exe', 'text/plain', null],
  ['fake.png', 'text/plain', null],
  ['fake.txt', 'image/png', null],
  ['requirements.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', null],
];

describe('Work Item attachment policy parity', () => {
  it('keeps Agent and Server limits identical', () => {
    for (const key of [
      'MAX_WORK_ITEM_ATTACHMENTS',
      'MAX_WORK_ITEM_ATTACHMENT_BYTES',
      'MAX_WORK_ITEM_INLINE_BYTES',
    ]) {
      expect(agentPolicy[key]).toBe(serverPolicy[key]);
    }
  });

  it.each(CASES)('classifies %s (%s) consistently', (name, mimeType, expected) => {
    expect(agentPolicy.classifyWorkItemAttachment(name, mimeType)).toBe(expected);
    expect(serverPolicy.classifyWorkItemAttachment(name, mimeType)).toBe(expected);
  });

  it('accepts exactly 10 MiB and rejects one additional byte in both packages', () => {
    const limit = 10 * 1024 * 1024;
    expect(() => agentPolicy.assertWorkItemAttachmentSize(limit)).not.toThrow();
    expect(() => serverPolicy.assertWorkItemAttachmentSize(limit)).not.toThrow();
    expect(() => agentPolicy.assertWorkItemAttachmentSize(limit + 1)).toThrow(/10485760/);
    expect(() => serverPolicy.assertWorkItemAttachmentSize(limit + 1)).toThrow(/10485760/);
  });
});
