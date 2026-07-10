import { describe, expect, it, vi } from 'vitest';
import { createWorkItemToolRegistry } from '../../../../agent/yeaft/work-center/runner.js';

describe('Work Center tool policy', () => {
  it('exposes only the explicit synchronous allowlist', () => {
    const registry = createWorkItemToolRegistry({ workDir: '/tmp/project', isRunActive: () => true });
    const names = registry.getAllTools().map(tool => tool.name);

    expect(names).toContain('FileRead');
    expect(names).toContain('Bash');
    expect(names).not.toContain('SpawnAgent');
    expect(names).not.toContain('RouteForward');
    expect(names).not.toContain('AskUser');
    expect(names).not.toContain('EnterWorktree');
    expect(names).not.toContain('ListTasks');
  });

  it('rejects background or redirected Bash before execution', async () => {
    const registry = createWorkItemToolRegistry({ workDir: '/tmp/project', isRunActive: () => true });
    await expect(registry.execute('Bash', {
      command: 'echo nope', cwd: '/tmp/other', background: false,
    }, {})).rejects.toThrow(/cwd is fixed/);
    await expect(registry.execute('Bash', {
      command: 'echo nope', cwd: '/tmp/project', background: true,
    }, {})).rejects.toThrow(/background Bash/);
  });

  it('rejects paths and patch targets outside the WorkItem directory', async () => {
    const registry = createWorkItemToolRegistry({ workDir: '/tmp/project', isRunActive: () => true });
    await expect(registry.execute('FileRead', { file_path: '../secret' }, {}))
      .rejects.toThrow(/escapes/);

    await expect(registry.execute('ApplyPatch', {
      patch: '--- a/file.txt\n+++ ../../secret.txt\n@@ -1 +1 @@\n-old\n+new\n',
    }, {})).rejects.toThrow(/escapes/);
  });

  it('fences execution after the Run loses its lease', async () => {
    const active = vi.fn().mockReturnValue(false);
    const registry = createWorkItemToolRegistry({ workDir: '/tmp/project', isRunActive: active });
    await expect(registry.execute('ListDir', { path: '.' }, {}))
      .rejects.toThrow(/lease is no longer active/);
    expect(active).toHaveBeenCalled();
  });
});
