import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import grepTool, { nodeGrep, runRipgrep } from '../../../agent/yeaft/tools/grep.js';

const tempDirs = [];
const originalPath = process.env.PATH;

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
  process.env.PATH = originalPath;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeRipgrepChunks(chunks, { stderr = '', exitCode = 0, emitErrorAfterKill = false } = {}) {
  const state = { kills: 0, closes: 0 };
  const spawnProcess = () => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = () => {
      state.kills += 1;
      queueMicrotask(() => {
        if (emitErrorAfterKill) proc.emit('error', new Error('late kill error'));
        state.closes += 1;
        proc.emit('close', null);
      });
    };
    queueMicrotask(() => {
      for (const chunk of chunks) proc.stdout.write(chunk);
      if (stderr) proc.stderr.write(stderr);
      if (state.kills === 0) {
        state.closes += 1;
        proc.emit('close', exitCode);
      }
    });
    return proc;
  };
  return { spawnProcess, state };
}

describe('Grep tool output safety', () => {
  it.each([
    ['one chunk', [Buffer.alloc(100 * 1024, 0x61)]],
    ['multiple chunks', [Buffer.alloc(20 * 1024, 0x61), Buffer.alloc(20 * 1024, 0x62)]],
  ])('kills ripgrep when stdout crosses the 32 KiB budget in %s', async (_kind, chunks) => {
    const { spawnProcess, state } = fakeRipgrepChunks(chunks);
    const result = await runRipgrep('needle', '.', {
      maxResults: 10000,
      byteBudget: 32 * 1024,
    }, spawnProcess);

    expect(state.kills).toBe(1);
    expect(state.closes).toBe(1);
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(result).toContain('[Output truncated]');
  });

  it('truncates ripgrep stdout on a UTF-8 boundary within the 32 KiB budget', async () => {
    const { spawnProcess, state } = fakeRipgrepChunks([Buffer.from('界'.repeat(12 * 1024))]);
    const result = await runRipgrep('needle', '.', {
      maxResults: 10000,
      byteBudget: 32 * 1024,
    }, spawnProcess);

    expect(state.kills).toBe(1);
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(result).toContain('[Output truncated]');
    expect(result).not.toContain('\ufffd');
  });

  it('waits for close and settles once when kill also emits a late error', async () => {
    const { spawnProcess, state } = fakeRipgrepChunks(
      [Buffer.alloc(100 * 1024, 0x61)],
      { emitErrorAfterKill: true },
    );
    const result = await runRipgrep('needle', '.', {
      maxResults: 10000,
      byteBudget: 32 * 1024,
    }, spawnProcess);

    expect(state.kills).toBe(1);
    expect(state.closes).toBe(1);
    expect(result).toContain('[Output truncated]');
  });

  it('keeps stderr on an independent error budget', async () => {
    const stderr = Buffer.alloc(100 * 1024, 0x65);
    const { spawnProcess, state } = fakeRipgrepChunks([], { stderr, exitCode: 2 });
    const error = await runRipgrep('needle', '.', {
      maxResults: 10000,
      byteBudget: 32 * 1024,
    }, spawnProcess).catch(err => err);

    expect(state.kills).toBe(0);
    expect(error).toBeInstanceOf(Error);
    expect(Buffer.byteLength(error.message, 'utf8')).toBe(100 * 1024);
  });

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

  it('enforces the byte budget after the Grep error envelope is serialized', async () => {
    const binDir = makeTempDir();
    const searchDir = makeTempDir();
    const rgPath = join(binDir, 'rg');
    writeFileSync(rgPath, `#!/usr/bin/env node
if (process.argv.includes('--version')) process.exit(0);
process.stderr.write('e'.repeat(512 * 1024));
process.exitCode = 2;
`);
    chmodSync(rgPath, 0o755);
    process.env.PATH = `${binDir}:${originalPath}`;

    const result = await grepTool.execute({ pattern: 'needle' }, { cwd: searchDir });
    const payload = JSON.parse(result);

    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(512 * 1024);
    expect(payload.error).toMatch(/^Grep failed: /);
    expect(payload.error).toContain('[Output truncated]');
    expect(payload.error).not.toContain('\ufffd');
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

  it('keeps stderr on an independent bounded error budget', async () => {
    const stdout = Buffer.alloc(300 * 1024, 0x6f);
    const stderr = Buffer.alloc(300 * 1024, 0x65);

    const error = await runRipgrep('needle', '.', {
      maxResults: 500,
    }, fakeRipgrepOutput(stdout, { stderr, exitCode: 2 })).catch((err) => err);

    expect(error).toBeInstanceOf(Error);
    expect(Buffer.byteLength(error.message, 'utf8')).toBe(300 * 1024);
    expect(error.message).not.toContain('[Output truncated]');
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

    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(512 * 1024);
    expect(result).toContain('[Output truncated]');
    expect(result).not.toContain('\ufffd');
  });

  it('includes the fallback truncation marker inside the UTF-8 byte budget', async () => {
    const dir = makeTempDir();
    const line = `needle ${'界'.repeat(5400)}`;
    writeFileSync(join(dir, 'many-lines.txt'), `${Array(40).fill(line).join('\n')}\n`);

    const result = await runNodeGrep(dir);

    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(512 * 1024);
    expect(result).toContain('[Output truncated]');
    expect(result).not.toContain('\ufffd');
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
