/**
 * plugins.js — Agent-level selectable Yeaft capabilities.
 *
 * An Agent owns installed tools, skills, and MCP configuration. Missing plugin
 * fields retain historical behavior (everything enabled); explicit arrays are
 * allowlists and may intentionally be empty.
 */

function normalizeNameList(value, field) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`plugins.${field} must be an array`);

  const names = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new Error(`plugins.${field} entries must be non-empty strings`);
    }
    const name = raw.trim();
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/** Normalise persisted Agent plugin config while preserving inheritance. */
export function normalizePluginConfig(value) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('plugins must be an object');
  }

  const out = {};
  for (const field of ['tools', 'skills', 'mcpServers']) {
    const names = normalizeNameList(value[field], field);
    if (names !== undefined) out[field] = names;
  }
  for (const key of Object.keys(value)) {
    if (!['tools', 'skills', 'mcpServers'].includes(key)) {
      throw new Error(`unknown plugins key: ${key}`);
    }
  }
  return out;
}

export function isPluginNameEnabled(plugins, field, name) {
  if (!plugins || !Array.isArray(plugins[field])) return true;
  return plugins[field].includes(name);
}

/**
 * Live delegating view over a SkillManager. It does not mutate the shared
 * manager because Sessions and project runtimes reuse that manager.
 */
export function createPluginSkillManager(skillManager, plugins) {
  if (!skillManager) return null;
  const hasExplicitSkills = Array.isArray(plugins?.skills);
  const allowed = hasExplicitSkills ? new Set(plugins.skills) : null;
  const isAllowed = name => !allowed || allowed.has(name);
  const has = name => isAllowed(name) && !!skillManager.has?.(name);
  const list = (...args) => (skillManager.list?.(...args) || [])
    .filter(skill => isAllowed(skill?.name));
  const get = name => has(name) ? skillManager.get?.(name) || null : null;
  const resolve = name => has(name) ? skillManager.resolve?.(name) || null : null;
  const view = (name, filePath) => has(name) ? skillManager.view?.(name, filePath) || null : null;
  const findRelevant = (...args) => (skillManager.findRelevant?.(...args) || [])
    .filter(skill => isAllowed(skill?.name));
  const getPromptContent = name => has(name) ? skillManager.getPromptContent?.(name) || '' : '';

  return {
    has,
    get,
    resolve,
    list,
    view,
    findRelevant,
    getPromptContent,
    getRelevantPromptContent: (...args) => findRelevant(...args)
      .map(skill => getPromptContent(skill.name))
      .filter(Boolean)
      .join('\n\n'),
    listCategories: () => [...new Set(list().map(skill => skill.category).filter(Boolean))].sort(),
    get size() { return list().length; },
  };
}

/** Build a browser-safe catalog from already discovered Agent assets. */
export function buildPluginCatalog({ toolRegistry, skillManager, mcpConfig, mcpManager } = {}) {
  const tools = typeof toolRegistry?.getAllTools === 'function'
    ? toolRegistry.getAllTools()
      .filter(tool => !tool?.mcpServer)
      .map(tool => ({ id: tool.name, label: tool.name }))
      .sort((a, b) => a.label.localeCompare(b.label))
    : [];

  const skills = typeof skillManager?.list === 'function'
    ? skillManager.list()
      .map(skill => ({
        id: skill.name,
        label: skill.name,
        description: skill.description || '',
        category: skill.category || null,
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
    : [];

  const statusByName = new Map((mcpManager?.status?.() || [])
    .map(status => [status.name, status]));
  const configuredMcpServers = Array.isArray(mcpConfig?.servers) && mcpConfig.servers.length > 0
    ? mcpConfig.servers
    : (mcpManager?.status?.() || []).map(status => ({ name: status.name, command: '' }));
  const mcpServers = configuredMcpServers
    .filter(server => typeof server?.name === 'string' && server.name)
    .map(server => {
      const status = statusByName.get(server.name);
      return {
        id: server.name,
        label: server.name,
        description: server.command || '',
        ready: status ? !!status.ready : null,
        toolCount: status?.toolCount || 0,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  return { tools, skills, mcpServers };
}
