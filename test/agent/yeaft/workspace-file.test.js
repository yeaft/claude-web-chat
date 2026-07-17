import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readProjectDoc } from '../../../agent/yeaft/sessions/project-doc.js';
import { loadProjectMCPServers } from '../../../agent/yeaft/config.js';

const roots = [];
function temp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('secure workspace project files', () => {
  it('reads regular project instructions and MCP configs inside the workspace', () => {
    const workspace = temp('yeaft-safe-workspace-');
    writeFileSync(join(workspace, 'AGENTS.md'), 'Use local instructions.');
    writeFileSync(join(workspace, '.mcp.json'), JSON.stringify({
      mcpServers: { local: { command: 'node', args: ['server.js'] } },
    }));

    expect(readProjectDoc(workspace, { secureWorkspace: true })?.text).toBe('Use local instructions.');
    expect(loadProjectMCPServers(workspace, { secureWorkspace: true }).servers).toEqual([
      { name: 'local', command: 'node', args: ['server.js'] },
    ]);
  });

  it('rejects final project instruction and MCP config symlinks', () => {
    const workspace = temp('yeaft-safe-workspace-');
    const outside = temp('yeaft-outside-');
    writeFileSync(join(outside, 'AGENTS.md'), 'EXTERNAL INSTRUCTIONS');
    writeFileSync(join(outside, '.mcp.json'), JSON.stringify({
      mcpServers: { external: { command: 'external-command' } },
    }));
    symlinkSync(join(outside, 'AGENTS.md'), join(workspace, 'AGENTS.md'));
    symlinkSync(join(outside, '.mcp.json'), join(workspace, '.mcp.json'));

    expect(readProjectDoc(workspace, { secureWorkspace: true })).toBeNull();
    expect(loadProjectMCPServers(workspace, { secureWorkspace: true }).servers).toEqual([]);
  });

  it('does not leak descriptors when a parent directory fails identity checks', () => {
    const workspace = temp('yeaft-safe-workspace-');
    const outside = temp('yeaft-outside-');
    mkdirSync(join(outside, '.codex'));
    writeFileSync(join(outside, '.codex', 'config.toml'), 'external');
    symlinkSync(join(outside, '.codex'), join(workspace, '.codex'), 'dir');
    const before = new Set(readdirSync('/proc/self/fd'));
    for (let index = 0; index < 200; index += 1) {
      expect(loadProjectMCPServers(workspace, { secureWorkspace: true }).servers).toEqual([]);
    }
    const after = new Set(readdirSync('/proc/self/fd'));
    expect(after.size).toBeLessThanOrEqual(before.size + 1);
  });

  it('rejects oversized sparse MCP configs instead of parsing truncated data', () => {
    const workspace = temp('yeaft-safe-workspace-');
    const file = join(workspace, '.mcp.json');
    writeFileSync(file, JSON.stringify({ mcpServers: { external: { command: 'external-command' } } }));
    truncateSync(file, 1024 * 1024 + 4096);
    expect(loadProjectMCPServers(workspace, { secureWorkspace: true }).servers).toEqual([]);
  });

  it('rejects a symlinked .codex parent directory', () => {
    const workspace = temp('yeaft-safe-workspace-');
    const outside = temp('yeaft-outside-');
    mkdirSync(join(outside, '.codex'));
    writeFileSync(join(outside, '.codex', 'config.toml'), [
      '[mcp_servers.external]',
      'command = "external-command"',
    ].join('\n'));
    symlinkSync(join(outside, '.codex'), join(workspace, '.codex'), 'dir');

    expect(loadProjectMCPServers(workspace, { secureWorkspace: true }).servers).toEqual([]);
  });
});
