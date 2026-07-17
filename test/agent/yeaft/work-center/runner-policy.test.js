import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createWorkItemToolRegistry,
  parseStructuredResult,
  workItemToolPolicySnapshot,
  resolveWorkItemWorkDir,
  WorkItemRunner,
} from '../../../../agent/yeaft/work-center/runner.js';

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

  it('exposes layered Skills and lease-fenced MCP tools in the Work Center policy', async () => {
    let active = true;
    const mcpTool = {
      name: 'mcp__project__lookup',
      description: 'Lookup project data',
      parameters: { type: 'object', properties: {} },
      execute: vi.fn(async () => 'project result'),
    };
    const registry = createWorkItemToolRegistry({
      workDir,
      isRunActive: () => active,
      mcpTools: [mcpTool, { ...mcpTool, name: 'not_mcp' }],
    });
    expect(registry.getToolNames()).toEqual(expect.arrayContaining(['Skill', 'mcp__project__lookup']));
    expect(registry.getToolNames()).not.toContain('not_mcp');
    expect(workItemToolPolicySnapshot(workDir, [], ['mcp__project__lookup'])).toMatchObject({
      allowedToolNames: expect.arrayContaining(['Skill', 'mcp__project__lookup']),
      mcpTools: ['mcp__project__lookup'],
    });
    await expect(registry.execute('mcp__project__lookup', {}, {})).resolves.toBe('project result');
    active = false;
    await expect(registry.execute('mcp__project__lookup', {}, {})).rejects.toThrow(/lease/);
  });

  it('removes Bash from both registry and policy when attachments are present', async () => {
    const attachmentDir = join(outsideDir, 'attachments');
    mkdirSync(attachmentDir);
    const attachmentPath = join(attachmentDir, 'evidence.txt');
    writeFileSync(attachmentPath, 'evidence');
    const ref = 'work-item-attachment://attachment-1/evidence.txt';
    const registry = createWorkItemToolRegistry({
      workDir,
      attachmentFiles: [{ ref, path: attachmentPath, root: attachmentDir }],
      isRunActive: () => true,
    });
    expect(registry.getAllTools().map(tool => tool.name)).not.toContain('Bash');
    await expect(registry.execute('Bash', {
      command: `find ${JSON.stringify(attachmentDir)} -type f -delete`,
      cwd: workDir,
      background: false,
    }, {})).rejects.toThrow(/Unknown tool: Bash/);
    expect(readFileSync(attachmentPath, 'utf8')).toBe('evidence');
    expect(workItemToolPolicySnapshot(workDir, [ref])).toMatchObject({
      allowedToolNames: expect.not.arrayContaining(['Bash']),
      shell: { enabled: false },
    });
    expect(workItemToolPolicySnapshot(workDir, [])).toMatchObject({
      allowedToolNames: expect.arrayContaining(['Bash']),
      shell: { enabled: true },
    });
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

  it('rejects dangling symlink targets before FileWrite or ApplyPatch can create external files', async () => {
    const registry = createWorkItemToolRegistry({ workDir, isRunActive: () => true });
    const writeTarget = join(outsideDir, 'write-target.txt');
    const patchTarget = join(outsideDir, 'patch-target.txt');
    symlinkSync(writeTarget, join(workDir, 'write-link.txt'));
    symlinkSync(patchTarget, join(workDir, 'patch-link.txt'));

    await expect(registry.execute('FileWrite', {
      file_path: 'write-link.txt', content: 'outside',
    }, {})).rejects.toThrow(/symbolic link/);
    expect(existsSync(writeTarget)).toBe(false);

    await expect(registry.execute('ApplyPatch', {
      patch: '--- a/patch-link.txt\n+++ b/patch-link.txt\n@@ -0,0 +1 @@\n+outside\n',
    }, {})).rejects.toThrow(/symbolic link/);
    expect(existsSync(patchTarget)).toBe(false);
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

  it('maps attachment references only for read tools without exposing filesystem paths', async () => {
    const attachmentDir = join(outsideDir, 'attachments');
    mkdirSync(attachmentDir);
    const attachmentPath = join(attachmentDir, 'evidence.txt');
    const binaryPath = join(attachmentDir, 'screen.png');
    writeFileSync(attachmentPath, 'persistent evidence');
    writeFileSync(binaryPath, 'not-a-real-image');
    const ref = 'work-item-attachment://attachment-1/evidence.txt';
    const binaryRef = 'work-item-attachment://attachment-2/screen.png';
    const registry = createWorkItemToolRegistry({
      workDir,
      attachmentFiles: [
        { ref, path: attachmentPath, root: attachmentDir },
        { ref: binaryRef, path: binaryPath, root: attachmentDir },
      ],
      isRunActive: () => true,
    });

    const read = await registry.execute('FileRead', { file_path: ref }, {});
    expect(read).toContain('persistent evidence');
    await expect(registry.execute('FileWrite', { file_path: ref, content: 'changed' }, {}))
      .rejects.toThrow(/cannot modify/);
    expect(readFileSync(attachmentPath, 'utf8')).toBe('persistent evidence');
    const binaryError = await registry.execute('FileRead', { file_path: binaryRef }, {});
    expect(binaryError).toContain(binaryRef);
    expect(binaryError).not.toContain(attachmentDir);
    await expect(registry.execute('FileRead', { file_path: attachmentPath }, {}))
      .rejects.toThrow(/escapes/);
  });

  it('uses the creation-time workspace identity after a symlink is retargeted', () => {
    const projectA = join(workDir, 'project-a');
    const projectB = join(workDir, 'project-b');
    const alias = join(workDir, 'current');
    mkdirSync(projectA);
    mkdirSync(projectB);
    symlinkSync(projectA, alias);
    const workItem = { workDir: alias, workspaceKey: projectA };

    unlinkSync(alias);
    symlinkSync(projectB, alias);

    expect(resolveWorkItemWorkDir(workItem, outsideDir)).toBe(projectA);
    expect(() => resolveWorkItemWorkDir({ workDir: alias, workspaceKey: '' }, outsideDir))
      .toThrow(/canonical workspace identity/);
  });

  it('rejects when the persisted canonical workspace path is replaced by a symlink', () => {
    const projectA = join(workDir, 'canonical-project-a');
    const movedProjectA = join(workDir, 'moved-project-a');
    const projectB = join(workDir, 'canonical-project-b');
    mkdirSync(projectA);
    mkdirSync(projectB);
    renameSync(projectA, movedProjectA);
    symlinkSync(projectB, projectA);

    expect(() => resolveWorkItemWorkDir({ workDir: projectA, workspaceKey: projectA }, outsideDir))
      .toThrow(/canonical workspace identity changed/);
  });

  it('rejects a replaced canonical target before snapshots or adapter execution', async () => {
    const projectA = join(workDir, 'runner-canonical-a');
    const movedProjectA = join(workDir, 'runner-moved-a');
    const projectB = join(workDir, 'runner-canonical-b');
    mkdirSync(projectA);
    mkdirSync(projectB);
    renameSync(projectA, movedProjectA);
    symlinkSync(projectB, projectA);
    let adapterStarted = false;
    const setRunExecutionSnapshots = vi.fn();
    const runner = new WorkItemRunner({
      runtimeProvider: async () => ({
        defaultWorkDir: outsideDir,
        config: { model: 'provider/model', maxOutputTokens: 1_024 },
        adapter: {
          async *stream() {
            adapterStarted = true;
            yield { type: 'stop', stopReason: 'end_turn' };
          },
        },
      }),
      store: { isActiveRun: () => true, setRunExecutionSnapshots },
      registry: {
        getVp: () => ({ id: 'omni', name: 'Omni', role: 'developer', persona: '' }),
      },
    });

    await expect(runner.run({
      workItem: { workDir: projectA, workspaceKey: projectA },
      action: { type: 'triage', requiredRole: 'omni', instruction: 'Inspect workspace' },
      run: { id: 'run-replaced', leaseEpoch: 1 },
      signal: new AbortController().signal,
      ownerBootId: 'boot-a',
    })).rejects.toThrow(/canonical workspace identity changed/);
    expect(setRunExecutionSnapshots).not.toHaveBeenCalled();
    expect(adapterStarted).toBe(false);
  });

  it('rejects an explicit workDir without a canonical workspace identity', () => {
    expect(() => resolveWorkItemWorkDir({ workDir, workspaceKey: '' }, outsideDir))
      .toThrow(/canonical workspace identity/);
  });

  it('runs in the creation-time workspace after a symlink is retargeted', async () => {
    const projectA = join(workDir, 'run-project-a');
    const projectB = join(workDir, 'run-project-b');
    const alias = join(workDir, 'run-current');
    mkdirSync(projectA);
    mkdirSync(projectB);
    symlinkSync(projectA, alias);
    const prompts = [];
    let snapshots = null;
    const runner = new WorkItemRunner({
      runtimeProvider: async () => ({
        defaultWorkDir: outsideDir,
        config: { model: 'provider/model', maxOutputTokens: 1_024 },
        adapter: {
          async *stream(params) {
            prompts.push(params);
            yield {
              type: 'text_delta',
              text: JSON.stringify({
                outcome: 'completed', summary: 'done', evidence: ['workspace checked'], acceptanceChecks: [],
              }),
            };
            yield { type: 'stop', stopReason: 'end_turn' };
          },
        },
      }),
      store: {
        listCompletedRuns: () => [],
        isActiveRun: () => true,
        setRunExecutionSnapshots: (_runId, _ownerBootId, _leaseEpoch, value) => {
          snapshots = value;
          return true;
        },
      },
      registry: {
        getVp: () => ({ id: 'omni', name: 'Omni', role: 'developer', persona: '' }),
      },
    });
    unlinkSync(alias);
    symlinkSync(projectB, alias);

    await expect(runner.run({
      workItem: { workDir: alias, workspaceKey: projectA },
      action: { type: 'triage', requiredRole: 'omni', instruction: 'Inspect workspace' },
      run: { id: 'run-1', leaseEpoch: 1 },
      signal: new AbortController().signal,
      ownerBootId: 'boot-a',
    })).resolves.toMatchObject({ outcome: 'completed' });
    expect(prompts).toHaveLength(1);
    expect(snapshots.toolPolicySnapshot).toMatchObject({
      readRoots: [projectA],
      writeRoots: [projectA],
      shell: { fixedCwd: projectA },
    });
  });

  it('fences execution after the Run loses its lease', async () => {
    const active = vi.fn().mockReturnValue(false);
    const registry = createWorkItemToolRegistry({ workDir, isRunActive: active });
    await expect(registry.execute('ListDir', { path: '.' }, {}))
      .rejects.toThrow(/lease is no longer active/);
  });

  it('keeps model-selected evidence structured instead of exposing every tool call', () => {
    const result = parseStructuredResult(JSON.stringify({
      outcome: 'completed',
      summary: 'Implemented and verified',
      evidence: [{ kind: 'test', label: 'Focused tests', status: 'passed' }],
    }), 'implement');
    expect(result.evidence).toEqual([{ kind: 'test', label: 'Focused tests', status: 'passed' }]);
    expect(result.evidence).not.toContainEqual(expect.objectContaining({ kind: 'tool' }));
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
