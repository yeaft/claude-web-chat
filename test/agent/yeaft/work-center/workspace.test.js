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

  it.each([
    ['throws', () => { throw new Error('sqlite write failed'); }, /sqlite write failed/],
    ['returns null', () => null, /lost its storage fence/],
  ])('leaves the target and dependency refs unchanged when integration ownership %s', async (
    _case, ownershipResult, expectedError,
  ) => {
    const { root, store, item, committed } = integrationFixture();
    const originalHead = git(['rev-parse', 'HEAD'], root);
    const originalResources = integrationResources(root);
    const originalSet = store.setActionWorkspace.bind(store);
    store.setActionWorkspace = vi.fn((...args) => {
      if (args[0] === 'integrate') return ownershipResult();
      return originalSet(...args);
    });
    const runner = new WorkItemRunner({ store });
    try {
      await expect(runner.prepare({
        workItem: item, action: store.getAction('integrate'), run: { id: 'integration-run' },
      })).rejects.toThrow(expectedError);
      expect(git(['rev-parse', 'HEAD'], root)).toBe(originalHead);
      expect(existsSync(join(root, 'result.txt'))).toBe(false);
      expect(git(['status', '--porcelain', '--untracked-files=normal'], root)).toBe('');
      expect(integrationResources(root)).toEqual(originalResources);
      expect(git(['branch', '--list', committed.branch], root)).toBe(committed.branch);
      expect(store.getAction('integrate')).toMatchObject({ status: 'ready', workspace: null });
      expect(store.listActionDependencies(item.id, ['implement']))
        .toEqual([expect.objectContaining({ workspace: committed })]);
    } finally {
      store.close();
    }
  });

  it('rolls back the persisted preparation when the integration target fails CAS', async () => {
    const { root, store, item, committed } = integrationFixture();
    const originalSet = store.setActionWorkspace.bind(store);
    let preparedIntegration;
    store.setActionWorkspace = vi.fn((...args) => {
      const persisted = originalSet(...args);
      if (args[1]?.integration) {
        preparedIntegration = args[1].integration;
        writeFileSync(join(root, 'external.txt'), 'external change\n');
        git(['add', '.'], root);
        git(['commit', '-m', 'external change'], root);
      }
      return persisted;
    });
    const runner = new WorkItemRunner({ store });
    try {
      await expect(runner.prepare({
        workItem: item, action: store.getAction('integrate'), run: { id: 'integration-run' },
      })).rejects.toThrow(/target changed before finalization/);
      expect(store.getAction('integrate')).toMatchObject({ workspaceMode: 'integrate', workspace: null });
      expect(git(['worktree', 'list', '--porcelain'], root)).not.toContain(preparedIntegration.temporaryPath);
      expect(git(['branch', '--list', preparedIntegration.temporaryBranch], root)).toBe('');
      expect(git(['branch', '--list', committed.branch], root)).toContain(committed.branch);
      expect(existsSync(join(root, 'result.txt'))).toBe(false);
    } finally {
      store.close();
    }
  });

  it('retains the preparation refs when CAS and the Store rollback both fail', async () => {
    const { root, store, item, committed } = integrationFixture();
    const originalSet = store.setActionWorkspace.bind(store);
    let writes = 0;
    store.setActionWorkspace = vi.fn((...args) => {
      writes += 1;
      if (writes === 2) throw new Error('rollback write failed');
      const persisted = originalSet(...args);
      writeFileSync(join(root, 'external.txt'), 'external change\n');
      git(['add', '.'], root);
      git(['commit', '-m', 'external change'], root);
      return persisted;
    });
    const runner = new WorkItemRunner({ store });
    try {
      await expect(runner.prepare({
        workItem: item, action: store.getAction('integrate'), run: { id: 'integration-run' },
      })).rejects.toThrow(/target changed before finalization/);
      const persisted = store.getAction('integrate').workspace.integration;
      expect(persisted).toMatchObject({ status: 'prepared' });
      expect(git(['worktree', 'list', '--porcelain'], root)).toContain(persisted.temporaryPath);
      expect(git(['branch', '--list', persisted.temporaryBranch], root)).toContain(persisted.temporaryBranch);
      expect(git(['branch', '--list', committed.branch], root)).toContain(committed.branch);
      runner.cleanup(store.getAction('integrate'));
      expect(git(['worktree', 'list', '--porcelain'], root)).toContain(persisted.temporaryPath);
      expect(git(['branch', '--list', persisted.temporaryBranch], root)).toContain(persisted.temporaryBranch);
    } finally {
      store.close();
    }
  });

  it('retries idempotently when finalized ownership persistence fails', async () => {
    const { root, store, item, committed } = integrationFixture();
    const originalSet = store.setActionWorkspace.bind(store);
    let integration;
    let writes = 0;
    store.setActionWorkspace = vi.fn((...args) => {
      writes += 1;
      if (writes === 2) throw new Error('finalized write failed');
      const persisted = originalSet(...args);
      if (args[1]?.integration?.status === 'prepared') integration = args[1].integration;
      return persisted;
    });
    const runner = new WorkItemRunner({ store });
    try {
      const claim = {
        workItem: item, action: store.getAction('integrate'), run: { id: 'integration-run' },
      };
      await expect(runner.prepare(claim)).rejects.toMatchObject({
        message: 'finalized write failed', workItemPrepareRetryable: true,
      });
      expect(git(['rev-parse', 'HEAD'], root)).toBe(integration.integratedHead);
      expect(store.getAction('integrate').workspace.integration).toMatchObject({ status: 'prepared' });
      expect(git(['branch', '--list', committed.branch], root)).toBe('');
      expect(git(['branch', '--list', integration.temporaryBranch], root)).toBe('');
      expect(git(['worktree', 'list', '--porcelain'], root)).not.toContain(integration.temporaryPath);

      store.setActionWorkspace = originalSet;
      const recovered = await runner.prepare({ ...claim, action: store.getAction('integrate') });
      expect(recovered.action.workspace.integration).toMatchObject({
        status: 'finalized', head: integration.integratedHead,
      });
      expect(store.getAction('integrate').workspace.integration).toMatchObject({
        status: 'finalized', head: integration.integratedHead,
      });
    } finally {
      store.close();
    }
  });

  it('preserves prepared integration ownership across manual graph retry', async () => {
    const { root, store, item } = integrationFixture();
    try {
      const dependencies = store.listActionDependencies(item.id, ['implement']);
      const integration = prepareActionIntegration({ workDir: root, dependencies });
      store.setActionWorkspace('integrate', { path: root, integration }, 'integrate');
      store.db.prepare("UPDATE actions SET status = 'failed', attempt = max_attempts WHERE id = 'integrate'").run();
      store.db.prepare(`UPDATE work_items SET status = 'needs_attention', current_action_id = 'integrate',
        current_run_id = NULL WHERE id = ?`).run(item.id);

      const controller = new WorkflowController(store);
      const retried = controller.retry(item.id);
      expect(retried.actions.find(action => action.id === 'integrate')).toMatchObject({
        status: 'ready', attempt: 0, workspaceMode: 'integrate',
        workspace: { integration: expect.objectContaining({ status: 'prepared', integratedHead: integration.integratedHead }) },
      });
      expect(git(['worktree', 'list', '--porcelain'], root)).toContain(integration.temporaryPath);
      expect(git(['branch', '--list', integration.temporaryBranch], root)).toContain(integration.temporaryBranch);

      const runner = new WorkItemRunner({ store });
      const recovered = await runner.prepare({
        workItem: store.getWorkItem(item.id),
        action: store.getAction('integrate'),
        run: { id: 'retried-integration-run' },
      });
      expect(recovered.action.workspace.integration).toMatchObject({
        status: 'finalized', head: integration.integratedHead,
      });
      expect(store.getAction('integrate').workspace.integration).toMatchObject({ status: 'finalized' });
    } finally {
      store.close();
    }
  });

  it('finalizes a persisted preparation exactly once and then recovers idempotently', async () => {
    const { root, store, item, committed } = integrationFixture();
    try {
      const dependencies = store.listActionDependencies(item.id, ['implement']);
      const integration = prepareActionIntegration({ workDir: root, dependencies });
      store.setActionWorkspace('integrate', { path: root, integration }, 'integrate');
      const runner = new WorkItemRunner({ store });
      const claim = { workItem: item, action: store.getAction('integrate'), run: { id: 'integration-run' } };
      const first = await runner.prepare(claim);
      const second = await runner.prepare({ ...claim, action: store.getAction('integrate') });
      expect(first.action.workspace.integration.head).toBe(integration.integratedHead);
      expect(second.action.workspace.integration.head).toBe(integration.integratedHead);
      expect(store.getAction('integrate').workspace.integration).toMatchObject({
        status: 'finalized', head: integration.integratedHead,
      });
      expect(readFileSync(join(root, 'result.txt'), 'utf8')).toBe('result\n');
      expect(git(['branch', '--list', committed.branch], root)).toBe('');
      expect(git(['branch', '--list', integration.temporaryBranch], root)).toBe('');
      expect(git(['worktree', 'list', '--porcelain'], root)).not.toContain(integration.temporaryPath);
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
