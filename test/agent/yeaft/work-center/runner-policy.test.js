import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkItemToolRegistry, parseStructuredResult } from '../../../../agent/yeaft/work-center/runner.js';

describe('Work Center tool policy', () => {
  let workDir;
  let outsideDir;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'yeaft-work-center-policy-'));
    outsideDir = mkdtempSync(join(tmpdir(), 'yeaft-work-center-outside-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('exposes only the explicit synchronous allowlist', () => {
    const registry = createWorkItemToolRegistry({ workDir, isRunActive: () => true });
    const names = registry.getAllTools().map(tool => tool.name);
    expect(names).toContain('FileRead');
    expect(names).toContain('Bash');
    expect(names).not.toContain('SpawnAgent');
    expect(names).not.toContain('RouteForward');
    expect(names).not.toContain('AskUser');
    expect(names).not.toContain('EnterWorktree');
  });

  it('rejects background or redirected Bash before execution', async () => {
    const registry = createWorkItemToolRegistry({ workDir, isRunActive: () => true });
    await expect(registry.execute('Bash', {
      command: 'echo nope', cwd: outsideDir, background: false,
    }, {})).rejects.toThrow(/cwd is fixed/);
    await expect(registry.execute('Bash', {
      command: 'echo nope', cwd: workDir, background: true,
    }, {})).rejects.toThrow(/background Bash/);
  });

  it('rejects lexical, patch, and symlink escapes', async () => {
    const registry = createWorkItemToolRegistry({ workDir, isRunActive: () => true });
    await expect(registry.execute('FileRead', { file_path: '../secret' }, {}))
      .rejects.toThrow(/escapes/);
    await expect(registry.execute('ApplyPatch', {
      patch: '--- a/file.txt\n+++ ../../secret.txt\n@@ -1 +1 @@\n-old\n+new\n',
    }, {})).rejects.toThrow(/escapes/);

    const safe = join(workDir, 'safe');
    mkdirSync(safe);
    symlinkSync(outsideDir, join(safe, 'link'));
    await expect(registry.execute('FileWrite', {
      file_path: join(safe, 'link', 'escaped.txt'), content: 'nope',
    }, {})).rejects.toThrow(/escapes/);
  });

  it('uses parsed patch targets and rejects tab, control, symlink-parent, and multi-file escapes', async () => {
    const registry = createWorkItemToolRegistry({ workDir, isRunActive: () => true });
    const escaped = join(outsideDir, 'escaped.txt');
    await expect(registry.execute('ApplyPatch', {
      patch: '--- a/safe.txt\n+++ ../escaped.txt\t\n@@ -0,0 +1 @@\n+escaped\n',
    }, {})).rejects.toThrow(/escapes/);
    expect(existsSync(escaped)).toBe(false);

    await expect(registry.execute('ApplyPatch', {
      patch: '--- a/safe.txt\n+++ safe\u0001.txt\n@@ -0,0 +1 @@\n+bad\n',
    }, {})).rejects.toThrow(/control characters/);

    const safe = join(workDir, 'safe');
    mkdirSync(safe);
    symlinkSync(outsideDir, join(safe, 'link'));
    await expect(registry.execute('ApplyPatch', {
      patch: '--- a/safe/link/escaped.txt\n+++ b/safe/link/escaped.txt\n@@ -0,0 +1 @@\n+bad\n',
    }, {})).rejects.toThrow(/escapes/);

    await expect(registry.execute('ApplyPatch', {
      patch: [
        '--- a/inside.txt', '+++ b/inside.txt', '@@ -0,0 +1 @@', '+inside',
        '--- a/other.txt', '+++ ../outside.txt\t', '@@ -0,0 +1 @@', '+outside', '',
      ].join('\n'),
    }, {})).rejects.toThrow(/escapes/);
    expect(existsSync(join(workDir, 'inside.txt'))).toBe(false);

    const result = JSON.parse(await registry.execute('ApplyPatch', {
      patch: '--- a/inside.txt\n+++ b/inside.txt\n@@ -0,0 +1 @@\n+inside\n',
    }, {}));
    expect(result.results[0].success).toBe(true);
    expect(readFileSync(join(workDir, 'inside.txt'), 'utf8')).toContain('inside');
  });

  it('fences execution after the Run loses its lease', async () => {
    const active = vi.fn().mockReturnValue(false);
    const registry = createWorkItemToolRegistry({ workDir, isRunActive: active });
    await expect(registry.execute('ListDir', { path: '.' }, {}))
      .rejects.toThrow(/lease is no longer active/);
  });

  it('does not interpret a missing review decision as approval', () => {
    const result = parseStructuredResult(JSON.stringify({
      outcome: 'completed', summary: 'looks fine', evidence: [],
    }), 'review');
    expect(result.outcome).toBe('failed');
    expect(result.reviewDecision).toBeNull();
    expect(result.error).toMatch(/requires approved/i);
  });
});
