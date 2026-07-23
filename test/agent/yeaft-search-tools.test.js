import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

let grepTool;
let globTool;
let setRipgrepAvailabilityForTests;
let moduleDir;
let dir;
let oldPath;

beforeAll(async () => {
  moduleDir = join(tmpdir(), `yeaft-search-modules-${process.pid}`);
  mkdirSync(moduleDir, { recursive: true });
  const typesUrl = new URL('../../agent/yeaft/tools/types.js', import.meta.url);
  const grepUrl = new URL('../../agent/yeaft/tools/grep.js', import.meta.url);
  const globUrl = new URL('../../agent/yeaft/tools/glob.js', import.meta.url);
  const stub = join(moduleDir, 'types.mjs');
  writeFileSync(stub, 'export const defineTool = definition => definition;\n');
  const rewrite = async (url, name) => {
    const target = join(moduleDir, name);
    const source = (await readFile(url, 'utf8')).replace("'./types.js'", "'./types.mjs'");
    writeFileSync(target, source);
    return import(`${new URL(`file://${target}`).href}?${Date.now()}`);
  };
  const grep = await rewrite(grepUrl, 'grep.mjs');
  grepTool = grep.default;
  setRipgrepAvailabilityForTests = grep.setRipgrepAvailabilityForTests;
  globTool = (await rewrite(globUrl, 'glob.mjs')).default;
});

afterAll(() => rmSync(moduleDir, { recursive: true, force: true }));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yeaft-search-'));
  oldPath = process.env.PATH;
  setRipgrepAvailabilityForTests(false);
});

afterEach(() => {
  setRipgrepAvailabilityForTests(undefined);
  process.env.PATH = oldPath;
  rmSync(dir, { recursive: true, force: true });
});

describe('Grep tool', () => {
  it('fallback honors fixed strings, glob and type filters and skips worktrees', async () => {
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, '.yeaft', 'worktrees', 'other'), { recursive: true });
    writeFileSync(join(dir, 'src', 'match.js'), 'literal.*value\n');
    writeFileSync(join(dir, 'src', 'regex.js'), 'literalZZvalue\n');
    writeFileSync(join(dir, 'src', 'match.txt'), 'literal.*value\n');
    writeFileSync(join(dir, '.yeaft', 'worktrees', 'other', 'hidden.js'), 'literal.*value\n');

    const result = await grepTool.execute({
      pattern: 'literal.*value', fixed_strings: true, output_mode: 'files_with_matches',
      glob: '**/*.js', type: 'js', head_limit: 10,
    }, { cwd: dir });

    expect(result).toBe('src/match.js');
  });

  it('rejects invalid head limits through the default execute path', async () => {
    writeFileSync(join(dir, 'many.js'), 'needle 1\nneedle 2\nneedle 3\n');

    expect(grepTool.parameters.properties.head_limit).toMatchObject({ type: 'integer', minimum: 1 });
    for (const headLimit of [-1, 0, 1.5]) {
      const result = await grepTool.execute({ pattern: 'needle', head_limit: headLimit }, { cwd: dir });
      expect(JSON.parse(result)).toEqual({ error: 'head_limit must be a positive integer' });
    }
  });

  it('fallback stops at the global result limit and UTF-8 byte budget', async () => {
    writeFileSync(join(dir, 'many.js'), Array.from({ length: 500 }, (_, i) => `needle ${i} ${'界'.repeat(100)}`).join('\n'));
    const limited = await grepTool.execute({ pattern: 'needle', output_mode: 'content', head_limit: 3 }, { cwd: dir });
    expect(limited.split('\n')).toHaveLength(3);

    const budgeted = await grepTool.execute({ pattern: 'needle', output_mode: 'content', head_limit: 500 }, { cwd: dir });
    expect(Buffer.byteLength(budgeted)).toBeLessThanOrEqual(32 * 1024);
    expect(Buffer.from(budgeted).toString('utf8')).toBe(budgeted);
  });

  it('caches ripgrep availability and passes -F without --max-count', async () => {
    const bin = join(dir, 'bin');
    const log = join(dir, 'rg.log');
    mkdirSync(bin);
    writeFileSync(join(bin, 'rg'), `#!/bin/sh\necho "$@" >> "${log}"\ncase "$1" in --version) exit 0;; esac\necho 'file.js:1:literal.*value'\n`);
    chmodSync(join(bin, 'rg'), 0o755);
    process.env.PATH = `${bin}:${oldPath}`;
    writeFileSync(join(dir, 'file.js'), 'literal.*value\n');
    setRipgrepAvailabilityForTests(undefined);

    await grepTool.execute({ pattern: 'literal.*value', fixed_strings: true, output_mode: 'content' }, { cwd: dir });
    await grepTool.execute({ pattern: 'literal.*value', fixed_strings: true, output_mode: 'content' }, { cwd: dir });

    const calls = (await readFile(log, 'utf8')).trim().split('\n');
    expect(calls.filter(line => line === '--version')).toHaveLength(1);
    expect(calls.slice(1).every(line => line.split(' ').includes('-F'))).toBe(true);
    expect(calls.slice(1).every(line => !line.includes('--max-count'))).toBe(true);
  });
});

describe('Glob tool', () => {
  it('rejects invalid limits and declares the public integer bound', async () => {
    writeFileSync(join(dir, 'match.js'), 'x');

    expect(globTool.parameters.properties.limit).toMatchObject({ type: 'integer', minimum: 1 });
    for (const limit of [-1, 0, 1.5]) {
      const result = await globTool.execute({ pattern: '*.js', limit }, { cwd: dir });
      expect(JSON.parse(result)).toEqual({ error: 'limit must be a positive integer' });
    }
  });

  it('sorts all matches by mtime and skips .yeaft/worktrees', async () => {
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, '.yeaft', 'worktrees', 'other'), { recursive: true });
    for (let i = 0; i < 5; i++) {
      const path = join(dir, 'src', `${i}.js`);
      writeFileSync(path, String(i));
      const time = new Date(1_700_000_000_000 + i * 1000);
      const { utimesSync } = await import('fs');
      utimesSync(path, time, time);
    }
    writeFileSync(join(dir, '.yeaft', 'worktrees', 'other', 'ignored.js'), 'x');

    const result = await globTool.execute({ pattern: '**/*.js', limit: 2 }, { cwd: dir });
    expect(result.split('\n')).toEqual(['src/4.js', 'src/3.js']);
    expect(result).not.toContain('ignored.js');
  });
});
