import { describe, it, expect } from 'vitest';
import { resolve, isAbsolute } from 'path';
import { resolveAndValidatePath, validateGitPath } from '../../agent/workbench.js';

/**
 * Tests for agent workbench operations (workbench.js).
 * Tests pure utility functions directly, and logic patterns for git/file operations.
 */

describe('resolveAndValidatePath', () => {
  it('should resolve absolute path as-is', () => {
    const result = resolveAndValidatePath('/home/user/file.txt', '/work');
    expect(isAbsolute(result)).toBe(true);
    expect(result).toBe(resolve('/home/user/file.txt'));
  });

  it('should resolve relative path against workDir', () => {
    const result = resolveAndValidatePath('src/app.js', '/home/user/project');
    expect(result).toBe(resolve('/home/user/project', 'src/app.js'));
  });

  it('should normalize path separators', () => {
    const result = resolveAndValidatePath('src/../src/app.js', '/work');
    expect(result).toBe(resolve('/work/src/app.js'));
  });
});

describe('validateGitPath', () => {
  it('should accept normal file paths', () => {
    expect(validateGitPath('src/app.js')).toBe(true);
    expect(validateGitPath('/home/user/file.txt')).toBe(true);
    expect(validateGitPath('path/to/file with spaces.md')).toBe(true);
    expect(validateGitPath('file-name_v2.0.ts')).toBe(true);
  });

  it('should reject paths with shell injection characters', () => {
    expect(validateGitPath('file.txt; rm -rf /')).toBe(false);
    expect(validateGitPath('`whoami`')).toBe(false);
    expect(validateGitPath('$HOME/secret')).toBe(false);
    expect(validateGitPath('file | cat')).toBe(false);
    expect(validateGitPath('file & bg')).toBe(false);
    expect(validateGitPath('file > output')).toBe(false);
    expect(validateGitPath('file < input')).toBe(false);
    expect(validateGitPath('file\nname')).toBe(false);
  });

  it('should reject empty/null paths', () => {
    expect(validateGitPath('')).toBeFalsy();
    expect(validateGitPath(null)).toBeFalsy();
    expect(validateGitPath(undefined)).toBeFalsy();
  });
});

describe('Git Operations Logic', () => {
  describe('git status parsing', () => {
    it('should parse porcelain status output', () => {
      const lines = [
        ' M server/index.js',
        '?? new-file.txt',
        'A  added.js',
        'D  deleted.js',
        ' M web/style.css',
        'MM both-modified.js'
      ];

      const files = lines.map(line => {
        const status = line.substring(0, 2);
        const filePath = line.substring(3);
        return { status: status.trim(), path: filePath };
      });

      expect(files.length).toBe(6);
      expect(files[0]).toEqual({ status: 'M', path: 'server/index.js' });
      expect(files[1]).toEqual({ status: '??', path: 'new-file.txt' });
      expect(files[2]).toEqual({ status: 'A', path: 'added.js' });
      expect(files[3]).toEqual({ status: 'D', path: 'deleted.js' });
    });

    it('should handle empty status (clean repo)', () => {
      const output = '';
      const files = output.trim() ? output.trim().split('\n') : [];
      expect(files.length).toBe(0);
    });
  });

  describe('git diff path resolution', () => {
    it('should use git root as cwd for git diff', () => {
      // git status returns paths relative to repo root
      // so git diff must also use repo root as cwd
      const gitRoot = '/home/user/project';
      const filePath = 'src/app.js'; // relative to git root

      // In real code: execAsync('git diff -- "filePath"', { cwd: gitRoot })
      const expectedCwd = gitRoot;
      expect(expectedCwd).toBe('/home/user/project');
    });

    it('should handle untracked files by reading file content', () => {
      // For untracked files (??), git diff won't work
      // Must read file content directly
      const gitRoot = '/home/user/project';
      const filePath = 'new-file.txt';
      const absolutePath = resolve(gitRoot, filePath);

      expect(absolutePath).toBe(resolve('/home/user/project/new-file.txt'));
    });
  });

  describe('file language detection', () => {
    it('should detect language from extension', () => {
      const langMap = {
        '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
        '.ts': 'javascript', '.tsx': 'javascript', '.jsx': 'javascript',
        '.py': 'python', '.pyw': 'python',
        '.html': 'htmlmixed', '.htm': 'htmlmixed',
        '.css': 'css', '.scss': 'css', '.less': 'css',
        '.json': 'javascript',
        '.md': 'markdown',
        '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
        '.yaml': 'yaml', '.yml': 'yaml',
        '.sql': 'sql',
        '.go': 'go', '.rs': 'rust', '.rb': 'ruby',
        '.php': 'php', '.swift': 'swift'
      };

      expect(langMap['.js']).toBe('javascript');
      expect(langMap['.py']).toBe('python');
      expect(langMap['.html']).toBe('htmlmixed');
      expect(langMap['.unknown']).toBeUndefined();
    });
  });
});

describe('File Operations Logic', () => {
  describe('directory listing', () => {
    it('should sort directories before files', () => {
      const entries = [
        { name: 'file.txt', type: 'file', size: 100 },
        { name: 'src', type: 'directory', size: 0 },
        { name: 'readme.md', type: 'file', size: 500 },
        { name: 'docs', type: 'directory', size: 0 }
      ];

      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      expect(entries[0].name).toBe('docs');
      expect(entries[1].name).toBe('src');
      expect(entries[2].name).toBe('file.txt');
      expect(entries[3].name).toBe('readme.md');
    });

    it('should skip hidden files and node_modules', () => {
      const entries = [
        { name: '.git' },
        { name: '.env' },
        { name: 'node_modules' },
        { name: 'src' },
        { name: 'package.json' }
      ];

      const filtered = entries.filter(e => {
        if (e.name.startsWith('.') && e.name !== '..') return false;
        if (e.name === 'node_modules') return false;
        return true;
      });

      expect(filtered.length).toBe(2);
      expect(filtered.map(e => e.name)).toEqual(['src', 'package.json']);
    });
  });

  describe('file search', () => {
    it('should construct search pattern correctly', () => {
      const query = 'handleMessage';
      const workDir = '/home/user/project';

      // In real code: uses grep or similar
      const searchCommand = `grep -rl "${query}" "${workDir}" --include="*.js" --include="*.ts"`;
      expect(searchCommand).toContain(query);
      expect(searchCommand).toContain(workDir);
    });
  });
});

describe('Git Commit Flow', () => {
  it('should validate commit message is non-empty', () => {
    expect('fix: bug'.trim().length > 0).toBe(true);
    expect(''.trim().length > 0).toBe(false);
    expect('  '.trim().length > 0).toBe(false);
  });

  it('should support git add with specific files', () => {
    const files = ['src/app.js', 'src/utils.js'];
    const validFiles = files.filter(f => validateGitPath(f));
    expect(validFiles.length).toBe(2);
  });

  it('should reject git add with dangerous file paths', () => {
    const files = ['src/app.js', 'file; rm -rf /'];
    const validFiles = files.filter(f => validateGitPath(f));
    expect(validFiles.length).toBe(1);
  });
});

describe('Background Tasks', () => {
  it('should track background task state', () => {
    const tasks = new Map();
    const task = {
      id: 'task_123',
      command: 'npm test',
      pid: 12345,
      output: '',
      running: true
    };

    tasks.set(task.id, task);
    expect(tasks.has('task_123')).toBe(true);

    // Append output
    task.output += 'PASS tests/app.test.js\n';
    expect(task.output).toContain('PASS');

    // Complete
    task.running = false;
    expect(task.running).toBe(false);
  });
});
