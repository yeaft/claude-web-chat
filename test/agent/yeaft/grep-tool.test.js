import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { nodeGrep, runRipgrep } from '../../../agent/yeaft/tools/grep.js';

const tempDirs = [];

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'yeaft-grep-tool-'));
  tempDirs.push(dir);
  return dir;
}

async function runNodeGrep(cwd) {
  return nodeGrep('needle', cwd, {
    caseInsensitive: false,
    filesOnly: false,
    count: false,
    multiline: false,
    maxResults: 500,
  });
}

function fakeRipgrepOutput(stdout, { stderr = '', exitCode = 0 } = {}) {
  return () => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = () => queueMicrotask(() => proc.emit('close', null));
    queueMicrotask(() => {
      if (stdout) proc.stdout.write(stdout);
      if (stderr) proc.stderr.write(stderr);
      if (!proc.killed) proc.emit('close', exitCode);
    });
    const kill = proc.kill;
    proc.kill = () => {
      proc.killed = true;
      kill();
    };
    return proc;
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Grep tool output safety', () => {
  it('drops an incomplete UTF-8 code point when ripgrep output is truncated', async () => {
    const output = Buffer.concat([
      Buffer.alloc(512 * 1024 - 1, 0x61),
      Buffer.from('€', 'utf8'),
    ]);

    const result = await runRipgrep('needle', '.', {
      maxResults: 500,
    }, fakeRipgrepOutput(output));

    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(512 * 1024);
    expect(result).toContain('[Output truncated]');
    expect(result).not.toContain('\ufffd');
  });

  it('bounds invalid ripgrep stderr without breaking UTF-8', async () => {
    const stderr = Buffer.concat([
      Buffer.alloc(512 * 1024 - 1, 0x65),
      Buffer.from('€', 'utf8'),
    ]);

    const error = await runRipgrep('needle', '.', {
      maxResults: 500,
    }, fakeRipgrepOutput('', { stderr, exitCode: 2 })).catch((err) => err);

    expect(error).toBeInstanceOf(Error);
    expect(Buffer.byteLength(error.message, 'utf8')).toBeLessThanOrEqual(512 * 1024);
    expect(error.message).toContain('[Output truncated]');
    expect(error.message).not.toContain('\ufffd');
  });

  it('bounds invalid ripgrep stderr after UTF-8 decoding', async () => {
    const stderr = Buffer.alloc(512 * 1024, 0xff);

    const error = await runRipgrep('needle', '.', {
      maxResults: 500,
    }, fakeRipgrepOutput('', { stderr, exitCode: 2 })).catch((err) => err);

    expect(error).toBeInstanceOf(Error);
    expect(Buffer.byteLength(error.message, 'utf8')).toBeLessThanOrEqual(512 * 1024);
    expect(error.message).toContain('[Output truncated]');
    expect(error.message).not.toContain('\ufffd');
  });

  it('bounds invalid ripgrep stdout after UTF-8 decoding', async () => {
    const stdout = Buffer.alloc(512 * 1024, 0xff);

    const result = await runRipgrep('needle', '.', {
      maxResults: 500,
    }, fakeRipgrepOutput(stdout));

    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(512 * 1024);
    expect(result).toContain('[Output truncated]');
    expect(result).not.toContain('\ufffd');
  });

  it('shares the ripgrep byte budget between stdout and stderr', async () => {
    const stdout = Buffer.alloc(300 * 1024, 0x6f);
    const stderr = Buffer.alloc(300 * 1024, 0x65);

    const error = await runRipgrep('needle', '.', {
      maxResults: 500,
    }, fakeRipgrepOutput(stdout, { stderr, exitCode: 2 })).catch((err) => err);

    expect(error).toBeInstanceOf(Error);
    expect(Buffer.byteLength(error.message, 'utf8')).toBeLessThan(300 * 1024);
    expect(error.message).toContain('[Output truncated]');
    expect(error.message).not.toContain('\ufffd');
  });

  it('skips binary files even when their extension is unknown', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'payload-nul.data'), Buffer.from([
      0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01,
    ]));
    writeFileSync(join(dir, 'payload-invalid.data'), Buffer.from([
      0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0xff, 0xfe,
    ]));
    writeFileSync(join(dir, 'source.txt'), 'safe needle\n');

    const result = await runNodeGrep(dir);

    expect(result).toContain('source.txt:1:safe needle');
    expect(result).not.toContain('payload-nul.data');
    expect(result).not.toContain('payload-invalid.data');
    expect(result).not.toContain('\u0000');
    expect(result).not.toContain('\ufffd');
  });

  it('caps output bytes when one matching line is extremely large', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'large.txt'), `needle ${'x'.repeat(1024 * 1024 - 32)}\n`);

    const result = await runNodeGrep(dir);

    expect(Buffer.byteLength(result, 'utf8')).toBeLessThan(600 * 1024);
    expect(result).toContain('[Output truncated]');
  });

  it('normalizes CRLF output without leaking carriage returns', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'windows.txt'), 'first needle\r\nsecond needle\r\n');

    const result = await runNodeGrep(dir);

    expect(result).toContain('windows.txt:1:first needle');
    expect(result).toContain('windows.txt:2:second needle');
    expect(result).not.toContain('\r');
  });
});
