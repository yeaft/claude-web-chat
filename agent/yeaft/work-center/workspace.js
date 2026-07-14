import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const HIDDEN_PROCESS_OPTIONS = { windowsHide: true };

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

export function integrateActionWorktrees({ workDir, dependencies }) {
  const state = inspectGitWorkspace(workDir);
  if (!state.git || !state.clean) throw new Error(`Work Center integration requires a clean Git root: ${state.reason}`);
  if (dependencies.some(action => action.outcome !== 'completed')) {
    throw new Error('Work Center integration requires every dependency Action to complete successfully');
  }
  const commits = dependencies
    .filter(action => action.workspace?.isolated && action.workspace.changed)
    .map(action => action.workspace.commit);
  const temporaryRoot = resolve(join(dirname(state.root), '.yeaft-work-center-integration'));
  mkdirSync(temporaryRoot, { recursive: true });
  const temporaryPath = resolve(join(temporaryRoot, `integration-${process.pid}-${Date.now()}`));
  const temporaryBranch = `yeaft-work/integration-${process.pid}-${Date.now()}`;
  try {
    git(['worktree', 'add', '-b', temporaryBranch, temporaryPath, state.head], { cwd: state.root });
    for (const commit of commits) {
      try {
        git([
          '-c', 'user.name=Yeaft Work Center',
          '-c', 'user.email=work-center@yeaft.local',
          'merge', '--no-ff', '--no-edit', commit,
        ], { cwd: temporaryPath });
      } catch (error) {
        try { git(['merge', '--abort'], { cwd: temporaryPath }); } catch {}
        throw new Error(`Work Center could not integrate Action commit ${commit}: ${error.message}`);
      }
    }
    const integratedHead = git(['rev-parse', 'HEAD'], { cwd: temporaryPath });
    if (git(['rev-parse', 'HEAD'], { cwd: state.root }) !== state.head
        || git(['status', '--porcelain', '--untracked-files=normal'], { cwd: state.root })) {
      throw new Error('Work Center integration target changed while commits were being verified');
    }
    git(['merge', '--ff-only', integratedHead], { cwd: state.root });
  } finally {
    try { git(['worktree', 'remove', '--force', temporaryPath], { cwd: state.root }); } catch {
      rmSync(temporaryPath, { recursive: true, force: true });
    }
    try { git(['branch', '-D', temporaryBranch], { cwd: state.root }); } catch {}
  }
  for (const dependency of dependencies) {
    if (!dependency.workspace?.changed || !dependency.workspace.branch) continue;
    try { git(['branch', '-d', dependency.workspace.branch], { cwd: state.root }); } catch {}
  }
  return { commits, head: git(['rev-parse', 'HEAD'], { cwd: state.root }) };
}

export function removeActionWorktree(workspace) {
  if (!workspace?.isolated || !workspace.path || !workspace.repositoryRoot) return;
  try { git(['worktree', 'remove', '--force', workspace.path], { cwd: workspace.repositoryRoot }); } catch {}
  if (!workspace.changed && workspace.branch) {
    try { git(['branch', '-D', workspace.branch], { cwd: workspace.repositoryRoot }); } catch {}
  }
}
