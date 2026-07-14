import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
      dependencies: [{ outcome: 'completed', workspace: committed }],
    });
    expect(integration.commits).toEqual([committed.commit]);
    expect(readFileSync(join(root, 'result.txt'), 'utf8')).toBe('result\n');
    expect(() => git(['show-ref', '--verify', `refs/heads/${committed.branch}`], root)).toThrow();
  });
});
