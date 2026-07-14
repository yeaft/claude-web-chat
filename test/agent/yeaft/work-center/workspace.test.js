import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commitActionWorktree,
  createActionWorktree,
  inspectGitWorkspace,
  integrateActionWorktrees,
  removeActionWorktree,
} from '../../../../agent/yeaft/work-center/workspace.js';

const dirs = [];
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}
function repository() {
  const root = mkdtempSync(join(tmpdir(), 'work-center-workspace-'));
  dirs.push(root);
  git(['init'], root);
  git(['config', 'user.name', 'Test'], root);
  git(['config', 'user.email', 'test@example.com'], root);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  git(['add', '.'], root);
  git(['commit', '-m', 'base'], root);
  return root;
}
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

describe('Work Center Action workspaces', () => {
  it('falls back from isolation for non-Git and dirty repositories', () => {
    const plain = mkdtempSync(join(tmpdir(), 'work-center-plain-'));
    dirs.push(plain);
    expect(inspectGitWorkspace(plain)).toMatchObject({ git: false });
    const root = repository();
    writeFileSync(join(root, 'dirty.txt'), 'dirty');
    expect(createActionWorktree({
      workItem: { id: 'wi', workDir: root, workspaceKey: root },
      action: { id: 'a', stageId: 'implement' }, rootDir: join(root, '..', 'action-worktrees'),
    })).toMatchObject({ isolated: false, reason: 'dirty-worktree' });
  });

  it('commits isolated Action changes and integrates declared commits', () => {
    const root = repository();
    const rootDir = mkdtempSync(join(tmpdir(), 'work-center-action-worktrees-'));
    dirs.push(rootDir);
    const workspace = createActionWorktree({
      workItem: { id: 'wi', workDir: root, workspaceKey: root },
      action: { id: 'a', stageId: 'implement' }, rootDir,
    });
    writeFileSync(join(workspace.path, 'result.txt'), 'result\n');
    const committed = commitActionWorktree(workspace, { stageId: 'implement' });
    expect(committed).toMatchObject({ isolated: true, changed: true });
    removeActionWorktree(committed);
    const integration = integrateActionWorktrees({
      workDir: root,
      dependencies: [{ status: 'completed', workspace: committed }],
    });
    expect(integration.commits).toEqual([committed.commit]);
    expect(readFileSync(join(root, 'result.txt'), 'utf8')).toBe('result\n');
    expect(git(['branch', '--list', committed.branch], root)).toBe('');
  });

  it('integrates the real dependency DTO returned by WorkItemStore', async () => {
    const root = repository();
    const rootDir = mkdtempSync(join(tmpdir(), 'work-center-action-worktrees-'));
    dirs.push(rootDir);
    const dbDir = mkdtempSync(join(tmpdir(), 'work-center-integration-store-'));
    dirs.push(dbDir);
    const { WorkItemStore } = await import('../../../../agent/yeaft/work-center/store.js');
    const { WorkItemRunner } = await import('../../../../agent/yeaft/work-center/runner.js');
    const store = new WorkItemStore(join(dbDir, 'work-center.db'));
    try {
      const item = store.createWorkItem({
        id: 'integration-item', title: 'Integrate real DTO', goal: 'Integrate',
        acceptanceCriteria: [], workDir: root, workflowSnapshot: { executionMode: 'graph' },
      }, null);
      const workspace = createActionWorktree({
        workItem: item, action: { id: 'a', stageId: 'implement' }, runId: 'run', rootDir,
      });
      writeFileSync(join(workspace.path, 'result.txt'), 'result\n');
      const committed = commitActionWorktree(workspace, { stageId: 'implement' });
      removeActionWorktree(committed);
      store.createNextAction(item.id, {
        id: 'a', type: 'implement', stageId: 'implement', status: 'completed', workspace: committed,
      });
      store.createNextAction(item.id, {
        id: 'b', type: 'test', stageId: 'test', status: 'completed', workspaceMode: 'read',
      });
      const dependencies = store.listActionDependencies(item.id, ['implement', 'test']);
      expect(dependencies).toEqual([
        expect.objectContaining({ stageId: 'implement', status: 'completed' }),
        expect.objectContaining({ stageId: 'test', status: 'completed' }),
      ]);
      store.createNextAction(item.id, {
        id: 'integrate', type: 'integrate', stageId: 'integrate', status: 'ready',
        workspaceMode: 'integrate', dependsOnStageIds: ['implement', 'test'],
      });
      const runner = new WorkItemRunner({ store });
      const prepared = await runner.prepare({
        workItem: item,
        action: store.getAction('integrate'),
        run: { id: 'integration-run' },
      });
      expect(prepared.action.workspace.integration.commits).toEqual([committed.commit]);
      expect(readFileSync(join(root, 'result.txt'), 'utf8')).toBe('result\n');
      expect(existsSync(workspace.path)).toBe(false);
    } finally {
      store.close();
    }
  });

  it('rejects a real dependency DTO unless every Action completed', async () => {
    const root = repository();
    const dbDir = mkdtempSync(join(tmpdir(), 'work-center-integration-store-'));
    dirs.push(dbDir);
    const { WorkItemStore } = await import('../../../../agent/yeaft/work-center/store.js');
    const store = new WorkItemStore(join(dbDir, 'work-center.db'));
    try {
      const item = store.createWorkItem({
        id: 'incomplete-item', title: 'Reject incomplete DTO', goal: 'Reject',
        acceptanceCriteria: [], workDir: root, workflowSnapshot: { executionMode: 'graph' },
      }, null);
      store.createNextAction(item.id, { id: 'a', type: 'implement', stageId: 'implement', status: 'ready' });
      const dependencies = store.listActionDependencies(item.id, ['implement']);
      expect(() => integrateActionWorktrees({ workDir: root, dependencies })).toThrow(/every dependency Action/i);
    } finally {
      store.close();
    }
  });

  it('leaves the target repository unchanged when a later integration commit conflicts', () => {
    const root = repository();
    const rootDir = mkdtempSync(join(tmpdir(), 'work-center-action-worktrees-'));
    dirs.push(rootDir);
    const makeCommit = (id, value) => {
      const workspace = createActionWorktree({
        workItem: { id, workDir: root, workspaceKey: root },
        action: { id, stageId: id }, rootDir,
      });
      writeFileSync(join(workspace.path, 'base.txt'), `${value}\n`);
      return commitActionWorktree(workspace, { stageId: id });
    };
    const first = makeCommit('first', 'first');
    const conflicting = makeCommit('conflict', 'conflict');
    removeActionWorktree(first);
    removeActionWorktree(conflicting);
    const head = git(['rev-parse', 'HEAD'], root);
    const status = git(['status', '--porcelain', '--untracked-files=normal'], root);
    expect(() => integrateActionWorktrees({
      workDir: root,
      dependencies: [
        { status: 'completed', workspace: first },
        { status: 'completed', workspace: conflicting },
      ],
    })).toThrow(/could not integrate/i);
    expect(git(['rev-parse', 'HEAD'], root)).toBe(head);
    expect(git(['status', '--porcelain', '--untracked-files=normal'], root)).toBe(status);
    expect(readFileSync(join(root, 'base.txt'), 'utf8')).toBe('base\n');
  });
});
