// Plugin protocol support is omission-compatible: old Agents that never
// advertised capability metadata retain the legacy request path. Explicit
// metadata without this token means the Agent cannot handle Plugin requests.
export const YEAFT_PLUGINS_CAPABILITY = 'yeaft_plugins';

export function agentSupportsYeaftPlugins(agent) {
  if (agent?.capabilityMetadataProvided !== true) return true;
  return Array.isArray(agent.capabilities)
    && agent.capabilities.includes(YEAFT_PLUGINS_CAPABILITY);
}
