import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildWorkItemAttachmentContext,
  persistWorkItemAttachments,
} from '../../../../agent/yeaft/work-center/attachments.js';

describe('Work Item attachment storage', () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('persists immutable attachment metadata and rebuilds Action context', () => {
    dir = mkdtempSync(join(tmpdir(), 'work-item-attachments-'));
    const root = join(dir, 'attachments');
    const workItemId = 'work-item-1';
    const stored = persistWorkItemAttachments([{
      name: '../Screenshot.png',
      mimeType: 'image/png',
      data: Buffer.from('png-bytes').toString('base64'),
      isImage: true,
    }, {
      name: 'notes.md',
      mimeType: 'text/markdown',
      data: Buffer.from('# Notes').toString('base64'),
    }], { root, workItemId });

    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({ name: 'Screenshot.png', size: 9, isImage: true });
    expect(stored[0]).not.toHaveProperty('data');
    expect(stored[0].sha256).toMatch(/^[a-f0-9]{64}$/);

    const context = buildWorkItemAttachmentContext({ id: workItemId, attachments: stored }, { root });
    expect(context.readRoots).toEqual([join(root, workItemId)]);
    expect(context.promptBlock).toContain('Screenshot.png');
    expect(context.promptBlock).toContain('notes.md');
    expect(context.promptBlock).toContain('work-item-attachment://');
    expect(context.promptBlock).not.toContain(join(root, workItemId));
    expect(context.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ ref: expect.stringMatching(/^work-item-attachment:\/\//), root: join(root, workItemId) }),
    ]));
    expect(context.promptParts).toEqual([expect.objectContaining({
      type: 'image',
      source: expect.objectContaining({ media_type: 'image/png', data: Buffer.from('png-bytes').toString('base64') }),
    })]);
    expect(readFileSync(join(root, workItemId, stored[1].storageName), 'utf8')).toBe('# Notes');
  });

  it('removes partial files when the attachment batch is invalid', () => {
    dir = mkdtempSync(join(tmpdir(), 'work-item-attachments-'));
    const root = join(dir, 'attachments');

    expect(() => persistWorkItemAttachments([{
      name: 'valid.txt', mimeType: 'text/plain', data: Buffer.from('valid').toString('base64'),
    }, {
      name: 'invalid.txt', mimeType: 'text/plain', data: 'not base64',
    }], { root, workItemId: 'work-item-2' })).toThrow(/base64/);
    expect(existsSync(join(root, 'work-item-2'))).toBe(false);
  });

  it('fails closed when persisted bytes or the owner directory identity changes', () => {
    dir = mkdtempSync(join(tmpdir(), 'work-item-attachments-'));
    const root = join(dir, 'attachments');
    const workItemId = 'work-item-3';
    const stored = persistWorkItemAttachments([{
      name: 'evidence.txt', mimeType: 'text/plain', data: Buffer.from('trusted').toString('base64'),
    }], { root, workItemId });
    const filePath = join(root, workItemId, stored[0].storageName);
    chmodSync(filePath, 0o600);
    writeFileSync(filePath, 'changed');
    expect(() => buildWorkItemAttachmentContext({ id: workItemId, attachments: stored }, { root }))
      .toThrow(/changed after creation/);

    rmSync(join(root, workItemId), { recursive: true, force: true });
    const outside = join(dir, 'outside');
    const moved = join(dir, 'moved');
    persistWorkItemAttachments([{
      name: 'evidence.txt', mimeType: 'text/plain', data: Buffer.from('trusted').toString('base64'),
    }], { root, workItemId });
    renameSync(join(root, workItemId), moved);
    symlinkSync(outside, join(root, workItemId));
    expect(() => buildWorkItemAttachmentContext({ id: workItemId, attachments: stored }, { root }))
      .toThrow();
  });
});
