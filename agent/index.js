import 'dotenv/config';
import { platform, homedir } from 'os';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import ctx from './context.js';
import { getConfigPath, loadServiceConfig } from './service.js';
import { loadNodePty } from './terminal.js';
import { connect } from './connection.js';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));

// Load package version
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));
ctx.agentVersion = pkg.version;
ctx.pkgName = pkg.name;

// 配置文件路径（向后兼容：先查当前目录 .claude-agent.json）
const LOCAL_CONFIG_FILE = join(process.cwd(), '.claude-agent.json');

// 加载或创建配置
function loadConfig() {
  const defaults = {
    serverUrl: 'ws://localhost:3456',
    agentName: `Worker-${platform()}-${process.pid}`,
    workDir: process.cwd(),
    reconnectInterval: 5000,
    agentSecret: 'agent-shared-secret'
  };

  // Priority 1: Local .claude-agent.json (backward compat)
  if (existsSync(LOCAL_CONFIG_FILE)) {
    try {
      const saved = JSON.parse(readFileSync(LOCAL_CONFIG_FILE, 'utf-8'));
      const { agentId, ...rest } = saved;
      return { ...defaults, ...rest };
    } catch {
      // fall through
    }
  }

  // Priority 2: Standard config location (~/.config/yeaft-agent/config.json)
  const serviceConfig = loadServiceConfig();
  if (serviceConfig) {
    return { ...defaults, ...serviceConfig };
  }

  return defaults;
}

function saveConfig(config) {
  writeFileSync(LOCAL_CONFIG_FILE, JSON.stringify(config, null, 2));
}

const fileConfig = loadConfig();
const CONFIG = {
  serverUrl: process.env.SERVER_URL || fileConfig.serverUrl,
  agentName: process.env.AGENT_NAME || fileConfig.agentName,
  workDir: process.env.WORK_DIR || fileConfig.workDir,
  reconnectInterval: fileConfig.reconnectInterval,
  agentSecret: process.env.AGENT_SECRET || fileConfig.agentSecret,
  // MCP 白名单：只允许这些 MCP 服务器的工具，其余自动禁用
  // 通过 ALLOWED_MCP_SERVERS 环境变量（逗号分隔）或配置文件 allowedMcpServers 指定
  // 默认只允许 playwright
  disallowedTools: (() => {
    // 解析显式禁用列表
    const raw = process.env.DISALLOWED_TOOLS || fileConfig.disallowedTools || '';
    const explicit = raw === 'none' ? [] : raw.split(',').map(s => s.trim()).filter(Boolean);

    // 解析 MCP 白名单
    const allowedRaw = process.env.ALLOWED_MCP_SERVERS || fileConfig.allowedMcpServers || 'playwright';
    const allowedMcpServers = allowedRaw.split(',').map(s => s.trim()).filter(Boolean);

    // 读取 ~/.claude.json 中所有配置的 MCP 服务器名
    const claudeConfigPath = join(homedir(), '.claude.json');
    const mcpDisallowed = [];
    try {
      if (existsSync(claudeConfigPath)) {
        const claudeConfig = JSON.parse(readFileSync(claudeConfigPath, 'utf-8'));
        const allMcpNames = new Set();
        // 收集所有项目中配置的 MCP 服务器名
        for (const [, projCfg] of Object.entries(claudeConfig.projects || {})) {
          for (const name of Object.keys(projCfg.mcpServers || {})) {
            allMcpNames.add(name);
          }
        }
        // 顶层 mcpServers
        for (const name of Object.keys(claudeConfig.mcpServers || {})) {
          allMcpNames.add(name);
        }
        // 不在白名单中的 MCP 服务器 → 禁用
        for (const name of allMcpNames) {
          if (!allowedMcpServers.includes(name)) {
            mcpDisallowed.push(`mcp__${name}`);
          }
        }
        if (mcpDisallowed.length > 0) {
          console.log(`[MCP] Allowed: ${allowedMcpServers.join(', ')}`);
          console.log(`[MCP] Disallowed: ${mcpDisallowed.join(', ')}`);
        }
      }
    } catch (e) {
      console.warn('[MCP] Failed to read ~/.claude.json:', e.message);
    }

    return [...explicit, ...mcpDisallowed];
  })()
};

// 初始化共享上下文
ctx.CONFIG = CONFIG;
ctx.saveConfig = saveConfig;

// Agent capabilities（启动时自动检测）
async function detectCapabilities() {
  const capabilities = ['background_tasks', 'file_editor'];
  const pty = await loadNodePty();
  if (pty) capabilities.push('terminal');

  // Crew mode requires Claude CLI
  try {
    const { getDefaultClaudeCodePath } = await import('./sdk/utils.js');
    const claudePath = getDefaultClaudeCodePath();
    if (claudePath) capabilities.push('crew');
  } catch {}

  console.log(`[Capabilities] Detected: ${capabilities.join(', ')}`);
  return capabilities;
}

// 确保依赖已安装（特别是 optionalDependencies 如 node-pty）
async function ensureDependencies() {
  const agentDir = new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
  const nodeModulesPath = join(agentDir, 'node_modules');

  // 检查 node_modules 是否存在
  if (!existsSync(nodeModulesPath)) {
    console.log('[Startup] node_modules not found, running npm install...');
    try {
      await execAsync('npm install', { cwd: agentDir, timeout: 120000 });
      console.log('[Startup] npm install completed');
    } catch (e) {
      console.warn('[Startup] npm install failed:', e.message);
    }
    return;
  }

  // 检查 node-pty 是否可用（optionalDependency，可能需要编译）
  try {
    await import('node-pty');
  } catch (e) {
    console.log('[Startup] node-pty not available, attempting install...');
    try {
      await execAsync('npm install node-pty', { cwd: agentDir, timeout: 120000 });
      console.log('[Startup] node-pty installed successfully');
    } catch (installErr) {
      console.warn('[Startup] node-pty install failed (terminal will be unavailable):', installErr.message);
    }
  }
}

// 优雅退出
function cleanup() {
  // 清理所有终端
  for (const [, term] of ctx.terminals) {
    if (term.pty) {
      try { term.pty.kill(); } catch {}
    }
    if (term.timer) clearTimeout(term.timer);
  }
  ctx.terminals.clear();

  for (const [, state] of ctx.conversations) {
    if (state.abortController) {
      state.abortController.abort();
    }
    if (state.inputStream) {
      state.inputStream.done();
    }
  }
  ctx.conversations.clear();
  if (ctx.ws) ctx.ws.close();
}

process.on('SIGINT', () => {
  console.log('Shutting down...');
  cleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Shutting down...');
  cleanup();
  process.exit(0);
});

// 启动 - 先确保依赖，再检测能力，再连接
(async () => {
  await ensureDependencies();
  ctx.agentCapabilities = await detectCapabilities();
  connect();
})();
