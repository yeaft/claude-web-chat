import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fileRead from '../../../agent/yeaft/tools/file-read.js';

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('FileRead output budget', () => {
  it('returns small files in full', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-file-read-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'small.txt'), 'alpha\nbeta\n');

    await expect(fileRead.execute({ file_path: 'small.txt' }, { cwd: dir }))
      .resolves.toBe('1\talpha\n2\tbeta\n3\t');
  });

  it('stops on a UTF-8 byte boundary and returns the readable line range', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-file-read-'));
    tempDirs.push(dir);
    writeFileSync(
      join(dir, 'large.txt'),
      Array.from({ length: 200 }, (_, i) => `${i} ${'界'.repeat(100)}`).join('\n'),
    );

    const result = await fileRead.execute({ file_path: 'large.txt' }, { cwd: dir });

    expect(Buffer.byteLength(result, 'utf8')).toBeLessThan(32 * 1024);
    expect(result).toMatch(/\[Showing lines 1-\d+ of 200 total\]$/);
    expect(result).not.toContain('\ufffd');
  });
});
