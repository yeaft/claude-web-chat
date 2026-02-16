import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { readFile, writeFile, readdir, stat, unlink, rename, mkdir, rm, copyFile, cp } from 'fs/promises';
import { join, basename, dirname, extname, resolve, isAbsolute, relative } from 'path';
import { platform } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import ctx from './context.js';

const execAsync = promisify(exec);

// 路径安全校验 - 确保路径格式正确
export function resolveAndValidatePath(filePath, workDir) {
  const resolved = isAbsolute(filePath) ? resolve(filePath) : resolve(workDir, filePath);
  return resolved;
}

// Helper: resolve git root for a working directory
export async function getGitRoot(workDir) {
  try {
    const { stdout } = await execAsync('git rev-parse --show-toplevel', {
      cwd: workDir, timeout: 5000, windowsHide: true
    });
    return stdout.trim();
  } catch {
    return workDir;
  }
}

// Helper: validate file path for shell safety
export function validateGitPath(filePath) {
  return filePath && !/[`$;|&><!\n\r]/.test(filePath);
}

export async function handleReadFile(msg) {
  const { conversationId, filePath, _requestUserId } = msg;
  console.log('[Agent] handleReadFile received:', { filePath, conversationId, workDir: msg.workDir });
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;

  try {
    const resolved = resolveAndValidatePath(filePath, workDir);
    const content = await readFile(resolved, 'utf-8');

    // 检测语言
    const ext = extname(resolved).toLowerCase();
    const langMap = {
      '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
      '.ts': 'javascript', '.tsx': 'javascript', '.jsx': 'javascript',
      '.py': 'python', '.pyw': 'python',
      '.html': 'htmlmixed', '.htm': 'htmlmixed',
      '.css': 'css', '.scss': 'css', '.less': 'css',
      '.json': 'javascript',
      '.md': 'markdown',
      '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
      '.cs': 'text/x-csharp', '.java': 'text/x-java',
      '.cpp': 'text/x-c++src', '.c': 'text/x-csrc', '.h': 'text/x-csrc',
      '.xml': 'xml', '.svg': 'xml',
      '.yaml': 'yaml', '.yml': 'yaml',
      '.sql': 'sql',
      '.go': 'go', '.rs': 'rust', '.rb': 'ruby',
      '.php': 'php', '.swift': 'swift'
    };

    console.log('[Agent] Sending file_content:', { filePath: resolved, contentLen: content.length, conversationId });
    ctx.sendToServer({
      type: 'file_content',
      conversationId,
      _requestUserId,
      filePath: resolved,
      content,
      language: langMap[ext] || null
    });
  } catch (e) {
    ctx.sendToServer({
      type: 'file_content',
      conversationId,
      _requestUserId,
      filePath,
      content: '',
      error: e.message
    });
  }
}

export async function handleWriteFile(msg) {
  const { conversationId, filePath, content, _requestUserId } = msg;
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;

  try {
    const resolved = resolveAndValidatePath(filePath, workDir);
    await writeFile(resolved, content, 'utf-8');

    ctx.sendToServer({
      type: 'file_saved',
      conversationId,
      _requestUserId,
      filePath: resolved,
      success: true
    });
  } catch (e) {
    ctx.sendToServer({
      type: 'file_saved',
      conversationId,
      _requestUserId,
      filePath,
      success: false,
      error: e.message
    });
  }
}

export async function handleListDirectory(msg) {
  const { conversationId, dirPath, _requestUserId } = msg;
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;

  // 空路径：列出驱动器（Windows）或根目录（Unix）
  if (!dirPath || dirPath === '') {
    try {
      if (platform() === 'win32') {
        const drives = [];
        for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('')) {
          const drivePath = letter + ':\\';
          if (existsSync(drivePath)) {
            drives.push({ name: letter + ':', type: 'directory', size: 0 });
          }
        }
        ctx.sendToServer({
          type: 'directory_listing',
          conversationId,
          _requestUserId,
          dirPath: '',
          entries: drives
        });
      } else {
        // Unix: 列出根目录
        const entries = await readdir('/', { withFileTypes: true });
        const result = entries
          .filter(e => !e.name.startsWith('.'))
          .map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file', size: 0 }))
          .sort((a, b) => a.name.localeCompare(b.name));
        ctx.sendToServer({
          type: 'directory_listing',
          conversationId,
          _requestUserId,
          dirPath: '/',
          entries: result
        });
      }
    } catch (e) {
      ctx.sendToServer({
        type: 'directory_listing',
        conversationId,
        _requestUserId,
        dirPath: '',
        entries: [],
        error: e.message
      });
    }
    return;
  }

  try {
    const resolved = resolveAndValidatePath(dirPath, workDir);
    const entries = await readdir(resolved, { withFileTypes: true });
    const result = [];

    for (const entry of entries) {
      // 跳过隐藏文件和 node_modules
      if (entry.name.startsWith('.') && entry.name !== '..') continue;
      if (entry.name === 'node_modules') continue;

      try {
        const fullPath = join(resolved, entry.name);
        const s = await stat(fullPath);
        result.push({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
          size: s.size
        });
      } catch {
        result.push({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
          size: 0
        });
      }
    }

    // 排序：目录在前，文件在后，各自按名称排序
    result.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    ctx.sendToServer({
      type: 'directory_listing',
      conversationId,
      _requestUserId,
      dirPath: resolved,
      entries: result
    });
  } catch (e) {
    ctx.sendToServer({
      type: 'directory_listing',
      conversationId,
      _requestUserId,
      dirPath: dirPath || workDir,
      entries: [],
      error: e.message
    });
  }
}

export async function handleGitStatus(msg) {
  const { conversationId, _requestUserId } = msg;
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;

  try {
    // Get git repo root to ensure paths are consistent
    let gitRoot = workDir;
    try {
      const { stdout: rootOut } = await execAsync('git rev-parse --show-toplevel', {
        cwd: workDir,
        timeout: 5000,
        windowsHide: true
      });
      gitRoot = rootOut.trim();
    } catch {}

    const { stdout: statusOut } = await execAsync('git status --porcelain', {
      cwd: gitRoot,
      timeout: 10000,
      windowsHide: true
    });

    let branch = '';
    try {
      const { stdout: branchOut } = await execAsync('git branch --show-current', {
        cwd: gitRoot,
        timeout: 5000,
        windowsHide: true
      });
      branch = branchOut.trim();
    } catch {}

    // Get ahead/behind counts relative to upstream
    let ahead = 0, behind = 0;
    try {
      const { stdout: abOut } = await execAsync('git rev-list --left-right --count HEAD...@{upstream}', {
        cwd: gitRoot, timeout: 5000, windowsHide: true
      });
      const parts = abOut.trim().split(/\s+/);
      ahead = parseInt(parts[0]) || 0;
      behind = parseInt(parts[1]) || 0;
    } catch {}

    const files = [];
    for (const line of statusOut.split('\n')) {
      if (!line || line.length < 4) continue;
      const indexStatus = line[0];
      const workTreeStatus = line[1];
      const path = line.slice(3);
      // Handle renamed files: "R  old -> new"
      const displayPath = path.includes(' -> ') ? path.split(' -> ')[1] : path;
      files.push({ path: displayPath, indexStatus, workTreeStatus });
    }

    ctx.sendToServer({
      type: 'git_status_result',
      conversationId,
      _requestUserId,
      branch,
      files,
      ahead,
      behind,
      workDir,
      gitRoot
    });
  } catch (e) {
    ctx.sendToServer({
      type: 'git_status_result',
      conversationId,
      _requestUserId,
      error: e.message,
      isGitRepo: !e.message.includes('not a git repository') && !e.message.includes('ENOENT')
    });
  }
}

export async function handleGitDiff(msg) {
  const { conversationId, filePath, staged, untracked, fullFile, _requestUserId } = msg;
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;

  try {
    // 安全检查：验证 filePath 不包含 shell 注入字符
    if (!filePath || /[`$;|&><!\n\r]/.test(filePath)) {
      ctx.sendToServer({
        type: 'git_diff_result',
        conversationId,
        _requestUserId,
        filePath,
        error: 'Invalid file path'
      });
      return;
    }

    // Get git repo root — git status paths are relative to this, not workDir
    let gitRoot = workDir;
    try {
      const { stdout: rootOut } = await execAsync('git rev-parse --show-toplevel', {
        cwd: workDir,
        timeout: 5000,
        windowsHide: true
      });
      gitRoot = rootOut.trim();
    } catch {}

    if (untracked) {
      // Untracked files: resolve path relative to git root
      const fullPath = resolve(gitRoot, filePath);
      const resolved = resolveAndValidatePath(fullPath, gitRoot);
      const content = await readFile(resolved, 'utf-8');
      ctx.sendToServer({
        type: 'git_diff_result',
        conversationId,
        _requestUserId,
        filePath,
        diff: null,
        newFileContent: content
      });
      return;
    }

    // 使用 -- 分隔选项和路径, execAsync 的参数已被验证无注入字符
    const contextFlag = fullFile ? '-U99999' : '';
    const cmd = staged
      ? `git diff --cached ${contextFlag} -- "${filePath}"`
      : `git diff ${contextFlag} -- "${filePath}"`;

    const { stdout } = await execAsync(cmd, {
      cwd: gitRoot,
      timeout: 15000,
      maxBuffer: 5 * 1024 * 1024,
      windowsHide: true
    });

    // 如果 git diff 返回空，尝试用 --cached 或反之
    if (!stdout.trim() && !staged) {
      const cachedCmd = `git diff --cached ${contextFlag} -- "${filePath}"`;
      const { stdout: cachedOut } = await execAsync(cachedCmd, {
        cwd: gitRoot,
        timeout: 15000,
        maxBuffer: 5 * 1024 * 1024,
        windowsHide: true
      });
      if (cachedOut.trim()) {
        ctx.sendToServer({
          type: 'git_diff_result',
          conversationId,
          _requestUserId,
          filePath,
          staged: true,
          diff: cachedOut
        });
        return;
      }
    } else if (!stdout.trim() && staged) {
      const wtCmd = `git diff ${contextFlag} -- "${filePath}"`;
      const { stdout: wtOut } = await execAsync(wtCmd, {
        cwd: gitRoot,
        timeout: 15000,
        maxBuffer: 5 * 1024 * 1024,
        windowsHide: true
      });
      if (wtOut.trim()) {
        ctx.sendToServer({
          type: 'git_diff_result',
          conversationId,
          _requestUserId,
          filePath,
          staged: false,
          diff: wtOut
        });
        return;
      }
    }

    ctx.sendToServer({
      type: 'git_diff_result',
      conversationId,
      _requestUserId,
      filePath,
      staged: !!staged,
      diff: stdout
    });
  } catch (e) {
    ctx.sendToServer({
      type: 'git_diff_result',
      conversationId,
      _requestUserId,
      filePath,
      error: e.message
    });
  }
}

export async function handleGitAdd(msg) {
  const { conversationId, filePath, addAll, _requestUserId } = msg;
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;

  try {
    const gitRoot = await getGitRoot(workDir);

    if (addAll) {
      await execAsync('git add -A', { cwd: gitRoot, timeout: 10000, windowsHide: true });
    } else {
      if (!validateGitPath(filePath)) {
        ctx.sendToServer({ type: 'git_op_result', conversationId, _requestUserId, operation: 'add', success: false, error: 'Invalid file path' });
        return;
      }
      await execAsync(`git add -- "${filePath}"`, { cwd: gitRoot, timeout: 10000, windowsHide: true });
    }

    ctx.sendToServer({ type: 'git_op_result', conversationId, _requestUserId, operation: 'add', success: true, message: addAll ? 'All files staged' : `Staged: ${filePath}` });
  } catch (e) {
    ctx.sendToServer({ type: 'git_op_result', conversationId, _requestUserId, operation: 'add', success: false, error: e.message });
  }
}

export async function handleGitReset(msg) {
  const { conversationId, filePath, resetAll, _requestUserId } = msg;
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;

  try {
    const gitRoot = await getGitRoot(workDir);

    if (resetAll) {
      await execAsync('git reset HEAD', { cwd: gitRoot, timeout: 10000, windowsHide: true });
    } else {
      if (!validateGitPath(filePath)) {
        ctx.sendToServer({ type: 'git_op_result', conversationId, _requestUserId, operation: 'reset', success: false, error: 'Invalid file path' });
        return;
      }
      await execAsync(`git reset HEAD -- "${filePath}"`, { cwd: gitRoot, timeout: 10000, windowsHide: true });
    }

    ctx.sendToServer({ type: 'git_op_result', conversationId, _requestUserId, operation: 'reset', success: true, message: resetAll ? 'All files unstaged' : `Unstaged: ${filePath}` });
  } catch (e) {
    ctx.sendToServer({ type: 'git_op_result', conversationId, _requestUserId, operation: 'reset', success: false, error: e.message });
  }
}

export async function handleGitRestore(msg) {
  const { conversationId, filePath, _requestUserId } = msg;
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;

  try {
    if (!validateGitPath(filePath)) {
      ctx.sendToServer({ type: 'git_op_result', conversationId, _requestUserId, operation: 'restore', success: false, error: 'Invalid file path' });
      return;
    }

    const gitRoot = await getGitRoot(workDir);
    await execAsync(`git restore -- "${filePath}"`, { cwd: gitRoot, timeout: 10000, windowsHide: true });
    ctx.sendToServer({ type: 'git_op_result', conversationId, _requestUserId, operation: 'restore', success: true, message: `Restored: ${filePath}` });
  } catch (e) {
    ctx.sendToServer({ type: 'git_op_result', conversationId, _requestUserId, operation: 'restore', success: false, error: e.message });
  }
}

export async function handleGitCommit(msg) {
  const { conversationId, commitMessage, _requestUserId } = msg;
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;

  try {
    if (!commitMessage || !commitMessage.trim()) {
      ctx.sendToServer({ type: 'git_op_result', conversationId, _requestUserId, operation: 'commit', success: false, error: 'Commit message is required' });
      return;
    }

    const gitRoot = await getGitRoot(workDir);

    // Write commit message to temp file to avoid shell injection
    const tmpFile = join(gitRoot, '.git', 'WEBCHAT_COMMIT_MSG');
    await writeFile(tmpFile, commitMessage.trim(), 'utf8');

    try {
      const { stdout } = await execAsync(`git commit -F "${tmpFile}"`, {
        cwd: gitRoot, timeout: 30000, windowsHide: true
      });
      ctx.sendToServer({ type: 'git_op_result', conversationId, _requestUserId, operation: 'commit', success: true, message: stdout.trim() });
    } finally {
      // Clean up temp file
      try { await writeFile(tmpFile, '', 'utf8'); } catch {}
    }
  } catch (e) {
    ctx.sendToServer({ type: 'git_op_result', conversationId, _requestUserId, operation: 'commit', success: false, error: e.stderr?.trim() || e.message });
  }
}

export async function handleGitPush(msg) {
  const { conversationId, _requestUserId } = msg;
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;

  try {
    const gitRoot = await getGitRoot(workDir);
    const { stdout, stderr } = await execAsync('git push', {
      cwd: gitRoot, timeout: 60000, windowsHide: true
    });
    ctx.sendToServer({ type: 'git_op_result', conversationId, _requestUserId, operation: 'push', success: true, message: (stdout + '\n' + stderr).trim() || 'Push complete' });
  } catch (e) {
    ctx.sendToServer({ type: 'git_op_result', conversationId, _requestUserId, operation: 'push', success: false, error: e.stderr?.trim() || e.message });
  }
}

export async function handleFileSearch(msg) {
  const { conversationId, query, _requestUserId } = msg;
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;
  const searchRoot = msg.dirPath || workDir;

  try {
    if (!query || query.trim().length === 0) {
      ctx.sendToServer({ type: 'file_search_result', conversationId, _requestUserId, query, results: [] });
      return;
    }

    const resolved = resolve(searchRoot);
    const results = [];
    const MAX_RESULTS = 100;
    const lowerQuery = query.toLowerCase();
    const skipDirs = new Set(['.git', 'node_modules', '__pycache__', '.next', '.nuxt', 'dist', 'build', '.cache', 'bin', 'obj']);

    async function walk(dir, depth) {
      if (depth > 10 || results.length >= MAX_RESULTS) return;
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (results.length >= MAX_RESULTS) return;
          if (entry.name.startsWith('.') && depth > 0) continue;
          if (skipDirs.has(entry.name) && entry.isDirectory()) continue;

          const fullPath = join(dir, entry.name);

          if (entry.name.toLowerCase().includes(lowerQuery)) {
            let size = 0;
            try { const s = await stat(fullPath); size = s.size; } catch {}
            results.push({
              name: entry.name,
              path: relative(resolved, fullPath).replace(/\\/g, '/'),
              fullPath: fullPath.replace(/\\/g, '/'),
              type: entry.isDirectory() ? 'directory' : 'file',
              size
            });
          }

          if (entry.isDirectory()) {
            await walk(fullPath, depth + 1);
          }
        }
      } catch {}
    }

    await walk(resolved, 0);

    ctx.sendToServer({
      type: 'file_search_result',
      conversationId,
      _requestUserId,
      query,
      results,
      truncated: results.length >= MAX_RESULTS
    });
  } catch (e) {
    ctx.sendToServer({ type: 'file_search_result', conversationId, _requestUserId, query, results: [], error: e.message });
  }
}

export async function handleCreateFile(msg) {
  const { conversationId, filePath, isDirectory, _requestUserId } = msg;
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;

  try {
    const resolved = resolveAndValidatePath(filePath, workDir);
    if (isDirectory) {
      await mkdir(resolved, { recursive: true });
    } else {
      // Ensure parent directory exists
      const parentDir = dirname(resolved);
      await mkdir(parentDir, { recursive: true });
      // Create file only if it doesn't exist
      if (existsSync(resolved)) {
        throw new Error('File already exists: ' + resolved);
      }
      await writeFile(resolved, '', 'utf-8');
    }
    ctx.sendToServer({
      type: 'file_op_result', conversationId, _requestUserId,
      operation: 'create', success: true,
      message: (isDirectory ? 'Directory' : 'File') + ' created: ' + basename(resolved)
    });
  } catch (e) {
    ctx.sendToServer({
      type: 'file_op_result', conversationId, _requestUserId,
      operation: 'create', success: false, error: e.message
    });
  }
}

export async function handleDeleteFiles(msg) {
  const { conversationId, paths, _requestUserId } = msg;
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;

  try {
    if (!paths || paths.length === 0) throw new Error('No paths specified');
    const deleted = [];
    const errors = [];

    for (const p of paths) {
      try {
        const resolved = resolveAndValidatePath(p, workDir);
        const s = await stat(resolved);
        if (s.isDirectory()) {
          await rm(resolved, { recursive: true, force: true });
        } else {
          await unlink(resolved);
        }
        deleted.push(basename(resolved));
      } catch (e) {
        errors.push(basename(p) + ': ' + e.message);
      }
    }

    const message = deleted.length > 0
      ? 'Deleted: ' + deleted.join(', ') + (errors.length > 0 ? '; Errors: ' + errors.join(', ') : '')
      : 'Failed: ' + errors.join(', ');

    ctx.sendToServer({
      type: 'file_op_result', conversationId, _requestUserId,
      operation: 'delete', success: deleted.length > 0,
      message, deletedCount: deleted.length, errorCount: errors.length
    });
  } catch (e) {
    ctx.sendToServer({
      type: 'file_op_result', conversationId, _requestUserId,
      operation: 'delete', success: false, error: e.message
    });
  }
}

export async function handleMoveFiles(msg) {
  const { conversationId, paths, destination, newName, _requestUserId } = msg;
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;

  try {
    if (!paths || paths.length === 0) throw new Error('No paths specified');
    if (!destination) throw new Error('No destination specified');

    const destResolved = resolveAndValidatePath(destination, workDir);
    // Ensure destination directory exists
    await mkdir(destResolved, { recursive: true });

    const moved = [];
    const errors = [];

    for (const p of paths) {
      try {
        const srcResolved = resolveAndValidatePath(p, workDir);
        const name = (newName && paths.length === 1) ? newName : basename(srcResolved);
        const destPath = join(destResolved, name);
        if (existsSync(destPath)) {
          throw new Error('Target already exists: ' + name);
        }
        await rename(srcResolved, destPath);
        moved.push(name);
      } catch (e) {
        errors.push(basename(p) + ': ' + e.message);
      }
    }

    const message = moved.length > 0
      ? 'Moved: ' + moved.join(', ') + ' → ' + basename(destResolved) + (errors.length > 0 ? '; Errors: ' + errors.join(', ') : '')
      : 'Failed: ' + errors.join(', ');

    ctx.sendToServer({
      type: 'file_op_result', conversationId, _requestUserId,
      operation: 'move', success: moved.length > 0,
      message, movedCount: moved.length, errorCount: errors.length
    });
  } catch (e) {
    ctx.sendToServer({
      type: 'file_op_result', conversationId, _requestUserId,
      operation: 'move', success: false, error: e.message
    });
  }
}

export async function handleCopyFiles(msg) {
  const { conversationId, paths, destination, _requestUserId } = msg;
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;

  try {
    if (!paths || paths.length === 0) throw new Error('No paths specified');
    if (!destination) throw new Error('No destination specified');

    const destResolved = resolveAndValidatePath(destination, workDir);
    await mkdir(destResolved, { recursive: true });

    const copied = [];
    const errors = [];

    for (const p of paths) {
      try {
        const srcResolved = resolveAndValidatePath(p, workDir);
        const name = basename(srcResolved);
        let destPath = join(destResolved, name);

        // If copying to same directory, generate a unique name
        if (destPath === srcResolved) {
          const ext = extname(name);
          const base = basename(name, ext);
          let counter = 1;
          do {
            destPath = join(destResolved, `${base} (copy${counter > 1 ? ' ' + counter : ''})${ext}`);
            counter++;
          } while (existsSync(destPath));
        }

        const srcStat = await stat(srcResolved);
        if (srcStat.isDirectory()) {
          await cp(srcResolved, destPath, { recursive: true });
        } else {
          await copyFile(srcResolved, destPath);
        }
        copied.push(basename(destPath));
      } catch (e) {
        errors.push(basename(p) + ': ' + e.message);
      }
    }

    const message = copied.length > 0
      ? 'Copied: ' + copied.join(', ') + (errors.length > 0 ? '; Errors: ' + errors.join(', ') : '')
      : 'Failed: ' + errors.join(', ');

    ctx.sendToServer({
      type: 'file_op_result', conversationId, _requestUserId,
      operation: 'copy', success: copied.length > 0,
      message, copiedCount: copied.length, errorCount: errors.length
    });
  } catch (e) {
    ctx.sendToServer({
      type: 'file_op_result', conversationId, _requestUserId,
      operation: 'copy', success: false, error: e.message
    });
  }
}

export async function handleUploadToDir(msg) {
  const { conversationId, files, dirPath, _requestUserId } = msg;
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;

  try {
    if (!files || files.length === 0) throw new Error('No files specified');

    const targetDir = resolveAndValidatePath(dirPath || workDir, workDir);
    await mkdir(targetDir, { recursive: true });

    const saved = [];
    const errors = [];

    for (const file of files) {
      try {
        const dest = join(targetDir, file.name);
        const buffer = Buffer.from(file.data, 'base64');
        await writeFile(dest, buffer);
        saved.push(file.name);
      } catch (e) {
        errors.push(file.name + ': ' + e.message);
      }
    }

    const message = saved.length > 0
      ? 'Uploaded: ' + saved.join(', ') + (errors.length > 0 ? '; Errors: ' + errors.join(', ') : '')
      : 'Failed: ' + errors.join(', ');

    ctx.sendToServer({
      type: 'file_op_result', conversationId, _requestUserId,
      operation: 'upload', success: saved.length > 0,
      message, uploadedCount: saved.length, errorCount: errors.length
    });
  } catch (e) {
    ctx.sendToServer({
      type: 'file_op_result', conversationId, _requestUserId,
      operation: 'upload', success: false, error: e.message
    });
  }
}

// 临时文件目录名 (不易冲突)
const TEMP_UPLOAD_DIR = '.claude-tmp-attachments';

export async function handleTransferFiles(msg) {
  const { conversationId, files, prompt, workDir, claudeSessionId } = msg;
  const { startClaudeQuery } = await import('./claude.js');

  let state = ctx.conversations.get(conversationId);
  const effectiveWorkDir = workDir || state?.workDir || ctx.CONFIG.workDir;

  // 创建临时目录
  const uploadDir = join(effectiveWorkDir, TEMP_UPLOAD_DIR);
  if (!existsSync(uploadDir)) {
    mkdirSync(uploadDir, { recursive: true });
  }

  const savedFiles = [];
  const imageFiles = [];

  for (const file of files) {
    try {
      const timestamp = Date.now();
      const ext = extname(file.name);
      const baseName = basename(file.name, ext);
      const uniqueName = `${baseName}_${timestamp}${ext}`;
      const filePath = join(uploadDir, uniqueName);
      const relativePath = join(TEMP_UPLOAD_DIR, uniqueName);

      const buffer = Buffer.from(file.data, 'base64');
      writeFileSync(filePath, buffer);

      const isImage = file.mimeType.startsWith('image/');
      savedFiles.push({
        name: file.name,
        path: relativePath,
        mimeType: file.mimeType,
        isImage
      });

      if (isImage) {
        imageFiles.push({
          mimeType: file.mimeType,
          data: file.data
        });
      }

      console.log(`Saved file: ${relativePath}`);
    } catch (e) {
      console.error(`Error saving file ${file.name}:`, e.message);
    }
  }

  // 如果没有活跃的查询，启动新的
  if (!state || !state.query || !state.inputStream) {
    const resumeSessionId = claudeSessionId || state?.claudeSessionId || null;
    console.log(`[SDK] Starting Claude for ${conversationId} (files), resume: ${resumeSessionId || 'none'}`);
    state = await startClaudeQuery(conversationId, effectiveWorkDir, resumeSessionId);
  }

  // 构造带附件的消息
  const fileListText = savedFiles.map(f =>
    `- ${f.path} (${f.isImage ? '图片' : f.mimeType})`
  ).join('\n');

  const fullPrompt = `用户上传了以下文件：\n${fileListText}\n\n用户说：${prompt}`;

  // 构造 content 数组
  const content = [];

  for (const img of imageFiles) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mimeType,
        data: img.data
      }
    });
  }

  content.push({
    type: 'text',
    text: fullPrompt
  });

  // 发送用户消息到输入流
  const userMessage = {
    type: 'user',
    message: { role: 'user', content }
  };

  console.log(`[${conversationId}] Sending with ${savedFiles.length} files, ${imageFiles.length} images`);
  state.turnActive = true;
  state.inputStream.enqueue(userMessage);
}
