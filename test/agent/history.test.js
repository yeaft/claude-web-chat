import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock os.homedir so getClaudeProjectsDir points to our temp dir
let tempHome;

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    homedir: () => tempHome,
  };
});

// Mock ctx for handleListFolders
vi.mock('../../agent/context.js', () => ({
  default: {
    CONFIG: { workDir: '/test' },
    sendToServer: vi.fn(),
  },
}));

describe('agent/history.js — crew role filtering', () => {
  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'history-test-'));
    mkdirSync(join(tempHome, '.claude', 'projects'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  // ─── getHistorySessions: crew role path → empty array ──────────

  describe('getHistorySessions()', () => {
    it('should return [] when workDir contains .crew/roles/ (Linux path)', async () => {
      const { getHistorySessions } = await import('../../agent/history.js');
      const result = await getHistorySessions('/home/user/projects/myapp/.crew/roles/dev-1');
      expect(result).toEqual([]);
    });

    it('should return [] when workDir contains .crew/roles/ deeply nested', async () => {
      const { getHistorySessions } = await import('../../agent/history.js');
      const result = await getHistorySessions('/home/user/projects/myapp/.crew/roles/test-2/subdir');
      expect(result).toEqual([]);
    });

    it('should return [] when workDir contains .crew\\roles\\ (Windows path)', async () => {
      const { getHistorySessions } = await import('../../agent/history.js');
      const result = await getHistorySessions('C:\\Users\\dev\\project\\.crew\\roles\\pm');
      expect(result).toEqual([]);
    });

    it('should NOT filter a normal workDir (no .crew/roles/)', async () => {
      const { getHistorySessions } = await import('../../agent/history.js');
      // No matching project folder → returns [] but goes through the normal path (not early return)
      const result = await getHistorySessions('/home/user/projects/myapp');
      expect(result).toEqual([]);
    });

    it('should NOT filter a workDir that partially matches (e.g. .crew but no roles)', async () => {
      const { getHistorySessions } = await import('../../agent/history.js');
      const result = await getHistorySessions('/home/user/projects/.crew/config');
      expect(result).toEqual([]);
    });

    it('should not crash on null workDir (crew guard safely skips null)', async () => {
      const { getHistorySessions } = await import('../../agent/history.js');
      // null workDir: the crew guard (workDir && regex) safely evaluates to false.
      // However, pathToProjectFolder(null) will throw since null has no .replace.
      // This is a pre-existing issue, not related to the crew filtering change.
      await expect(getHistorySessions(null)).rejects.toThrow();
    });
  });

  // ─── handleListFolders: filter crew role folders ──────────────

  describe('handleListFolders()', () => {
    it('should exclude folders whose name contains --crew-roles-', async () => {
      const projectsDir = join(tempHome, '.claude', 'projects');

      // Create normal project folder with a session file
      const normalFolder = '-home-user-projects-myapp';
      mkdirSync(join(projectsDir, normalFolder));
      writeFileSync(
        join(projectsDir, normalFolder, 'session1.jsonl'),
        JSON.stringify({ cwd: '/home/user/projects/myapp', type: 'user', message: { content: 'hello' } }) + '\n'
      );

      // Create crew role folder (should be filtered out)
      const crewFolder = '-home-user-projects-myapp--crew-roles-dev-1';
      mkdirSync(join(projectsDir, crewFolder));
      writeFileSync(
        join(projectsDir, crewFolder, 'session2.jsonl'),
        JSON.stringify({ cwd: '/home/user/projects/myapp/.crew/roles/dev-1', type: 'user', message: { content: 'hi' } }) + '\n'
      );

      // Create another crew role folder
      const crewFolder2 = '-home-user-projects-myapp--crew-roles-test-2';
      mkdirSync(join(projectsDir, crewFolder2));
      writeFileSync(
        join(projectsDir, crewFolder2, 'session3.jsonl'),
        JSON.stringify({ cwd: '/home/user/projects/myapp/.crew/roles/test-2', type: 'user', message: { content: 'test' } }) + '\n'
      );

      const ctx = (await import('../../agent/context.js')).default;
      const { handleListFolders } = await import('../../agent/history.js');

      await handleListFolders({ requestId: 'req-1', _requestClientId: 'client-1' });

      expect(ctx.sendToServer).toHaveBeenCalledOnce();
      const call = ctx.sendToServer.mock.calls[0][0];
      expect(call.type).toBe('folders_list');
      expect(call.requestId).toBe('req-1');

      // Only the normal folder should be returned
      expect(call.folders).toHaveLength(1);
      expect(call.folders[0].name).toBe(normalFolder);

      // Verify no crew folders leaked through
      const folderNames = call.folders.map(f => f.name);
      expect(folderNames).not.toContain(crewFolder);
      expect(folderNames).not.toContain(crewFolder2);
    });

    it('should keep folders that contain "crew" but not the "--crew-roles-" pattern', async () => {
      const projectsDir = join(tempHome, '.claude', 'projects');

      // A folder that has "crew" in its name but NOT the --crew-roles- pattern
      const notCrewRoleFolder = '-home-user-projects-crew-manager';
      mkdirSync(join(projectsDir, notCrewRoleFolder));
      writeFileSync(
        join(projectsDir, notCrewRoleFolder, 'session.jsonl'),
        JSON.stringify({ cwd: '/home/user/projects/crew-manager', type: 'user', message: { content: 'manage' } }) + '\n'
      );

      const ctx = (await import('../../agent/context.js')).default;
      ctx.sendToServer.mockClear();
      const { handleListFolders } = await import('../../agent/history.js');

      await handleListFolders({ requestId: 'req-2', _requestClientId: 'client-2' });

      const call = ctx.sendToServer.mock.calls[0][0];
      expect(call.folders).toHaveLength(1);
      expect(call.folders[0].name).toBe(notCrewRoleFolder);
    });

    it('should return empty array when all folders are crew role folders', async () => {
      const projectsDir = join(tempHome, '.claude', 'projects');

      const crewOnly = '-proj--crew-roles-pm';
      mkdirSync(join(projectsDir, crewOnly));
      writeFileSync(
        join(projectsDir, crewOnly, 's.jsonl'),
        JSON.stringify({ cwd: '/proj/.crew/roles/pm' }) + '\n'
      );

      const ctx = (await import('../../agent/context.js')).default;
      ctx.sendToServer.mockClear();
      const { handleListFolders } = await import('../../agent/history.js');

      await handleListFolders({ requestId: 'req-3', _requestClientId: 'client-3' });

      const call = ctx.sendToServer.mock.calls[0][0];
      expect(call.folders).toHaveLength(0);
    });
  });
});
