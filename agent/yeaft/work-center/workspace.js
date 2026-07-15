import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const HIDDEN_PROCESS_OPTIONS = { windowsHide: true };
const INTEGRATION_FINALIZE_TIMEOUT_MS = 45_000;

function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...HIDDEN_PROCESS_OPTIONS,
    ...options,
  }).trim();
}

function cleanSlug(value) {
  return String(value || '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
}

export function inspectGitWorkspace(workDir) {
  try {
    const root = git(['rev-parse', '--show-toplevel'], { cwd: workDir });
    if (resolve(root) !== resolve(workDir)) return { git: false, reason: 'nested-repository-directory' };
    const head = git(['rev-parse', 'HEAD'], { cwd: root });
    const status = git(['status', '--porcelain', '--untracked-files=normal'], { cwd: root });
    return status
      ? { git: true, clean: false, root, head, reason: 'dirty-worktree' }
      : { git: true, clean: true, root, head };
  } catch {
    return { git: false, reason: 'not-a-git-repository' };
  }
}

export function createActionWorktree({ workItem, action, runId, rootDir }) {
  const state = inspectGitWorkspace(workItem.workspaceKey || workItem.workDir);
  if (!state.git || !state.clean) return { isolated: false, reason: state.reason };
  const name = `${cleanSlug(workItem.id)}-${cleanSlug(action.stageId || action.id)}-${cleanSlug(runId || 'run')}`;
  const worktreePath = resolve(join(rootDir, name));
  const branch = `yeaft-work/${name}`;
  if (existsSync(worktreePath)) throw new Error(`Work Center Action worktree already exists: ${worktreePath}`);
  mkdirSync(dirname(worktreePath), { recursive: true });
  git(['worktree', 'add', '-b', branch, worktreePath, state.head], { cwd: state.root });
  return {
    isolated: true,
    path: worktreePath,
    branch,
    baseCommit: state.head,
    repositoryRoot: state.root,
  };
}

export function commitActionWorktree(workspace, action) {
  if (!workspace?.isolated) return workspace;
  const status = git(['status', '--porcelain', '--untracked-files=normal'], { cwd: workspace.path });
  if (!status) return { ...workspace, commit: workspace.baseCommit, changed: false };
  git(['add', '--all'], { cwd: workspace.path });
  git([
    '-c', 'user.name=Yeaft Work Center',
    '-c', 'user.email=work-center@yeaft.local',
    'commit', '-m', `work-center: ${cleanSlug(action.stageId || action.type)}`,
  ], { cwd: workspace.path });
  return { ...workspace, commit: git(['rev-parse', 'HEAD'], { cwd: workspace.path }), changed: true };
}

function removeIntegrationPreparation(integration) {
  if (!integration?.repositoryRoot) return;
  if (integration.temporaryPath) {
    try {
      git(['worktree', 'remove', '--force', integration.temporaryPath], { cwd: integration.repositoryRoot });
    } catch {
      rmSync(integration.temporaryPath, { recursive: true, force: true });
    }
  }
  if (integration.temporaryBranch) {
    try { git(['branch', '-D', integration.temporaryBranch], { cwd: integration.repositoryRoot }); } catch {}
  }
}

export function prepareActionIntegration({ workDir, dependencies }) {
  const state = inspectGitWorkspace(workDir);
  if (!state.git || !state.clean) throw new Error(`Work Center integration requires a clean Git root: ${state.reason}`);
  if (dependencies.some(action => action.status !== 'completed')) {
    throw new Error('Work Center integration requires every dependency Action to complete successfully');
  }
  const commits = dependencies
    .filter(action => action.workspace?.isolated && action.workspace.changed)
    .map(action => action.workspace.commit);
  const dependencyBranches = dependencies
    .filter(action => action.workspace?.changed && action.workspace.branch)
    .map(action => action.workspace.branch);
  const temporaryRoot = resolve(join(dirname(state.root), '.yeaft-work-center-integration'));
  mkdirSync(temporaryRoot, { recursive: true });
  const suffix = `${process.pid}-${Date.now()}`;
  const integration = {
    status: 'prepared',
    commits,
    dependencyBranches,
    baseHead: state.head,
    integratedHead: null,
    repositoryRoot: state.root,
    temporaryPath: resolve(join(temporaryRoot, `integration-${suffix}`)),
    temporaryBranch: `yeaft-work/integration-${suffix}`,
  };
  try {
    git([
      'worktree', 'add', '-b', integration.temporaryBranch,
      integration.temporaryPath, integration.baseHead,
    ], { cwd: integration.repositoryRoot });
    for (const commit of commits) {
      try {
        git([
          '-c', 'user.name=Yeaft Work Center',
          '-c', 'user.email=work-center@yeaft.local',
          'merge', '--no-ff', '--no-edit', commit,
        ], { cwd: integration.temporaryPath });
      } catch (error) {
        try { git(['merge', '--abort'], { cwd: integration.temporaryPath }); } catch {}
        throw new Error(`Work Center could not integrate Action commit ${commit}: ${error.message}`);
      }
    }
    integration.integratedHead = git(['rev-parse', 'HEAD'], { cwd: integration.temporaryPath });
    return integration;
  } catch (error) {
    removeIntegrationPreparation(integration);
    throw error;
  }
}

export function discardActionIntegration(integration) {
  removeIntegrationPreparation(integration);
}

export function finalizeActionIntegration(integration) {
  if (!integration?.repositoryRoot || !integration.baseHead || !integration.integratedHead) {
    throw new Error('Work Center integration preparation is incomplete');
  }
  const currentHead = git(['rev-parse', 'HEAD'], { cwd: integration.repositoryRoot });
  const status = git([
    'status', '--porcelain', '--untracked-files=normal',
  ], { cwd: integration.repositoryRoot });
  if (status || ![integration.baseHead, integration.integratedHead].includes(currentHead)) {
    throw new Error('Work Center integration target changed before finalization');
  }
  const reservationExpiresAt = Number(integration.reservation?.expiresAt) || 0;
  if (reservationExpiresAt && Date.now() + INTEGRATION_FINALIZE_TIMEOUT_MS >= reservationExpiresAt) {
    throw new Error('Work Center integration reservation expires before finalization can complete');
  }
  if (currentHead === integration.baseHead) {
    git(['merge', '--ff-only', integration.integratedHead], {
      cwd: integration.repositoryRoot,
      timeout: INTEGRATION_FINALIZE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
  }
  const head = git(['rev-parse', 'HEAD'], { cwd: integration.repositoryRoot });
  if (head !== integration.integratedHead) {
    throw new Error('Work Center integration target did not reach the prepared commit');
  }
  for (const branch of integration.dependencyBranches || []) {
    try { git(['branch', '-d', branch], { cwd: integration.repositoryRoot }); } catch {}
  }
  removeIntegrationPreparation(integration);
  return {
    status: 'finalized',
    commits: integration.commits,
    baseHead: integration.baseHead,
    integratedHead: integration.integratedHead,
    head,
  };
}

export function integrateActionWorktrees({ workDir, dependencies }) {
  return finalizeActionIntegration(prepareActionIntegration({ workDir, dependencies }));
}

export function removeActionWorktree(workspace) {
  if (!workspace?.isolated || !workspace.path || !workspace.repositoryRoot) return;
  try { git(['worktree', 'remove', '--force', workspace.path], { cwd: workspace.repositoryRoot }); } catch {}
  if (!workspace.changed && workspace.branch) {
    try { git(['branch', '-D', workspace.branch], { cwd: workspace.repositoryRoot }); } catch {}
  }
}
