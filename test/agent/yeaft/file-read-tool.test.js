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
    expect(result).toMatch(/\[Showing lines 1-\d+ of 200 total\. Continue with offset=\d+(?:, column_offset=\d+)?\.\]$/);
    expect(result).not.toContain('\ufffd');
  });

  it.each([
    ['offset', { offset: 0.5 }, 'offset must be a non-negative integer'],
    ['negative offset', { offset: -1 }, 'offset must be a non-negative integer'],
    ['column offset', { column_offset: 0.5 }, 'column_offset must be a non-negative integer'],
    ['negative column offset', { column_offset: -1 }, 'column_offset must be a non-negative integer'],
    ['zero limit', { limit: 0 }, 'limit must be a positive integer'],
    ['negative limit', { limit: -1 }, 'limit must be a positive integer'],
    ['fractional limit', { limit: 1.5 }, 'limit must be a positive integer'],
  ])('rejects invalid %s values', async (_kind, input, message) => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-file-read-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'small.txt'), 'alpha\nbeta');

    const result = await fileRead.execute({ file_path: 'small.txt', ...input }, { cwd: dir });

    expect(JSON.parse(result)).toEqual({ error: message });
  });

  it('defines stable at-EOF and beyond-EOF results', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-file-read-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'small.txt'), 'alpha\nbeta');

    await expect(fileRead.execute({ file_path: 'small.txt', offset: 2 }, { cwd: dir }))
      .resolves.toBe('[Offset 2 is at end of file (2 lines total).]');
    const beyond = await fileRead.execute({ file_path: 'small.txt', offset: 3 }, { cwd: dir });
    expect(JSON.parse(beyond)).toEqual({ error: 'offset 3 exceeds file length (2 lines)' });
  });

  it('declares integer parameter bounds in its public schema', () => {
    expect(fileRead.parameters.properties.offset).toMatchObject({ type: 'integer', minimum: 0 });
    expect(fileRead.parameters.properties.column_offset).toMatchObject({ type: 'integer', minimum: 0 });
    expect(fileRead.parameters.properties.limit).toMatchObject({ type: 'integer', minimum: 1 });
  });

  it.each([
    ['ASCII', 'x'.repeat(40 * 1024) + 'END'],
    ['multibyte', '界'.repeat(14 * 1024) + 'END'],
  ])('continues within one oversized %s line without skipping content', async (_kind, line) => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-file-read-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'oversized.txt'), `${line}\nSECOND`);

    const first = await fileRead.execute({ file_path: 'oversized.txt' }, { cwd: dir });
    const match = first.match(/Continue with offset=(\d+), column_offset=(\d+)\./);
    expect(match).not.toBeNull();
    expect(first).not.toContain('END');
    const second = await fileRead.execute({ file_path: 'oversized.txt', offset: Number(match[1]), column_offset: Number(match[2]) }, { cwd: dir });
    expect(second).toContain('END');
    expect(second).toContain('2\tSECOND');
    expect(first + second).not.toContain('\ufffd');
  });

  it.each([
    ['ASCII', 'x'.repeat(40 * 1024) + 'END'],
    ['multibyte', '界'.repeat(14 * 1024) + 'END'],
  ])('terminates after consuming one oversized %s line without a trailing newline', async (_kind, line) => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-file-read-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'oversized.txt'), line);

    let input = { file_path: 'oversized.txt' };
    let previousCursor = null;
    let result;
    for (let reads = 0; reads < 10; reads += 1) {
      result = await fileRead.execute(input, { cwd: dir });
      const match = result.match(/Continue with offset=(\d+)(?:, column_offset=(\d+))?\./);
      if (!match) break;
      const cursor = `${match[1]}:${match[2] || 0}`;
      expect(cursor).not.toBe(previousCursor);
      previousCursor = cursor;
      input = {
        file_path: 'oversized.txt',
        offset: Number(match[1]),
        column_offset: Number(match[2] || 0),
      };
    }

    expect(result).toContain('END');
    expect(result).not.toContain('Continue with offset=');
    expect(result).not.toContain('\ufffd');
  });

});
