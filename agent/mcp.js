import { homedir } from 'os';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import ctx from './context.js';

/**
 * 读取 ~/.claude.json 中的 MCP servers 列表，
 * 并根据 allowedMcpServers 白名单计算 disallowedTools。
 * 返回 mcpServers 列表并同时存入 ctx.mcpServers。
 */
export function loadMcpServers() {
  const claudeConfigPath = join(homedir(), '.claude.json');
  const allMcpNames = new Set();
  try {
    if (existsSync(claudeConfigPath)) {
      const claudeConfig = JSON.parse(readFileSync(claudeConfigPath, 'utf-8'));
      for (const [, projCfg] of Object.entries(claudeConfig.projects || {})) {
        for (const name of Object.keys(projCfg.mcpServers || {})) {
          allMcpNames.add(name);
        }
      }
      for (const name of Object.keys(claudeConfig.mcpServers || {})) {
        allMcpNames.add(name);
      }
    }
  } catch (e) {
    console.warn('[MCP] Failed to read ~/.claude.json:', e.message);
  }

  const allowed = ctx.CONFIG.allowedMcpServers;
  const mcpServers = [];
  for (const name of allMcpNames) {
    mcpServers.push({
      name,
      enabled: allowed.includes(name),
      source: name === 'playwright' ? 'Built-in' : 'MCP'
    });
  }

  // 重新计算 disallowedTools
  recalcDisallowedTools(mcpServers);
  ctx.mcpServers = mcpServers;

  if (mcpServers.length > 0) {
    const enabledNames = mcpServers.filter(s => s.enabled).map(s => s.name);
    console.log(`[MCP] Enabled: ${enabledNames.join(', ') || 'none'}`);
    const mcpDisallowed = mcpServers.filter(s => !s.enabled).map(s => s.name);
    if (mcpDisallowed.length > 0) {
      console.log(`[MCP] Disabled: ${mcpDisallowed.join(', ')}`);
    }
  }

  return mcpServers;
}

/**
 * 更新 MCP servers 的 enabled 状态（从前端 toggle 触发）
 * @param {Object<string, boolean>} config - { serverName: enabled }
 */
export function updateMcpConfig(config) {
  for (const server of ctx.mcpServers) {
    if (config[server.name] !== undefined) {
      server.enabled = config[server.name];
    }
  }

  // 更新白名单
  ctx.CONFIG.allowedMcpServers = ctx.mcpServers
    .filter(s => s.enabled)
    .map(s => s.name);

  recalcDisallowedTools(ctx.mcpServers);

  console.log(`[MCP] Config updated. Allowed: ${ctx.CONFIG.allowedMcpServers.join(', ') || 'none'}`);
  return ctx.mcpServers;
}

function recalcDisallowedTools(mcpServers) {
  const mcpDisallowed = mcpServers
    .filter(s => !s.enabled)
    .map(s => `mcp__${s.name}`);
  ctx.CONFIG.disallowedTools = [...ctx.CONFIG.explicitDisallowedTools, ...mcpDisallowed];
}
