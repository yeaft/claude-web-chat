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





  it('keeps Work Center Engine config outside Agent Plugins and fences tools after lease loss', async () => {
    const runtimeConfig = {
      model: 'provider/model',
      maxOutputTokens: 1_024,
      projectDocMaxBytes: 0,
      plugins: { tools: [] },
    };
    const capturedRequests = [];
    const runner = new WorkItemRunner({
      runtimeProvider: async () => ({
        defaultWorkDir: workDir,
        config: runtimeConfig,
        adapter: {
          async *stream(request) {
            capturedRequests.push(request);
            yield { type: 'text_delta', text: JSON.stringify({
              outcome: 'completed', summary: 'Plan submitted', evidence: ['planner evidence'],
            }) };
            yield { type: 'stop', stopReason: 'end_turn' };
          },
        },
      }),
      store: {
        listCompletedRuns: () => [],
        isActiveRun: () => true,
        setRunExecutionSnapshots: vi.fn(() => true),
        closeRunInput: () => true,
        listPendingActionInputs: () => [],
      },
      registry: {
        listVps: () => [{ id: 'omni', name: 'Omni', role: 'developer', persona: '' }],
        getVp: () => ({ id: 'omni', name: 'Omni', role: 'developer', persona: '' }),
      },
    });
    const workItem = {
      id: 'plugin-isolation',
      title: 'Plan despite an explicit empty tool allowlist',
      goal: 'Keep Work Center control-plane planning outside the MVP policy boundary',
      acceptanceCriteria: ['The plan tool remains available'],
      planRevision: 0,
      workflowSnapshot: { planningMode: 'ai', executionMode: 'graph', globalInstructions: '' },
    };
    const action = {
      id: 'triage-action', stageId: 'triage', type: 'triage', requiredRole: 'omni',
      instruction: 'Plan the WorkItem.', assignmentPolicy: { mode: 'fixed', fixedVpId: 'omni' },
      modelPolicy: { mode: 'inherit' }, workspaceMode: 'read', context: [], maxAttempts: 2,
    };
    const run = { id: 'plugin-isolation-run', leaseEpoch: 1 };

    const result = await runner.run({
      workItem,
      action,
      run,
      signal: new AbortController().signal,
      ownerBootId: 'plugin-isolation-boot',
    });

    expect(runtimeConfig).toEqual(expect.objectContaining({ plugins: { tools: [] } }));
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].tools.map(tool => tool.name)).toContain('SubmitWorkItemPlan');
    expect(result).toMatchObject({ outcome: 'completed', summary: 'Plan submitted' });

    const active = vi.fn().mockReturnValue(false);
    const registry = createWorkItemToolRegistry({ workDir, isRunActive: active });
    await expect(registry.execute('ListDir', { path: '.' }, {}))
      .rejects.toThrow(/lease is no longer active/);
  });




});
