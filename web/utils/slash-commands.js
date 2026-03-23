// System skills with descriptions (shared between ChatInput and crewInput)
export const SYSTEM_SKILLS = {
  '/compact': 'Compact context',
  '/context': 'Show context usage',
  '/cost': 'Show token costs',
  '/init': 'Reinitialize session',
  '/doctor': 'Check health status',
  '/memory': 'View/edit memory',
  '/model': 'View/switch model',
  '/review': 'Code review',
  '/mcp': 'MCP server status',
  '/skills': 'List available skills',
  '/btw': 'Side question (no history)'
};

export const SYSTEM_SKILL_NAMES = new Set(Object.keys(SYSTEM_SKILLS));

// Default slash commands list (used before Claude SDK returns dynamic list)
export const DEFAULT_SLASH_COMMANDS = Object.keys(SYSTEM_SKILLS);
