import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import grepTool from '../../../agent/yeaft/tools/grep.js';

const tempDirs = [];

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'yeaft-grep-tool-'));
  tempDirs.push(dir);
  return dir;
}

async function runGrep(cwd, input = {}) {
  return grepTool.execute({
    pattern: 'needle',
    output_mode: 'content',
    ...input,
  }, { cwd });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Grep tool output safety', () => {
  it('skips binary files even when their extension is unknown', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'payload-nul.data'), Buffer.from([
      0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01,
    ]));
    writeFileSync(join(dir, 'payload-invalid.data'), Buffer.from([
      0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0xff, 0xfe,
    ]));
    writeFileSync(join(dir, 'source.txt'), 'safe needle\n');

    const result = await runGrep(dir);

    expect(result).toContain('source.txt:1:safe needle');
    expect(result).not.toContain('payload-nul.data');
    expect(result).not.toContain('payload-invalid.data');
    expect(result).not.toContain('\u0000');
    expect(result).not.toContain('\ufffd');
  });

  it('caps output bytes when one matching line is extremely large', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'large.txt'), `needle ${'x'.repeat(1024 * 1024 - 32)}\n`);

    const result = await runGrep(dir);

    expect(Buffer.byteLength(result, 'utf8')).toBeLessThan(600 * 1024);
    expect(result).toContain('[Output truncated]');
  });

  it('normalizes CRLF output without leaking carriage returns', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'windows.txt'), 'first needle\r\nsecond needle\r\n');

    const result = await runGrep(dir);

    expect(result).toContain('windows.txt:1:first needle');
    expect(result).toContain('windows.txt:2:second needle');
    expect(result).not.toContain('\r');
  });
});
