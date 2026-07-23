import { afterEach, describe, expect, it, vi } from 'vitest';

const closedDescriptors = vi.hoisted(() => []);
const mismatchedPaths = vi.hoisted(() => new Set());

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal();
  return {
    ...actual,
    closeSync(descriptor) {
      closedDescriptors.push(descriptor);
      return actual.closeSync(descriptor);
    },
    lstatSync(filePath, options) {
      const stat = actual.lstatSync(filePath, options);
      if (!mismatchedPaths.has(String(filePath))) return stat;
      return {
        ...stat,
        ino: Number(stat.ino) + 1,
        isDirectory: () => stat.isDirectory(),
        isFile: () => stat.isFile(),
        isSymbolicLink: () => stat.isSymbolicLink(),
      };
    },
  };
});

const { mkdirSync, mkdtempSync, rmSync } = await import('node:fs');
const { join } = await import('node:path');
const { tmpdir } = await import('node:os');
const { listWorkspaceDirectory } = await import('../../../agent/yeaft/workspace-file.js');

let workspace;
afterEach(() => {
  mismatchedPaths.clear();
  closedDescriptors.length = 0;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = null;
});

describe('workspace file descriptor cleanup', () => {
  it('closes an intermediate directory descriptor when identity validation fails', () => {
    workspace = mkdtempSync(join(tmpdir(), 'yeaft-workspace-fd-'));
    const parent = join(workspace, 'parent');
    mkdirSync(join(parent, 'child'), { recursive: true });
    mismatchedPaths.add(parent);

    expect(listWorkspaceDirectory(workspace, 'parent/child')).toBeNull();
    expect(closedDescriptors).toHaveLength(2);
    expect(new Set(closedDescriptors).size).toBe(2);
  });
});
