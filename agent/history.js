import { homedir } from 'os';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import ctx from './context.js';

// Claude 项目目录
export function getClaudeProjectsDir() {
  return join(homedir(), '.claude', 'projects');
}

// 将路径转换为 Claude 项目文件夹名
export function pathToProjectFolder(workDir) {
  return workDir
    .replace(/:/g, '-')
    .replace(/[\\\/]/g, '-');
}

// 从 session 文件中提取原始工作目录路径
// Claude session jsonl 文件的每条消息都包含 cwd 字段
export function extractWorkDirFromSessionFile(sessionFilePath) {
  try {
    const content = readFileSync(sessionFilePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    for (const line of lines.slice(0, 5)) { // 只检查前几行
      try {
        const data = JSON.parse(line);
        // 每条消息都有 cwd 字段
        if (data.cwd) {
          return data.cwd.replace(/\\/g, '/');
        }
      } catch {}
    }
  } catch {}
  return null;
}

// 从项目文件夹中获取原始工作目录路径
// 优先从 session 文件读取，失败则用简单转换
export function getWorkDirFromProjectFolder(projectFolderPath, folderName) {
  // 尝试从第一个 session 文件读取真实路径
  try {
    const files = readdirSync(projectFolderPath);
    for (const file of files) {
      if (file.endsWith('.jsonl')) {
        const workDir = extractWorkDirFromSessionFile(join(projectFolderPath, file));
        if (workDir) {
          return workDir;
        }
      }
    }
  } catch {}

  // 回退：简单转换（可能不准确，但总比没有好）
  if (/^[A-Za-z]--/.test(folderName)) {
    return folderName.replace(/^([A-Za-z])--/, '$1:/').replace(/-/g, '/');
  }
  if (folderName.startsWith('-')) {
    return '/' + folderName.substring(1).replace(/-/g, '/');
  }
  return folderName.replace(/-/g, '/');
}

// 获取指定目录的历史会话列表
export async function getHistorySessions(workDir) {
  const projectsDir = getClaudeProjectsDir();
  const projectFolder = pathToProjectFolder(workDir);
  const projectPath = join(projectsDir, projectFolder);

  console.log(`Looking for sessions in: ${projectPath}`);

  if (!existsSync(projectPath)) {
    console.log(`Project folder not found: ${projectPath}`);
    return [];
  }

  const sessions = [];
  const files = readdirSync(projectPath);

  for (const file of files) {
    if (file.endsWith('.jsonl') && file !== 'sessions-index.json') {
      const sessionId = file.replace('.jsonl', '');
      const filePath = join(projectPath, file);
      const stats = statSync(filePath);

      let title = '';
      let firstMessage = '';
      let hasUserMessage = false;

      try {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());

        for (const line of lines.slice(0, 30)) {
          try {
            const data = JSON.parse(line);
            if (data.type === 'user' && data.message?.content) {
              const text = typeof data.message.content === 'string'
                ? data.message.content
                : data.message.content[0]?.text || '';
              if (text.trim()) {
                firstMessage = text.substring(0, 100);
                title = text.substring(0, 100);
                hasUserMessage = true;
                break;
              }
            }
          } catch {}
        }
      } catch (e) {
        console.error(`Error reading session file: ${e.message}`);
      }

      // 只添加有实际用户消息的会话，过滤掉空会话
      if (hasUserMessage) {
        sessions.push({
          sessionId,
          workDir,
          title: title || sessionId.slice(0, 8),
          preview: firstMessage,
          lastModified: stats.mtime.getTime(),
          size: stats.size
        });
      }
    }
  }

  sessions.sort((a, b) => b.lastModified - a.lastModified);
  return sessions;
}

// 读取 session 文件中的历史消息
export function loadSessionHistory(workDir, claudeSessionId, limit = 500) {
  const projectsDir = getClaudeProjectsDir();
  const projectFolder = pathToProjectFolder(workDir);
  const sessionFile = join(projectsDir, projectFolder, `${claudeSessionId}.jsonl`);

  console.log(`Loading session history from: ${sessionFile}`);

  if (!existsSync(sessionFile)) {
    console.log(`Session file not found: ${sessionFile}`);
    return [];
  }

  const messages = [];
  try {
    const content = readFileSync(sessionFile, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        if (data.type === 'user' || data.type === 'assistant') {
          messages.push(data);
        }
      } catch {}
    }
  } catch (e) {
    console.error(`Error reading session file: ${e.message}`);
  }

  // ★ Phase 6: 限制返回数量（取最后 N 条）
  if (limit && messages.length > limit) {
    return messages.slice(-limit);
  }

  return messages;
}

export async function handleListHistorySessions(msg) {
  const { workDir, requestId, _requestClientId } = msg;
  const effectiveWorkDir = workDir || ctx.CONFIG.workDir;

  console.log(`Listing history sessions for: ${effectiveWorkDir}`);

  try {
    const sessions = await getHistorySessions(effectiveWorkDir);
    ctx.sendToServer({
      type: 'history_sessions_list',
      requestId,
      _requestClientId,
      workDir: effectiveWorkDir,
      sessions
    });
  } catch (e) {
    console.error('Error listing history sessions:', e);
    ctx.sendToServer({
      type: 'history_sessions_list',
      requestId,
      _requestClientId,
      workDir: effectiveWorkDir,
      sessions: [],
      error: e.message
    });
  }
}

// 列出 Claude projects 目录下的所有 folder (工作目录)
export async function handleListFolders(msg) {
  const { requestId, _requestClientId } = msg;
  const projectsDir = getClaudeProjectsDir();

  console.log(`Listing folders from: ${projectsDir}`);

  try {
    const folders = [];

    if (existsSync(projectsDir)) {
      const entries = readdirSync(projectsDir);

      for (const entry of entries) {
        const entryPath = join(projectsDir, entry);
        const stats = statSync(entryPath);

        if (stats.isDirectory()) {
          // 从 session 文件读取真实的工作目录路径
          const originalPath = getWorkDirFromProjectFolder(entryPath, entry);

          // 获取该目录下的会话数量（只计算有实际用户消息的会话）
          let sessionCount = 0;
          let lastModified = stats.mtime.getTime();

          try {
            const files = readdirSync(entryPath);

            for (const file of files) {
              if (file.endsWith('.jsonl')) {
                const filePath = join(entryPath, file);
                const fileStats = statSync(filePath);
                if (fileStats.mtime.getTime() > lastModified) {
                  lastModified = fileStats.mtime.getTime();
                }

                // 检查文件是否包含用户消息（与 getHistorySessions 保持一致）
                try {
                  const content = readFileSync(filePath, 'utf-8');
                  const lines = content.split('\n').filter(l => l.trim()).slice(0, 30);
                  for (const line of lines) {
                    try {
                      const data = JSON.parse(line);
                      if (data.type === 'user' && data.message?.content) {
                        const text = typeof data.message.content === 'string'
                          ? data.message.content
                          : data.message.content[0]?.text || '';
                        if (text.trim()) {
                          sessionCount++;
                          break;
                        }
                      }
                    } catch {}
                  }
                } catch {}
              }
            }
          } catch {}

          folders.push({
            name: entry,
            path: originalPath,
            sessionCount,
            lastModified
          });
        }
      }
    }

    folders.sort((a, b) => b.lastModified - a.lastModified);

    console.log(`Found ${folders.length} folders, sending response...`);
    ctx.sendToServer({
      type: 'folders_list',
      requestId,
      _requestClientId,
      folders
    });
    console.log(`folders_list sent with ${folders.length} folders`);
  } catch (e) {
    console.error('Error listing folders:', e);
    ctx.sendToServer({
      type: 'folders_list',
      requestId,
      _requestClientId,
      folders: [],
      error: e.message
    });
  }
}
