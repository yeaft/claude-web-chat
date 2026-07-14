import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  commitActionWorktree,
  createActionWorktree,
  inspectGitWorkspace,
  integrateActionWorktrees,
  prepareActionIntegration,
  removeActionWorktree,
} from '../../../../agent/yeaft/work-center/workspace.js';
import { WorkflowController } from '../../../../agent/yeaft/work-center/controller.js';
import { WorkItemRunner } from '../../../../agent/yeaft/work-center/runner.js';
import { WorkItemStore } from '../../../../agent/yeaft/work-center/store.js';

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

function integrationFixture() {
  const root = repository();
  const rootDir = mkdtempSync(join(tmpdir(), 'work-center-action-worktrees-'));
  const dbDir = mkdtempSync(join(tmpdir(), 'work-center-integration-store-'));
  dirs.push(rootDir, dbDir);
  const store = new WorkItemStore(join(dbDir, 'work-center.db'));
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
    id: 'integrate', type: 'integrate', stageId: 'integrate', status: 'ready',
    workspaceMode: 'integrate', dependsOnStageIds: ['implement'],
  });
  return { root, store, item, committed };
}

function integrationResources(root) {
  return {
    worktrees: git(['worktree', 'list', '--porcelain'], root),
    branches: git(['branch', '--list', 'yeaft-work/*'], root),
  };
}

function claimIntegration(store, itemId, ownerBootId = 'boot') {
  store.db.prepare(`UPDATE work_items SET status = 'ready', current_action_id = 'integrate',
    current_run_id = NULL WHERE id = ?`).run(itemId);
  const claim = store.claimReadyAction(ownerBootId, 60_000);
  if (!claim || claim.action.id !== 'integrate') throw new Error('Integration Action was not claimable');
  return { ...claim, ownerBootId };
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
    const { root, store, item, committed } = integrationFixture();
    const claim = claimIntegration(store, item.id);
    const runner = new WorkItemRunner({ store });
    try {
      const prepared = await runner.prepare(claim);
      expect(prepared.action.workspace.integration).toMatchObject({
        status: 'finalized', commits: [committed.commit],
      });
      expect(readFileSync(join(root, 'result.txt'), 'utf8')).toBe('result\n');
    } finally {
      store.close();
    }
  });

  it.each([
    ['throws', () => { throw new Error('sqlite write failed'); }, /sqlite write failed/],
    ['returns null', () => null, /lost its Run lease/],
  ])('leaves target and refs unchanged when fenced ownership %s', async (
    _case, ownershipResult, expectedError,
  ) => {
    const { root, store, item, committed } = integrationFixture();
    const claim = claimIntegration(store, item.id);
    const originalHead = git(['rev-parse', 'HEAD'], root);
    const originalResources = integrationResources(root);
    store.setIntegrationWorkspaceForRun = vi.fn(ownershipResult);
    const runner = new WorkItemRunner({ store });
    try {
      await expect(runner.prepare(claim)).rejects.toThrow(expectedError);
      expect(git(['rev-parse', 'HEAD'], root)).toBe(originalHead);
      expect(existsSync(join(root, 'result.txt'))).toBe(false);
      expect(git(['status', '--porcelain', '--untracked-files=normal'], root)).toBe('');
      expect(integrationResources(root)).toEqual(originalResources);
      expect(git(['branch', '--list', committed.branch], root)).toBe(committed.branch);
      expect(store.getAction('integrate')).toMatchObject({ status: 'running', workspace: null });
    } finally {
      store.close();
    }
  });

  it('rolls back prepared ownership when the Git target fails CAS', async () => {
    const { root, store, item, committed } = integrationFixture();
    const claim = claimIntegration(store, item.id);
    const originalAcquire = store.acquireIntegrationFinalization.bind(store);
    let preparedIntegration;
    store.acquireIntegrationFinalization = vi.fn((...args) => {
      const acquired = originalAcquire(...args);
      preparedIntegration = acquired.action.workspace.integration;
      writeFileSync(join(root, 'external.txt'), 'external change\n');
      git(['add', '.'], root);
      git(['commit', '-m', 'external change'], root);
      return acquired;
    });
    const runner = new WorkItemRunner({ store });
    try {
      await expect(runner.prepare(claim)).rejects.toThrow(/target changed before finalization/);
      expect(store.getAction('integrate')).toMatchObject({ workspaceMode: 'integrate', workspace: null });
      expect(git(['worktree', 'list', '--porcelain'], root)).not.toContain(preparedIntegration.temporaryPath);
      expect(git(['branch', '--list', preparedIntegration.temporaryBranch], root)).toBe('');
      expect(git(['branch', '--list', committed.branch], root)).toContain(committed.branch);
      expect(existsSync(join(root, 'result.txt'))).toBe(false);
    } finally {
      store.close();
    }
  });

  it('retains prepared ownership when Git CAS and fenced rollback both fail', async () => {
    const { root, store, item, committed } = integrationFixture();
    const claim = claimIntegration(store, item.id);
    const originalAcquire = store.acquireIntegrationFinalization.bind(store);
    store.acquireIntegrationFinalization = vi.fn((...args) => {
      const acquired = originalAcquire(...args);
      writeFileSync(join(root, 'external.txt'), 'external change\n');
      git(['add', '.'], root);
      git(['commit', '-m', 'external change'], root);
      return acquired;
    });
    store.rollbackIntegrationFinalization = vi.fn(() => null);
    const runner = new WorkItemRunner({ store });
    try {
      await expect(runner.prepare(claim)).rejects.toMatchObject({ workItemPrepareRetryable: true });
      const persisted = store.getAction('integrate').workspace.integration;
      expect(persisted).toMatchObject({
        status: 'prepared', reservation: expect.objectContaining({ runId: claim.run.id }),
      });
      expect(git(['worktree', 'list', '--porcelain'], root)).toContain(persisted.temporaryPath);
      expect(git(['branch', '--list', persisted.temporaryBranch], root)).toContain(persisted.temporaryBranch);
      expect(git(['branch', '--list', committed.branch], root)).toContain(committed.branch);
      runner.cleanup(store.getAction('integrate'));
      expect(git(['worktree', 'list', '--porcelain'], root)).toContain(persisted.temporaryPath);
    } finally {
      store.close();
    }
  });

  it('recovers idempotently when finalized ownership persistence fails', async () => {
    const { root, store, item, committed } = integrationFixture();
    const claim = claimIntegration(store, item.id);
    const originalFinish = store.finishIntegrationFinalization.bind(store);
    let writes = 0;
    store.finishIntegrationFinalization = vi.fn((...args) => {
      writes += 1;
      if (writes === 1) throw new Error('finalized write failed');
      return originalFinish(...args);
    });
    const runner = new WorkItemRunner({ store });
    try {
      await expect(runner.prepare(claim)).rejects.toMatchObject({
        message: 'finalized write failed', workItemPrepareRetryable: true,
      });
      const integration = store.getAction('integrate').workspace.integration;
      expect(git(['rev-parse', 'HEAD'], root)).toBe(integration.integratedHead);
      expect(integration).toMatchObject({ status: 'prepared' });
      expect(git(['branch', '--list', committed.branch], root)).toBe('');

      const recovered = await runner.prepare({ ...claim, action: store.getAction('integrate') });
      expect(recovered.action.workspace.integration).toMatchObject({
        status: 'finalized', head: integration.integratedHead,
      });
      expect(store.getAction('integrate').workspace.integration).toMatchObject({ status: 'finalized' });
    } finally {
      store.close();
    }
  });

  it('rejects stale integration preparation after interruption without Git or Store side effects', async () => {
    const { root, store, item, committed } = integrationFixture();
    const claim = claimIntegration(store, item.id, 'old-boot');
    const originalHead = git(['rev-parse', 'HEAD'], root);
    const originalResources = integrationResources(root);
    expect(store.interruptRun(
      claim.run.id, claim.ownerBootId, claim.run.leaseEpoch, 'stale integration test',
    )).toBe(true);
    expect(store.getAction('integrate')).toMatchObject({ status: 'ready', currentRunId: null, workspace: null });
    const runner = new WorkItemRunner({ store });
    try {
      await expect(runner.prepare(claim)).rejects.toThrow(/lost its Run lease/);
      expect(git(['rev-parse', 'HEAD'], root)).toBe(originalHead);
      expect(existsSync(join(root, 'result.txt'))).toBe(false);
      expect(integrationResources(root)).toEqual(originalResources);
      expect(git(['branch', '--list', committed.branch], root)).toBe(committed.branch);
      expect(store.getAction('integrate')).toMatchObject({ status: 'ready', currentRunId: null, workspace: null });
    } finally {
      store.close();
    }
  });

  it('rejects stale integration preparation after lease recovery', async () => {
    const { root, store, item } = integrationFixture();
    const claim = claimIntegration(store, item.id, 'old-boot');
    const originalHead = git(['rev-parse', 'HEAD'], root);
    const originalResources = integrationResources(root);
    store.db.prepare('UPDATE runs SET expires_at = 0 WHERE id = ?').run(claim.run.id);
    expect(store.recoverInterruptedRuns('new-boot')).toBe(1);
    const runner = new WorkItemRunner({ store });
    try {
      await expect(runner.prepare(claim)).rejects.toThrow(/lost its Run lease/);
      expect(git(['rev-parse', 'HEAD'], root)).toBe(originalHead);
      expect(existsSync(join(root, 'result.txt'))).toBe(false);
      expect(integrationResources(root)).toEqual(originalResources);
      expect(store.getAction('integrate')).toMatchObject({ status: 'ready', currentRunId: null, workspace: null });
    } finally {
      store.close();
    }
  });

  it('blocks interruption and recovery while a finalization reservation is active, then recovers after expiry', () => {
    const { root, store, item } = integrationFixture();
    const claim = claimIntegration(store, item.id, 'old-boot');
    const dependencies = store.listActionDependencies(item.id, ['implement']);
    const integration = prepareActionIntegration({ workDir: root, dependencies });
    store.setIntegrationWorkspaceForRun(
      claim.action.id, claim.run.id, claim.ownerBootId, claim.run.leaseEpoch,
      { path: root, integration },
    );
    const acquired = store.acquireIntegrationFinalization(
      claim.action.id, claim.run.id, claim.ownerBootId, claim.run.leaseEpoch, 10_000,
    );
    expect(acquired).toMatchObject({ token: expect.any(String), expiresAt: expect.any(Number) });
    expect(() => store.interruptRun(
      claim.run.id, claim.ownerBootId, claim.run.leaseEpoch, 'reservation active',
    )).toThrow(/integration finalization currently owns/);
    store.db.prepare('UPDATE runs SET expires_at = 0 WHERE id = ?').run(claim.run.id);
    expect(store.recoverInterruptedRuns('new-boot')).toBe(0);

    const workspace = store.getAction('integrate').workspace;
    workspace.integration.reservation.expiresAt = 0;
    store.db.prepare('UPDATE actions SET workspace = ? WHERE id = ?')
      .run(JSON.stringify(workspace), claim.action.id);
    expect(store.recoverInterruptedRuns('new-boot')).toBe(1);
    expect(store.getRun(claim.run.id).status).toBe('interrupted');
    expect(store.getAction('integrate')).toMatchObject({ status: 'ready', currentRunId: null });
    store.close();
  });

  it('rejects mismatched reservation tokens without changing prepared ownership', () => {
    const { root, store, item } = integrationFixture();
    const claim = claimIntegration(store, item.id);
    const dependencies = store.listActionDependencies(item.id, ['implement']);
    const integration = prepareActionIntegration({ workDir: root, dependencies });
    store.setIntegrationWorkspaceForRun(
      claim.action.id, claim.run.id, claim.ownerBootId, claim.run.leaseEpoch,
      { path: root, integration },
    );
    store.acquireIntegrationFinalization(
      claim.action.id, claim.run.id, claim.ownerBootId, claim.run.leaseEpoch,
    );
    const before = store.getAction('integrate').workspace;
    expect(store.rollbackIntegrationFinalization(
      claim.action.id, claim.run.id, claim.ownerBootId, claim.run.leaseEpoch, 'wrong-token',
    )).toBeNull();
    expect(store.finishIntegrationFinalization(
      claim.action.id, claim.run.id, claim.ownerBootId, claim.run.leaseEpoch, 'wrong-token',
      { ...before, integration: { ...before.integration, status: 'finalized' } },
    )).toBeNull();
    expect(store.getAction('integrate').workspace).toEqual(before);
    store.close();
  });

  it('prevents an old Run from rolling back or finalizing replacement ownership', () => {
    const { root, store, item } = integrationFixture();
    const oldClaim = claimIntegration(store, item.id, 'old-boot');
    expect(store.interruptRun(
      oldClaim.run.id, oldClaim.ownerBootId, oldClaim.run.leaseEpoch, 'replacement test',
    )).toBe(true);
    const replacement = claimIntegration(store, item.id, 'new-boot');
    const dependencies = store.listActionDependencies(item.id, ['implement']);
    const integration = prepareActionIntegration({ workDir: root, dependencies });
    const persisted = store.setIntegrationWorkspaceForRun(
      replacement.action.id, replacement.run.id, replacement.ownerBootId,
      replacement.run.leaseEpoch, { path: root, integration },
    );
    expect(persisted.workspace.integration.integratedHead).toBe(integration.integratedHead);
    const acquired = store.acquireIntegrationFinalization(
      replacement.action.id, replacement.run.id, replacement.ownerBootId, replacement.run.leaseEpoch,
    );
    const before = store.getAction('integrate').workspace;
    expect(store.rollbackIntegrationFinalization(
      oldClaim.action.id, oldClaim.run.id, oldClaim.ownerBootId,
      oldClaim.run.leaseEpoch, acquired.token,
    )).toBeNull();
    expect(store.finishIntegrationFinalization(
      oldClaim.action.id, oldClaim.run.id, oldClaim.ownerBootId,
      oldClaim.run.leaseEpoch, acquired.token,
      { ...before, integration: { ...before.integration, status: 'finalized' } },
    )).toBeNull();
    expect(store.getAction('integrate').workspace).toEqual(before);
    store.close();
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
