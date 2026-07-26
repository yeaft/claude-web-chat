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





  it('fences execution after the Run loses its lease', async () => {
    const active = vi.fn().mockReturnValue(false);
    const registry = createWorkItemToolRegistry({ workDir, isRunActive: active });
    await expect(registry.execute('ListDir', { path: '.' }, {}))
      .rejects.toThrow(/lease is no longer active/);
  });




});
